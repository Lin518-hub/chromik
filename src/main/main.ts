import { app, BrowserWindow, crashReporter, dialog, ipcMain, net, protocol, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { z } from 'zod';
import { createDefaultRecipe, createRecipeForFilmType, rectToQuad } from '../shared/defaults';
import type {
  AssetExif, AssetKind, AssetSummary, BackupInfo, ContactSheetConfig, EditRecipe, ExportConfig, ExportProgress,
  FrameRegionInput, FrameSummary, HdrMergeResult, ImportResult, MasterSourceDescriptor, PasteScope, Quad, RawDecodedImage, RollCalibration, RollInput, SprocketInfo,
} from '../shared/types';
import { applyGeometry, quadToCrop } from '../core/geometry';
import { linear16ToSrgb8, RAW_DISPLAY_VERSION, srgb16ToLinear16, srgb8ToLinear16 } from '../core/raw-display';
import { processPixelSource } from '../core/reconstruct';
import { quantizeUint16To8 } from '../core/quantize';
import { decodeDevelopProxy, describeDevelopProxy, developProxyPayloadChecksum, downscaleLinearProxy16, DEVELOP_PROXY_MIME, DEVELOP_PROXY_VERSION, encodeDevelopProxy } from '../core/develop-proxy';
import { mergeExposures, mergeExposures16, type Hdr16Source, type HdrSource } from '../core/hdr-merge';
import { detectSprocketHoles, type SprocketRegion } from '../core/density';
import { parseCubeLut, serializeCubeLut, type CubeLut } from '../core/cube';
import { isHeicPath } from '../adapters/heic';
import { decodeTiff16, encodeTiff16 } from '../adapters/tiff16';
import { recognizeFilmEdge } from './film-edge';
import { classifyFilmPixels } from './film-type';
import { Storage } from './storage';
import { fingerprintSize, fingerprintSource, isStrongSourceFingerprint } from './source-fingerprint';
import { BackupService } from './backup-service';
import { paginateContactSheet } from '../core/contact-sheet-layout';
import { summarizeTimings } from '../core/local-metrics';
import { atomicWriteFile } from './atomic-write';
import { runQaFaultInjection } from './qa-fault-inject';
import { runQaAutomation } from './qa-automation';
import { evaluateUpdate, readUpdateManifest, updateManifestCandidates } from './update-check';

if (process.env.FILMLAB_TEST_USER_DATA) app.setPath('userData', process.env.FILMLAB_TEST_USER_DATA);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// BUG-015：主进程兜底。worker 池有自愈逻辑，但主进程此前没有任何
// uncaughtException/unhandledRejection 处理器——`ipcMain.on` 处理器或第三方
// 原生模块的一次同步异常就可能直接杀死整个应用。这里只记录、不退出，
// 让渲染层有机会继续工作（持久化错误已有 recovery_log 等通道兜底）。
process.on('uncaughtException', (error) => {
  console.error('Chromik: 主进程未捕获异常', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('Chromik: 主进程未处理拒绝', reason);
});

const rgbSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const correctionRgbSchema = z.tuple([
  z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2),
]);
const matrix9Schema = z.tuple([
  z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2), z.number().finite().min(-2).max(2),
]);
const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const curvePointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const curveSchema = z.array(curvePointSchema).min(2).max(16).refine(
  (points) => points[0]?.x === 0 && points.at(-1)?.x === 1 && points.every((point, index) => index === 0 || point.x > points[index - 1].x),
  '曲线锚点必须从 0 到 1 且按横坐标递增',
);
const recipeSchema = z.object({
  schemaVersion: z.union([z.literal(5), z.literal(6)]),
  algorithmVersion: z.union([z.literal('chromik-5'), z.literal('chromik-6')]),
  crop: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
  geometry: z.object({
    corners: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]),
    rotation90: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    straighten: z.number().min(-45).max(45),
    lensDistortion: z.number().min(-100).max(100),
    flipX: z.boolean(),
    flipY: z.boolean(),
  }),
  baseRgb: rgbSchema.optional(),
  baseRgbLinear: z.tuple([
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
  ]).optional(),
  density: z.object({
    enabled: z.boolean(),
    low: rgbSchema,
    high: rgbSchema,
    mode: z.enum(['display_reference', 'cineon']),
    profileId: z.enum(['camera_srgb', 'scanner_srgb', 'linear_raw']),
    filmProfileId: z.enum(['generic_color_negative', 'generic_bw_negative']),
    filmStockProfileId: z.string().min(1).max(64).optional(),
    /** BUG-007：COL-11 配置版本必须随配方持久化；缺失会被 zod strip 掉。 */
    filmStockProfileVersion: z.string().min(1).max(32).optional(),
    inputTransfer: z.enum(['srgb', 'linear']),
    separation: z.number().min(0).max(100),
    separationMatrix: matrix9Schema.optional(),
    neutralProtection: z.number().min(0).max(100),
    crossoverStrength: z.number().min(0).max(2),
    shadowCorrection: correctionRgbSchema,
    midCorrection: correctionRgbSchema,
    highlightCorrection: correctionRgbSchema,
    lightSourceRgb: rgbSchema.optional(),
  }),
  grade: z.object({
    exposureEv: z.number().min(-5).max(5),
    temperature: z.number().min(-100).max(100),
    tint: z.number().min(-100).max(100),
    contrast: z.number().min(-100).max(100),
    gamma: z.number().min(0.2).max(3),
    saturation: z.number().min(-100).max(100),
    vibrance: z.number().min(-100).max(100),
    highlights: z.number().min(-100).max(100),
    shadows: z.number().min(-100).max(100),
    highlightRolloff: z.number().min(0).max(100),
    fade: z.number().min(0).max(100),
    printerLights: rgbSchema,
    blackAndWhite: z.boolean(),
    look: z.enum(['neutral', 'warm_print', 'classic_color', 'cool_slide', 'silver_bw']),
    lookStrength: z.number().min(0).max(100),
    vignette: z.object({
      strength: z.number().min(-100).max(100),
      midpoint: z.number().min(0).max(100),
      roundness: z.number().min(-100).max(100),
    }),
    cmy: z.object({
      cyan: z.number().min(-100).max(100),
      magenta: z.number().min(-100).max(100),
      yellow: z.number().min(-100).max(100),
      density: z.number().min(-100).max(100),
    }),
    lutId: z.string().max(128).optional(),
    curves: z.object({ rgb: curveSchema, red: curveSchema, green: curveSchema, blue: curveSchema }),
  }),
  spots: z.array(z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    r: z.number().min(0.001).max(0.5),
  })).max(200).optional(),
  updatedAt: z.number(),
});
const calibrationSchema = z.object({
  baseRgb: rgbSchema.optional(),
  baseRgbLinear: z.tuple([
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
  ]).optional(),
  density: z.object({
    enabled: z.boolean(),
    low: rgbSchema,
    high: rgbSchema,
    mode: z.enum(['display_reference', 'cineon']),
    profileId: z.enum(['camera_srgb', 'scanner_srgb', 'linear_raw']),
    filmProfileId: z.enum(['generic_color_negative', 'generic_bw_negative']),
    filmStockProfileId: z.string().min(1).max(64).optional(),
    /** BUG-007：与 recipeSchema 一致，避免整卷校准保存时剥离配置版本。 */
    filmStockProfileVersion: z.string().min(1).max(32).optional(),
    inputTransfer: z.enum(['srgb', 'linear']),
    separation: z.number().min(0).max(100),
    separationMatrix: matrix9Schema.optional(),
    neutralProtection: z.number().min(0).max(100),
    crossoverStrength: z.number().min(0).max(2),
    shadowCorrection: correctionRgbSchema,
    midCorrection: correctionRgbSchema,
    highlightCorrection: correctionRgbSchema,
    lightSourceRgb: rgbSchema.optional(),
  }),
  updatedAt: z.number().finite(),
});
const exportConfigSchema = z.object({
  directory: z.string().min(1),
  format: z.enum(['jpeg', 'png', 'tiff', 'dng']),
  quality: z.number().int().min(40).max(100),
  suffix: z.string().max(32).regex(/^[\w\-\u4e00-\u9fff]*$/u),
  bitDepth: z.union([z.literal(8), z.literal(16)]),
  resizeMode: z.enum(['original', 'dimensions']),
  width: z.number().int().min(1).max(100000),
  height: z.number().int().min(1).max(100000),
  lockAspect: z.boolean(),
  allowUpscale: z.boolean(),
  sharpening: z.number().min(0).max(100),
  colorSpace: z.enum(['srgb', 'p3']),
  conflictPolicy: z.enum(['rename', 'skip']),
  borderPadding: z.number().int().min(0).max(1000),
});
const filmTypeSchema = z.enum(['color_negative', 'color_slide', 'bw_negative', 'bw_slide', 'unknown']);
const assetKindSchema = z.enum(['strip', 'contact', 'single', 'unknown']);
const rollInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  filmType: filmTypeSchema,
  camera: z.string().trim().max(100).optional(),
  lens: z.string().trim().max(120).optional(),
  filmStock: z.string().trim().max(100).optional(),
  iso: z.number().int().min(1).max(12800).optional(),
  development: z.string().trim().max(160).optional(),
  shotDate: z.string().trim().max(32).optional(),
  notes: z.string().trim().max(2000).optional(),
});
const frameRegionSchema = z.object({
  frameId: z.string().uuid().optional(),
  corners: z.tuple([pointSchema, pointSchema, pointSchema, pointSchema]),
});
const contactSheetConfigSchema = z.object({
  style: z.enum(['classic', 'darkroom', 'minimal']),
  resolution: z.enum(['preview', 'standard', 'best']).default('best'),
  columns: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  showFileName: z.boolean(),
  showMetadata: z.boolean(),
  title: z.string().trim().max(120),
  format: z.enum(['jpeg', 'png']),
});
const rawDecodedMetadataSchema = z.object({
  width: z.number().int().min(2).max(100_000),
  height: z.number().int().min(2).max(100_000),
  channels: z.union([z.literal(3), z.literal(4)]),
  bits: z.union([z.literal(8), z.literal(16)]),
  transfer: z.enum(['srgb', 'linear']),
  cameraMake: z.string().max(200).optional(),
  cameraModel: z.string().max(200).optional(),
  lens: z.string().max(300).optional(),
  iso: z.number().int().min(1).max(6_400_000).optional(),
  shutter: z.string().max(64).optional(),
  aperture: z.string().max(64).optional(),
  focalLength: z.string().max(64).optional(),
  shotAt: z.string().datetime().optional(),
});

let mainWindow: BrowserWindow | null = null;
let storage: Storage;
const allowedExportDirectories = new Set<string>();
const exportJobs = new Map<string, { cancelled: boolean }>();
const contactSheetJobs = new Map<string, {
  worker?: Worker;
  cancelled: boolean;
  settled: boolean;
  total: number;
  outputDirectory: string;
  outputPaths: string[];
}>();
const allowedRawImports = new Set<string>();
const lutCache = new Map<string, CubeLut>();
const developProxyJobs = new Map<string, Promise<string>>();
const validatedDevelopProxies = new Map<string, string>();
const rawImportReadTokens = new Map<string, { sourcePath: string; expiresAt: number }>();
// A retry never grants access to a new path: it can only re-arm a RAW that the
// user selected in the native dialog during the preceding ten minutes.
const recentRawRetryPaths = new Map<string, { rollId: string; expiresAt: number }>();
const rawCommitTokens = new Map<string, {
  rollId: string;
  sourcePath: string;
  metadata: z.infer<typeof rawDecodedMetadataSchema>;
  expiresAt: number;
}>();
const proofPreviewJobs = new Map<string, Promise<string>>();
const proofPreviewReadTokens = new Map<string, { filePath: string; expiresAt: number }>();
const pendingDuplicateImports = new Map<string, {
  rollId: string;
  filePaths: string[];
  duplicatePaths: Set<string>;
  expiresAt: number;
}>();
const localMainTimings = new Map<string, number[]>();

/** Development-only, local and path-free. No image pixels or file names leave the process. */
function recordMainTiming(metric: string, durationMs: number, gauges?: Record<string, number>): void {
  if (app.isPackaged || !Number.isFinite(durationMs)) return;
  const values = [...(localMainTimings.get(metric) ?? []), durationMs].slice(-120);
  localMainTimings.set(metric, values);
  if (values.length % 20 !== 0) return;
  const summary = summarizeTimings(values)!;
  const safeGauges = Object.entries(gauges ?? {}).filter(([, value]) => Number.isFinite(value));
  console.info(`CHROMIK_PERF ${JSON.stringify({ metric, n: summary.count, p50Ms: Math.round(summary.p50), p95Ms: Math.round(summary.p95), ...Object.fromEntries(safeGauges) })}`);
}
const rawDisplayMigrationQueue: string[] = [];
const rawDisplayMigrationQueued = new Set<string>();
let rawDisplayMigrationRunning = false;
const RAW_EXTENSIONS = new Set(['.3fr', '.arw', '.cr2', '.cr3', '.dcr', '.dng', '.erf', '.fff', '.kdc', '.mef', '.mos', '.mrw', '.nef', '.nrw', '.orf', '.pef', '.raf', '.raw', '.rw2', '.sr2', '.srf', '.x3f']);
const MAX_RAW_IMPORT_BYTES = 512 * 1024 * 1024;

function isRawPath(filePath: string): boolean {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function rawCachePath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'raw', `${assetId}.tiff`);
}

function rawCacheMetaPath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'raw', `${assetId}.json`);
}

function developProxyPath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'develop', `${assetId}-v${DEVELOP_PROXY_VERSION}.chpx`);
}

function frameDevelopProxyPath(frameId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'develop', `frame-${frameId}-v${DEVELOP_PROXY_VERSION}.chpx`);
}

function proofPreviewDirectory(): string {
  return path.join(app.getPath('userData'), 'cache', 'proof');
}

function rawAnalysisPreviewPath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'assets', `${assetId}-analysis.jpg`);
}

function rawDisplayMarkerPath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'assets', `${assetId}-display-v${RAW_DISPLAY_VERSION}`);
}

function mergedCachePath(assetId: string): string {
  return path.join(app.getPath('userData'), 'cache', 'merged', `${assetId}.tiff`);
}

function lutDirectory(): string {
  return path.join(app.getPath('userData'), 'luts');
}

async function loadLutById(id: string): Promise<CubeLut> {
  const safeId = z.string().uuid().parse(id);
  const cached = lutCache.get(safeId);
  if (cached) return cached;
  const filePath = path.join(lutDirectory(), `${safeId}.cube`);
  const text = await fs.readFile(filePath, 'utf8');
  const lut = parseCubeLut(text);
  lutCache.set(safeId, lut);
  return lut;
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  const senderFrame = event.senderFrame;
  if (!mainWindow || !senderFrame || event.sender !== mainWindow.webContents || senderFrame !== senderFrame.top) {
    throw new Error('拒绝来自非主界面的请求');
  }
}

function orientedDimensions(metadata: sharp.Metadata): { width: number; height: number } {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

interface HeicWorkerResult {
  ok: boolean;
  width?: number;
  height?: number;
  data?: ArrayBuffer;
  byteOffset?: number;
  byteLength?: number;
  message?: string;
}

type RawCacheStage = 'validated' | 'proxy' | 'analysis' | 'display' | 'encoded' | 'written' | 'recognition' | 'database';

type RawCacheWorkerMessage =
  | { type: 'progress'; stage: RawCacheStage; elapsedMs: number }
  | { type: 'result'; ok: boolean; message?: string };

interface BasicWorkerResult {
  ok: boolean;
  message?: string;
}

const HEIC_DECODE_TIMEOUT_MS = 60_000;

function decodeHeicInWorker(filePath: string): Promise<{ width: number; height: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, '..', 'workers', 'heic.worker.js');
    const worker = new Worker(workerPath, { workerData: filePath });
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      void worker.terminate();
      callback();
    };
    timeoutHandle = setTimeout(() => settle(() => reject(new Error('HEIC 解码超时（60 秒），文件可能已损坏'))), HEIC_DECODE_TIMEOUT_MS);
    worker.once('message', (result: HeicWorkerResult) => {
      settle(() => {
        if (!result.ok || !result.data || !result.width || !result.height) {
          reject(new Error(result.message ?? 'HEIC 解码失败'));
          return;
        }
        // The worker transferred the whole underlying buffer; slice a
        // zero-copy view at the reported offset instead of copying again.
        resolve({
          width: result.width,
          height: result.height,
          data: Buffer.from(result.data, result.byteOffset ?? 0, result.byteLength ?? result.data.byteLength),
        });
      });
    });
    worker.once('error', (error) => settle(() => reject(error)));
    worker.once('exit', (code) => settle(() => reject(new Error(`HEIC 解码线程异常退出（${code}）`))));
  });
}

interface ExifIfdEntry {
  type: number;
  count: number;
  valueOffset: number;
}

function normalizeExifDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (match) {
    // EXIF DateTimeOriginal records the photographer's local time without an
    // offset. Mark it as the camera's local time so a downstream
    // `new Date(...)` round-trip does not silently shift it by the host's
    // UTC offset.
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  }
  return value;
}

function formatShutter(num: number, den: number): string | undefined {
  if (!den || !num) return undefined;
  const value = num / den;
  if (value < 1) {
    const inverted = den / num;
    if (Number.isFinite(inverted) && Math.abs(inverted - Math.round(inverted)) < 1e-9) return `1/${Math.round(inverted)}`;
    return `${Number(value.toFixed(3))}`;
  }
  return `${Number(value.toFixed(2))}`;
}

function formatAperture(num: number, den: number): string | undefined {
  if (!den) return undefined;
  const value = num / den;
  return `f/${Number.isInteger(value) ? String(value) : value.toFixed(1)}`;
}

function formatFocalLength(num: number, den: number): string | undefined {
  if (!den) return undefined;
  const rounded = Math.round((num / den) * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}mm`;
}

/**
 * Best-effort EXIF extraction from sharp's raw EXIF buffer (a minimal TIFF
 * parser for the few tags the film strip cares about). sharp exposes
 * `metadata().exif` as a raw Buffer, not the parsed `{ IFD0, EXIF, GPS }`
 * structure, so this decodes IFD0 and the EXIF sub-IFD directly.
 */
function extractAssetExif(metadata: sharp.Metadata): AssetExif | undefined {
  const raw = metadata.exif;
  if (!raw || raw.length < 8) return undefined;
  const result: AssetExif = {};
  try {
    let base = 0;
    if (raw.length >= 6 && raw.toString('ascii', 0, 6) === 'Exif\u0000\u0000') base = 6;
    if (base + 8 > raw.length) return undefined;
    const order = raw.toString('ascii', base, base + 2);
    const little = order === 'II';
    if (!little && order !== 'MM') return undefined;
    const u16 = (offset: number) => (little ? raw.readUInt16LE(offset) : raw.readUInt16BE(offset));
    const u32 = (offset: number) => (little ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset));
    if (u16(base + 2) !== 42) return undefined;

    const readIfd = (offset: number): Map<number, ExifIfdEntry> => {
      const entries = new Map<number, ExifIfdEntry>();
      if (offset + 2 > raw.length) return entries;
      const count = u16(offset);
      for (let index = 0; index < count; index += 1) {
        const entry = offset + 2 + index * 12;
        if (entry + 12 > raw.length) break;
        entries.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), valueOffset: entry + 8 });
      }
      return entries;
    };

    const readString = (entry: ExifIfdEntry): string | undefined => {
      if (entry.type !== 2) return undefined;
      if (entry.count <= 4) return raw.toString('ascii', entry.valueOffset, entry.valueOffset + entry.count).replace(/\u0000+$/, '').trim();
      const at = base + u32(entry.valueOffset);
      if (at + entry.count > raw.length) return undefined;
      return raw.toString('ascii', at, at + entry.count).replace(/\u0000+$/, '').trim();
    };

    const readShort = (entry: ExifIfdEntry): number | undefined => {
      if (entry.type !== 3 || entry.count < 1) return undefined;
      return little ? raw.readUInt16LE(entry.valueOffset) : raw.readUInt16BE(entry.valueOffset);
    };

    const readRational = (entry: ExifIfdEntry): { num: number; den: number } | undefined => {
      if (entry.type !== 5) return undefined;
      const at = base + u32(entry.valueOffset);
      if (at + 8 > raw.length) return undefined;
      return { num: u32(at), den: u32(at + 4) };
    };

    const ifd0 = readIfd(base + u32(base + 4));
    const dateTime = ifd0.get(0x0132);
    if (dateTime) {
      const shotAt = normalizeExifDate(readString(dateTime));
      if (shotAt) result.shotAt = shotAt;
    }

    const exifPointer = ifd0.get(0x8769);
    if (exifPointer && exifPointer.type === 4) {
      const exifIfd = readIfd(base + u32(exifPointer.valueOffset));
      const original = exifIfd.get(0x9003);
      if (original) {
        const shotAt = normalizeExifDate(readString(original));
        if (shotAt) result.shotAt = shotAt;
      }
      const isoEntry = exifIfd.get(0x8827);
      if (isoEntry) {
        const iso = readShort(isoEntry);
        if (iso !== undefined && iso > 0) result.iso = iso;
      }
      const exposure = exifIfd.get(0x829a);
      if (exposure) {
        const rational = readRational(exposure);
        const shutter = rational ? formatShutter(rational.num, rational.den) : undefined;
        if (shutter) result.shutter = shutter;
      }
      const fnumber = exifIfd.get(0x829d);
      if (fnumber) {
        const rational = readRational(fnumber);
        const aperture = rational ? formatAperture(rational.num, rational.den) : undefined;
        if (aperture) result.aperture = aperture;
      }
      const focal = exifIfd.get(0x920a);
      if (focal) {
        const rational = readRational(focal);
        const focalLength = rational ? formatFocalLength(rational.num, rational.den) : undefined;
        if (focalLength) result.focalLength = focalLength;
      }
    }
  } catch {
    return undefined;
  }
  return Object.keys(result).length ? result : undefined;
}

async function writeDevelopProxyFile(
  filePath: string,
  width: number,
  height: number,
  data: Uint16Array,
  subject: { kind: 'asset' | 'frame'; id: string },
): Promise<void> {
  const encoded = encodeDevelopProxy({ width, height, channels: 3, bitDepth: 16, transfer: 'linear', data });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, encoded);
  const stats = await fs.stat(filePath);
  validatedDevelopProxies.set(filePath, developProxyFileSignature(stats));
  // §16.3：数据库记录版本和校验。写入与记录之间没有 await 之外的失败点，
  // 因此簿记要么与文件一致，要么本次导入/重建整体失败并回滚缓存文件。
  storage.recordCacheState({
    path: filePath,
    kind: subject.kind,
    subjectId: subject.id,
    version: DEVELOP_PROXY_VERSION,
    size: stats.size,
    checksum: developProxyPayloadChecksum(encoded).toString(16).padStart(8, '0'),
  });
}

function developProxyFileSignature(stats: { size: number; mtimeMs: number; ctimeMs: number }): string {
  // ctimeMs 随任何内容/元数据写入而更新：同一会话内被外部进程"原地改坏"
  // （长度与 mtime 都不变）也会使签名失效，从而触发全量 CRC32 复验。
  return `${stats.size}:${Math.round(stats.mtimeMs)}:${Math.round(stats.ctimeMs)}`;
}

async function hasValidDevelopProxy(
  filePath: string,
  subject: { kind: 'asset' | 'frame'; id: string },
): Promise<boolean> {
  if (!existsSync(filePath)) {
    // 文件被外部删除：若簿记仍挂着 valid 记录则转 damaged，让随后的重建
    // 计入 rebuild_count（缺失同样是"缓存不在了"的一种故障注入场景）。
    const tracked = storage.getCacheState(filePath);
    if (tracked && tracked.status === 'valid') storage.markCacheDamaged({ path: filePath, kind: subject.kind, subjectId: subject.id });
    return false;
  }
  try {
    const stats = await fs.stat(filePath);
    const signature = developProxyFileSignature(stats);
    if (validatedDevelopProxies.get(filePath) === signature) return true;
    const proxy = decodeDevelopProxy(await fs.readFile(filePath));
    describeDevelopProxy(proxy);
    validatedDevelopProxies.set(filePath, signature);
    storage.markCacheValidated({ path: filePath, kind: subject.kind, subjectId: subject.id });
    return true;
  } catch (error) {
    // 自愈：任何校验失败（截断、校验和不符、头部损坏）都会移除残骸并落账，
    // 由调用方的 ensure* 路径按需重建，绝不把坏缓存喂给 Worker。
    validatedDevelopProxies.delete(filePath);
    storage.markCacheDamaged({ path: filePath, kind: subject.kind, subjectId: subject.id });
    await fs.rm(filePath, { force: true });
    console.warn('Chromik: damaged rebuildable develop proxy was removed', filePath, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function createDevelopProxyFromPipeline(
  pipeline: sharp.Sharp,
  metadata: sharp.Metadata,
  filePath: string,
  maxEdge: number,
  subject: { kind: 'asset' | 'frame'; id: string },
): Promise<void> {
  const highPrecision = metadata.depth === 'ushort' || metadata.bitsPerSample === 16;
  let pixels: Uint16Array;
  let width: number;
  let height: number;
  if (highPrecision) {
    const { data, info } = await pipeline.clone().rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .removeAlpha().withIccProfile('srgb', { attach: false }).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const source = new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    pixels = srgb16ToLinear16(source);
    width = info.width;
    height = info.height;
  } else {
    const { data, info } = await pipeline.clone().rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .removeAlpha().withIccProfile('srgb', { attach: false }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    pixels = srgb8ToLinear16(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    width = info.width;
    height = info.height;
  }
  await writeDevelopProxyFile(filePath, width, height, pixels, subject);
}

async function prepareImage(filePath: string, cacheId: string, cacheGroup: 'assets' | 'frames' = 'assets'): Promise<{
  width: number;
  height: number;
  format: string;
  fileSize: number;
  previewPath: string;
  sourceFingerprint: string;
  exif?: AssetExif;
}> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('所选路径不是文件');
  const cacheDirectory = path.join(app.getPath('userData'), 'cache', cacheGroup);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const previewPath = path.join(cacheDirectory, `${cacheId}.jpg`);
  const developPath = developProxyPath(cacheId);
  const decodedHeic = isHeicPath(filePath) ? await decodeHeicInWorker(filePath).catch(() => undefined) : undefined;
  const pipeline = decodedHeic
    ? sharp(decodedHeic.data, { raw: { width: decodedHeic.width, height: decodedHeic.height, channels: 4 } })
    : sharp(filePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
  try {
    const metadata = await pipeline.metadata();
    const exif = extractAssetExif(metadata);
    const dimensions = decodedHeic
      ? { width: decodedHeic.width, height: decodedHeic.height }
      : orientedDimensions(metadata);
    if (!dimensions.width || !dimensions.height) throw new Error('无法读取图像尺寸');
    const aspect = Math.max(dimensions.width / dimensions.height, dimensions.height / dimensions.width);
    const proxyLongEdge = aspect >= 3 ? 4096 : 3072;
    await Promise.all([
      pipeline.clone()
        .rotate()
        .resize({ width: proxyLongEdge, height: proxyLongEdge, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .jpeg({ quality: 89, chromaSubsampling: '4:4:4' })
        .toFile(previewPath),
      createDevelopProxyFromPipeline(pipeline, metadata, developPath, proxyLongEdge, { kind: 'asset', id: cacheId }),
    ]);
    return {
      width: dimensions.width,
      height: dimensions.height,
      format: (decodedHeic ? 'HEIC' : (metadata.format ?? path.extname(filePath).slice(1))).toUpperCase(),
      fileSize: stats.size,
      previewPath,
      sourceFingerprint: await fingerprintSource(filePath),
      exif,
    };
  } catch (error) {
    // Recursively remove everything we may have created so the user's
    // import cannot leave half-written cache files behind.
    try { await removeCachePaths([previewPath, developPath]); }
    catch (cleanupError) {
      console.warn('Chromik: 失败的导入清理未完成', cleanupError);
    }
    throw error;
  }
}

function queueLegacyRawDisplayPreview(assetId: string): void {
  if (rawDisplayMigrationQueued.has(assetId) || existsSync(rawDisplayMarkerPath(assetId))) return;
  const asset = storage.getAsset(assetId);
  const paths = asset ? storage.getAssetPaths(assetId) : undefined;
  if (!asset || !isRawPath(asset.sourcePath) || !paths?.previewPath || !existsSync(paths.previewPath) || !existsSync(rawCachePath(assetId))) return;
  rawDisplayMigrationQueued.add(assetId);
  rawDisplayMigrationQueue.push(assetId);
  if (!rawDisplayMigrationRunning) setTimeout(() => void pumpRawDisplayMigrations(), 250);
}

async function pumpRawDisplayMigrations(): Promise<void> {
  if (rawDisplayMigrationRunning) return;
  const assetId = rawDisplayMigrationQueue.shift();
  if (!assetId) return;
  rawDisplayMigrationRunning = true;
  try {
    const paths = storage.getAssetPaths(assetId);
    if (!paths?.previewPath) return;
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, '..', 'workers', 'raw-display.worker.js'), {
        workerData: {
          rawPath: rawCachePath(assetId), rawMetaPath: rawCacheMetaPath(assetId), currentPreviewPath: paths.previewPath,
          analysisPath: rawAnalysisPreviewPath(assetId), displayPath: paths.previewPath, markerPath: rawDisplayMarkerPath(assetId),
        },
      });
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void worker.terminate();
        callback();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error('RAW 显示代理迁移超时'))), 60_000);
      worker.once('message', (result: BasicWorkerResult) => finish(() => result.ok ? resolve() : reject(new Error(result.message ?? 'RAW 显示代理迁移失败'))));
      worker.once('error', (error) => finish(() => reject(error)));
    });
    storage.touchAssetPreview(assetId);
  } catch (error) {
    console.warn(`Chromik: RAW 显示预览惰性迁移失败 ${assetId}`, error);
  } finally {
    rawDisplayMigrationQueued.delete(assetId);
    rawDisplayMigrationRunning = false;
    if (rawDisplayMigrationQueue.length) setTimeout(() => void pumpRawDisplayMigrations(), 250);
  }
}

async function prepareRawImage(
  filePath: string,
  assetId: string,
  decoded: RawDecodedImage,
  options: { signal?: AbortSignal; onProgress?: (stage: RawCacheStage, elapsedMs: number) => void } = {},
): Promise<{
  width: number;
  height: number;
  format: string;
  fileSize: number;
  previewPath: string;
  sourceFingerprint: string;
}> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('RAW 原始文件已移动');
  const expected = decoded.width * decoded.height * decoded.channels;
  if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 2 || decoded.height < 2
    || decoded.width > 100_000 || decoded.height > 100_000 || decoded.data.length !== expected) {
    throw new Error('RAW 解码结果尺寸无效');
  }
  if ((decoded.bits === 16 && !(decoded.data instanceof Uint16Array)) || (decoded.bits === 8 && !(decoded.data instanceof Uint8Array))) {
    throw new Error('RAW 解码结果位深无效');
  }
  const previewPath = path.join(app.getPath('userData'), 'cache', 'assets', `${assetId}.jpg`);
  const dataBuffer = decoded.data.byteOffset === 0 && decoded.data.byteLength === decoded.data.buffer.byteLength
    ? decoded.data.buffer as ArrayBuffer
    : decoded.data.buffer.slice(decoded.data.byteOffset, decoded.data.byteOffset + decoded.data.byteLength) as ArrayBuffer;
  await new Promise<void>((resolve, reject) => {
    const workerPath = path.join(__dirname, '..', 'workers', 'raw-cache.worker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        sourcePath: filePath,
        width: decoded.width,
        height: decoded.height,
        channels: decoded.channels,
        bits: decoded.bits,
        transfer: decoded.transfer,
        dataBuffer,
        paths: {
          raw: rawCachePath(assetId),
          rawMeta: rawCacheMetaPath(assetId),
          develop: developProxyPath(assetId),
          analysis: rawAnalysisPreviewPath(assetId),
          display: previewPath,
          displayMarker: rawDisplayMarkerPath(assetId),
        },
      },
      transferList: [dataBuffer],
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => {
      const error = new Error('RAW 导入已取消');
      error.name = 'AbortError';
      // P1-02：先请求协作式取消（worker 在阶段边界自清半成品），再硬终止兜底。
      try { worker.postMessage({ type: 'cancel' }); } catch { /* worker already gone */ }
      reject(error);
    });
    const timeout = setTimeout(() => finish(() => reject(new Error('RAW 缓存生成超时（300 秒）'))), 300_000);
    worker.on('message', (message: RawCacheWorkerMessage) => {
      if (message.type === 'progress') {
        options.onProgress?.(message.stage, message.elapsedMs);
        return;
      }
      finish(() => message.ok ? resolve() : reject(new Error(message.message ?? 'RAW 缓存生成失败')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      // BUG-016：worker 正常退出（code 0）但未发结果消息时，必须立即结算，
      // 否则 prepareRawImage 的 Promise 会悬挂到 300 秒超时。
      if (!settled) finish(() => reject(new Error(code === 0 ? 'RAW 缓存线程未返回结果便退出' : `RAW 缓存线程异常退出（${code}）`)));
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  return {
    width: decoded.width,
    height: decoded.height,
    format: path.extname(filePath).slice(1).toUpperCase() || 'RAW',
    fileSize: stats.size,
    previewPath,
    sourceFingerprint: await fingerprintSource(filePath),
  };
}

async function ensureDevelopProxy(assetId: string): Promise<string> {
  const destination = developProxyPath(assetId);
  const subject = { kind: 'asset' as const, id: assetId };
  if (await hasValidDevelopProxy(destination, subject)) return destination;
  const pending = developProxyJobs.get(assetId);
  if (pending) return pending;
  const job = (async () => {
    const asset = storage.getAsset(assetId);
    if (!asset) throw new Error('找不到开发代理对应的素材');
    if (isRawPath(asset.sourcePath)) {
      const cachePath = rawCachePath(assetId);
      if (!existsSync(cachePath)) throw new Error('RAW 高位深缓存缺失，请重新导入这个素材');
      const decoded = decodeTiff16(await fs.readFile(cachePath));
      if (!decoded) throw new Error('RAW 高位深缓存损坏，请重新导入这个素材');
      let transfer: 'srgb' | 'linear' = 'srgb';
      try {
        const meta = JSON.parse(await fs.readFile(rawCacheMetaPath(assetId), 'utf8')) as { transfer?: unknown };
        if (meta.transfer === 'linear') transfer = 'linear';
      } catch { /* legacy RAW caches were sRGB-encoded */ }
      const proxy = downscaleLinearProxy16(decoded.data, decoded.width, decoded.height, Math.max(asset.width, asset.height) / Math.min(asset.width, asset.height) >= 3 ? 4096 : 3072);
      const linear = transfer === 'linear' ? proxy.data16 : srgb16ToLinear16(proxy.data16);
      await writeDevelopProxyFile(destination, proxy.width, proxy.height, linear, subject);
      return destination;
    }

    const sourcePath = existsSync(asset.sourcePath) ? asset.sourcePath : storage.getAssetPaths(assetId)?.previewPath;
    if (!sourcePath || !existsSync(sourcePath)) throw new Error('原始素材已移动，无法生成开发代理');
    const decodedHeic = isHeicPath(sourcePath) ? await decodeHeicInWorker(sourcePath) : undefined;
    const pipeline = decodedHeic
      ? sharp(decodedHeic.data, { raw: { width: decodedHeic.width, height: decodedHeic.height, channels: 4 } })
      : sharp(sourcePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
    const metadata = await pipeline.metadata();
    const aspect = Math.max(asset.width / asset.height, asset.height / asset.width);
    await createDevelopProxyFromPipeline(pipeline, metadata, destination, aspect >= 3 ? 4096 : 3072, subject);
    return destination;
  })().finally(() => developProxyJobs.delete(assetId));
  developProxyJobs.set(assetId, job);
  return job;
}

type RawDisplayTransform = 'camera-raw-neutral' | 'camera-raw-legacy-lift';

async function rawDisplayTransform(assetId: string): Promise<RawDisplayTransform> {
  try {
    const meta = JSON.parse(await fs.readFile(rawCacheMetaPath(assetId), 'utf8')) as {
      version?: unknown;
      cameraMatrixPrecision?: unknown;
    };
    if (typeof meta.version === 'number' && meta.version >= 2 && meta.cameraMatrixPrecision === 'float') {
      return 'camera-raw-neutral';
    }
  } catch { /* legacy caches have no sidecar */ }
  return 'camera-raw-legacy-lift';
}

async function ensureFrameDevelopProxy(frameId: string): Promise<string> {
  const destination = frameDevelopProxyPath(frameId);
  const subject = { kind: 'frame' as const, id: frameId };
  if (await hasValidDevelopProxy(destination, subject)) return destination;
  const key = `frame:${frameId}`;
  const pending = developProxyJobs.get(key);
  if (pending) return pending;
  const job = (async () => {
    const paths = storage.getFramePaths(frameId);
    if (!paths?.previewPath || !existsSync(paths.previewPath)) throw new Error('画面代理不存在');
    const pipeline = sharp(paths.previewPath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
    const metadata = await pipeline.metadata();
    await createDevelopProxyFromPipeline(pipeline, metadata, destination, 3072, subject);
    return destination;
  })().finally(() => developProxyJobs.delete(key));
  developProxyJobs.set(key, job);
  return job;
}

async function rawMasterTransfer(assetId: string): Promise<'srgb' | 'linear'> {
  try {
    const meta = JSON.parse(await fs.readFile(rawCacheMetaPath(assetId), 'utf8')) as { transfer?: unknown };
    return meta.transfer === 'linear' ? 'linear' : 'srgb';
  } catch {
    return 'srgb';
  }
}

function assetAnalysisPath(asset: AssetSummary): string {
  const neutralRaw = rawAnalysisPreviewPath(asset.id);
  return isRawPath(asset.sourcePath) && existsSync(neutralRaw)
    ? neutralRaw
    : storage.getAssetPaths(asset.id)?.previewPath ?? asset.sourcePath;
}

async function loadAssetDevelopProxy(assetId: string) {
  return decodeDevelopProxy(await fs.readFile(await ensureDevelopProxy(assetId)));
}

async function assetDevelopAnalysisPng(assetId: string): Promise<Buffer> {
  const proxy = await loadAssetDevelopProxy(assetId);
  if (!(proxy.data instanceof Uint16Array)) throw new Error('高精度分析代理位深无效');
  return sharp(Buffer.from(linear16ToSrgb8(proxy.data)), {
    raw: { width: proxy.width, height: proxy.height, channels: proxy.channels },
  }).png().toBuffer();
}

type ExportWorkerInput = {
  sourcePath: string;
  outputPath: string;
  sourceDescriptor: MasterSourceDescriptor;
  recipe: EditRecipe;
  config: ExportConfig;
  lut?: ReturnType<typeof serializeCubeLut>;
  srgbIcc?: Buffer;
  displayTransform?: RawDisplayTransform;
};

function frameDimensions(asset: AssetSummary, corners: Quad): { width: number; height: number } {
  const distance = (a: Quad[number], b: Quad[number]) => Math.hypot((a.x - b.x) * asset.width, (a.y - b.y) * asset.height);
  return {
    width: Math.max(2, Math.round((distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2)),
    height: Math.max(2, Math.round((distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2)),
  };
}

async function writeFramePreview(asset: AssetSummary, frameId: string, recipe: EditRecipe): Promise<string> {
  const paths = storage.getAssetPaths(asset.id);
  if (!paths?.previewPath || !existsSync(paths.previewPath)) throw new Error('原始素材代理不存在');
  const neutralPreview = isRawPath(asset.sourcePath) && existsSync(rawAnalysisPreviewPath(asset.id)) ? rawAnalysisPreviewPath(asset.id) : paths.previewPath;
  const { data, info } = await sharp(neutralPreview).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const transformed = applyGeometry(data, info.width, info.height, info.channels, recipe.geometry);
  const directory = path.join(app.getPath('userData'), 'cache', 'frames');
  await fs.mkdir(directory, { recursive: true });
  const previewPath = path.join(directory, `${frameId}.jpg`);
  await sharp(Buffer.from(transformed.data.buffer, transformed.data.byteOffset, transformed.data.byteLength), {
    raw: { width: transformed.width, height: transformed.height, channels: transformed.channels as 3 },
  }).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 89, chromaSubsampling: '4:4:4' })
    .toFile(previewPath);
  return previewPath;
}

async function removeCachePaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (filePath) => {
    if (!filePath || !path.resolve(filePath).startsWith(path.resolve(app.getPath('userData')) + path.sep)) return;
    await fs.rm(filePath, { force: true });
  }));
}

async function removeCachePathsAndTemporarySiblings(paths: string[]): Promise<void> {
  await removeCachePaths(paths);
  const userDataRoot = path.resolve(app.getPath('userData')) + path.sep;
  await Promise.all(paths.map(async (filePath) => {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataRoot)) return;
    const directory = path.dirname(resolved);
    const prefix = `${path.basename(resolved)}.`;
    const entries = await fs.readdir(directory).catch(() => []);
    await Promise.all(entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => fs.rm(path.join(directory, name), { force: true })));
  }));
}

async function setAssetFrameRegions(assetId: string, regions: FrameRegionInput[]): Promise<FrameSummary[]> {
  const asset = storage.getAsset(assetId);
  if (!asset) throw new Error('找不到原始素材');
  const roll = storage.getRoll(asset.rollId);
  if (!roll) throw new Error('找不到胶卷');
  const existing = storage.listFramesForAsset(assetId);
  const existingById = new Map(existing.map((frame) => [frame.id, frame]));
  const retainedIds = new Set(regions.flatMap((region) => region.frameId ? [region.frameId] : []));
  const removed = existing.filter((frame) => !retainedIds.has(frame.id));
  if (removed.length) {
    const cachePaths = storage.deleteFrames(removed.map((frame) => frame.id));
    const developProxies = removed.map((frame) => frameDevelopProxyPath(frame.id));
    storage.deleteCacheStates(developProxies);
    // Cleanup runs after the DB commit so a failed cache remove can no longer
    // discard the user's edits. Missing cache files can be regenerated on demand;
    // missing DB rows cannot.
    try { await removeCachePaths([...cachePaths, ...developProxies]); }
    catch (cleanupError) {
      console.warn('Chromik: 分帧缓存清理失败，可在设置中执行“清理可重建缓存”', cleanupError);
    }
  }

  for (const [index, region] of regions.entries()) {
    const previous = region.frameId ? existingById.get(region.frameId) : undefined;
    if (region.frameId && !previous) throw new Error('分帧区域不属于当前素材');
    const frameId = previous?.id ?? randomUUID();
    const recipe = previous?.recipe ?? createRecipeForFilmType(roll.filmType);
    if (!previous) {
      recipe.baseRgb = roll.calibration.baseRgb;
      recipe.baseRgbLinear = roll.calibration.baseRgbLinear;
      recipe.density = {
        ...roll.calibration.density,
        enabled: (roll.filmType === 'color_negative' || roll.filmType === 'bw_negative') && roll.calibration.density.enabled,
      };
    }
    recipe.crop = quadToCrop(region.corners);
    recipe.geometry = { ...recipe.geometry, corners: region.corners };
    const dimensions = frameDimensions(asset, region.corners);
    const previewPath = await writeFramePreview(asset, frameId, recipe);
    const name = `${path.parse(asset.name).name}-F${String(index + 1).padStart(3, '0')}`;
    if (previous) {
      storage.updateFrameGeometry(frameId, { ...dimensions, previewPath, name, recipe });
    } else {
      storage.addFrame({
        id: frameId,
        rollId: asset.rollId,
        assetId,
        name,
        sourcePath: asset.sourcePath,
        sourceFingerprint: await fingerprintSource(asset.sourcePath),
        ...dimensions,
        format: asset.format,
        fileSize: asset.fileSize,
        previewPath,
        recipe,
        createdAt: Date.now() + index,
      });
    }
  }
  storage.renumberRollFrames(asset.rollId);
  return storage.listFramesForAsset(assetId);
}

async function detectAssetKind(previewPath: string, width: number, height: number): Promise<{ kind: AssetKind; confidence: number; reason: string }> {
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  if (ratio >= 2.15) return { kind: 'strip', confidence: Math.min(0.98, 0.78 + (ratio - 2.15) * 0.08), reason: '画面长宽比符合胶片长条' };

  try {
    const { data, info } = await sharp(previewPath).greyscale().resize({ width: 320, height: 320, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    const projectionPeaks = (axis: 'x' | 'y') => {
      const length = axis === 'x' ? info.width - 1 : info.height - 1;
      const cross = axis === 'x' ? info.height : info.width;
      const values = new Array(Math.max(0, length)).fill(0);
      for (let p = 0; p < length; p += 1) {
        let sum = 0;
        for (let c = 0; c < cross; c += 1) {
          const x = axis === 'x' ? p : c;
          const y = axis === 'x' ? c : p;
          const nextX = axis === 'x' ? x + 1 : x;
          const nextY = axis === 'x' ? y : y + 1;
          sum += Math.abs(data[y * info.width + x] - data[nextY * info.width + nextX]);
        }
        values[p] = sum / cross;
      }
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
      const threshold = mean + Math.sqrt(variance) * 1.7;
      let peaks = 0;
      let last = -12;
      values.forEach((value, index) => {
        if (index < length * 0.06 || index > length * 0.94 || value < threshold || index - last < 10) return;
        peaks += 1;
        last = index;
      });
      return peaks;
    };
    const xPeaks = projectionPeaks('x');
    const yPeaks = projectionPeaks('y');
    if (xPeaks >= 2 && yPeaks >= 2) {
      return { kind: 'contact', confidence: Math.min(0.94, 0.68 + (xPeaks + yPeaks) * 0.035), reason: `识别到 ${xPeaks} 组纵向和 ${yPeaks} 组横向分隔` };
    }
  } catch {
    // Dimension-only fallback below keeps import usable even for unusual codecs.
  }
  // AUTO-01：无结构证据时不冒充“高置信单张”，返回 unknown 交给
  // 导入复核一次性确认；长宽比接近 1 时才给有保留的单张默认。
  if (ratio < 1.4) return { kind: 'single', confidence: 0.62, reason: '画面比例接近单张照片，未发现分帧结构' };
  return { kind: 'unknown', confidence: 0.45, reason: '未发现连续分帧结构，请在导入复核中确认素材类型' };
}

async function importAssetPaths(rollId: string, paths: string[], forcedKind?: AssetKind, createdAt = Date.now()): Promise<ImportResult> {
  if (paths.length === 0) return { cancelled: true, imported: 0, errors: [] };
  if (!storage.getRoll(rollId)) throw new Error('请先创建或选择胶卷');
  const errors: ImportResult['errors'] = [];
  const importedAssets: NonNullable<ImportResult['importedAssets']> = [];
  let imported = 0;
  for (const [index, filePath] of paths.entries()) {
    const assetId = randomUUID();
    try {
      const prepared = await prepareImage(filePath, assetId, 'assets');
      const recognition = forcedKind
        ? { kind: forcedKind, confidence: 1, reason: '由示例或明确操作指定' }
        : await detectAssetKind(prepared.previewPath, prepared.width, prepared.height);
      storage.addAsset({
        id: assetId,
        rollId,
        name: path.basename(filePath),
        sourcePath: filePath,
        ...prepared,
        kind: recognition.kind,
        createdAt: createdAt + index,
      });
      if (recognition.kind === 'single') {
        await setAssetFrameRegions(assetId, [{ corners: rectToQuad({ x: 0, y: 0, width: 1, height: 1 }) }]);
      }
      importedAssets.push({ id: assetId, name: path.basename(filePath), ...recognition });
      imported += 1;
    } catch (error) {
      try { await removeCachePaths([
        path.join(app.getPath('userData'), 'cache', 'assets', `${assetId}.jpg`),
        developProxyPath(assetId),
      ]); }
      catch (cleanupError) {
        console.warn('Chromik: 导入失败后的缓存清理未完成', cleanupError);
      }
      errors.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { cancelled: false, rollId: imported > 0 ? rollId : undefined, imported, errors, importedAssets };
}

async function continueSelectedImport(rollId: string, filePaths: string[]): Promise<ImportResult> {
  const rawPaths = filePaths.filter(isRawPath).map((filePath) => path.resolve(filePath));
  const standardPaths = filePaths.filter((filePath) => !isRawPath(filePath));
  for (const filePath of rawPaths) {
    allowedRawImports.add(filePath);
    recentRawRetryPaths.set(filePath, { rollId, expiresAt: Date.now() + 10 * 60_000 });
  }
  const imported = await importAssetPaths(rollId, standardPaths);
  const rawImports = await Promise.all(rawPaths.map(issueRawImportJob));
  return { ...imported, cancelled: false, rollId: imported.rollId ?? (rawImports.length ? rollId : undefined), rawImports };
}

async function issueRawImportJob(sourcePath: string) {
  const token = randomUUID();
  rawImportReadTokens.set(token, { sourcePath, expiresAt: Date.now() + 10 * 60_000 });
  return {
    sourcePath,
    readUrl: `app-media://raw-import/${token}`,
    name: path.basename(sourcePath),
    fileSize: (await fs.stat(sourcePath)).size,
  };
}

async function findImportDuplicates(filePaths: string[]): Promise<import('../shared/types').ImportDuplicate[]> {
  const duplicates: import('../shared/types').ImportDuplicate[] = [];
  for (const sourcePath of filePaths) {
    try {
      const fingerprint = await fingerprintSource(sourcePath);
      const existing = storage.findSourceByFingerprint(fingerprint);
      if (existing) duplicates.push({
        sourcePath,
        name: path.basename(sourcePath),
        existingPath: existing.sourcePath,
        existingName: existing.displayName,
      });
    } catch {
      // Let the normal import path surface unreadable/invalid files alongside
      // the rest of the batch instead of turning duplicate scanning fatal.
    }
  }
  return duplicates;
}

async function commitRawAsset(
  rollId: string,
  sourcePath: string,
  decoded: RawDecodedImage,
  options: { signal?: AbortSignal; onProgress?: (stage: RawCacheStage, elapsedMs: number) => void } = {},
): Promise<ImportResult> {
  const startedAt = Date.now();
  const roll = storage.getRoll(rollId);
  if (!roll) throw new Error('找不到要导入的胶卷');
  const resolved = path.resolve(sourcePath);
  if (!allowedRawImports.has(resolved) || !isRawPath(resolved)) throw new Error('请重新从导入窗口选择 RAW 文件');
  const assetId = randomUUID();
  try {
    const prepared = await prepareRawImage(resolved, assetId, decoded, options);
    if (options.signal?.aborted) {
      const error = new Error('RAW 导入已取消');
      error.name = 'AbortError';
      throw error;
    }
    options.onProgress?.('recognition', Date.now() - startedAt);
    const recognition = await detectAssetKind(rawAnalysisPreviewPath(assetId), prepared.width, prepared.height);
    const camera = [decoded.cameraMake, decoded.cameraModel].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const exif: AssetExif = {
      camera: camera || undefined,
      lens: decoded.lens,
      iso: decoded.iso,
      shutter: decoded.shutter,
      aperture: decoded.aperture,
      focalLength: decoded.focalLength,
      shotAt: decoded.shotAt,
    };
    storage.addAsset({
      id: assetId,
      rollId,
      name: path.basename(resolved),
      sourcePath: resolved,
      ...prepared,
      kind: recognition.kind,
      exif: Object.values(exif).some(Boolean) ? exif : undefined,
      createdAt: Date.now(),
    });
    if ((camera && !roll.camera) || (decoded.lens && !roll.lens)) {
      storage.updateRoll(rollId, {
        name: roll.name, filmType: roll.filmType, camera: roll.camera || camera, lens: roll.lens || decoded.lens || '', filmStock: roll.filmStock,
        iso: roll.iso, development: roll.development, shotDate: roll.shotDate, notes: roll.notes,
      });
    }
    if (recognition.kind === 'single') {
      await setAssetFrameRegions(assetId, [{ corners: rectToQuad({ x: 0, y: 0, width: 1, height: 1 }) }]);
    }
    options.onProgress?.('database', Date.now() - startedAt);
    recordMainTiming('raw.cache-and-database', Date.now() - startedAt, { rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2) });
    recentRawRetryPaths.delete(resolved);
    return { cancelled: false, rollId, imported: 1, errors: [], importedAssets: [{ id: assetId, name: path.basename(resolved), ...recognition }] };
  } catch (error) {
    try { await removeCachePathsAndTemporarySiblings([
      rawCachePath(assetId), rawCacheMetaPath(assetId), developProxyPath(assetId),
      path.join(app.getPath('userData'), 'cache', 'assets', `${assetId}.jpg`),
      rawAnalysisPreviewPath(assetId), rawDisplayMarkerPath(assetId),
    ]); }
    catch (cleanupError) {
      console.warn('Chromik: RAW 缓存清理未完成', cleanupError);
    }
    return { cancelled: false, imported: 0, errors: [{ path: resolved, message: error instanceof Error ? error.message : String(error) }] };
  } finally {
    // Single-use import token: clear it on every outcome so failed commits
    // cannot accumulate stale paths in the allowlist.
    allowedRawImports.delete(resolved);
  }
}

/**
 * Merges 2–6 bracketed exposures of one scene into a single asset (Mertens
 * exposure fusion with global translation alignment). Sources are decoded at
 * full resolution, resized to the smallest common dimensions and stored as a
 * TIFF cache asset that then behaves like any other imported file.
 */
function resizeHdr16(source: Hdr16Source, width: number, height: number): Hdr16Source {
  if (source.width === width && source.height === height) return source;
  const data = new Uint16Array(width * height * source.channels);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor(y * source.height / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(x * source.width / width));
      const from = (sy * source.width + sx) * source.channels;
      const to = (y * width + x) * source.channels;
      for (let channel = 0; channel < source.channels; channel += 1) data[to + channel] = source.data[from + channel];
    }
  }
  return { width, height, channels: source.channels, data };
}

async function mergeHdrAssets(rollId: string, assetIds: string[]): Promise<HdrMergeResult> {
  const roll = storage.getRoll(rollId);
  if (!roll) throw new Error('找不到胶卷');
  const assets = assetIds.map((id) => storage.getAsset(id));
  if (assets.some((asset) => !asset || asset.rollId !== rollId)) throw new Error('所选原始素材不属于当前胶卷');
  const ready = assets.filter((asset): asset is AssetSummary => Boolean(asset));
  if (ready.length < 2 || ready.length > 6) throw new Error('HDR 合成需要选择 2–6 张原始素材');
  // P1-06：实验功能必须限制输入规模，避免 6 张全分辨率 16 位图同时驻留内存。
  const HDR_MAX_SOURCE_PIXELS = 48_000_000;
  const HDR_MAX_TOTAL_PIXELS = 220_000_000;
  const totalPixels = ready.reduce((sum, asset) => sum + asset.width * asset.height, 0);
  for (const asset of ready) {
    const megapixels = asset.width * asset.height / 1_000_000;
    if (asset.width * asset.height > HDR_MAX_SOURCE_PIXELS) {
      throw new Error(`${asset.name} 约 ${megapixels.toFixed(0)} MP，超过单张 ${HDR_MAX_SOURCE_PIXELS / 1_000_000} MP 的实验上限；请先用较小尺寸导出后再合成`);
    }
  }
  if (totalPixels > HDR_MAX_TOTAL_PIXELS) {
    throw new Error(`HDR 输入像素总量约 ${(totalPixels / 1_000_000).toFixed(0)} MP，超过 ${HDR_MAX_TOTAL_PIXELS / 1_000_000} MP 的实验上限；请减少张数`);
  }

  // BUG-024：先统一预检源文件，再决定位深路径。原实现同时解码 16 位与
  // 8 位两份全分辨率副本驻留内存；现在只有全部素材都能提供 16 位时才
  // 跳过 8 位解码，混合/HEIC 素材走 8 位路径，峰值内存显著下降。
  for (const asset of ready) {
    const sourcePath = isRawPath(asset.sourcePath) ? rawCachePath(asset.id) : asset.sourcePath;
    if (!existsSync(sourcePath)) throw new Error(`${asset.name} 的源文件缺失，请重新定位`);
  }
  const sources16: Array<Hdr16Source | undefined> = [];
  for (const asset of ready) {
    if (isRawPath(asset.sourcePath)) {
      sources16.push(decodeTiff16(await fs.readFile(rawCachePath(asset.id))) ?? undefined);
      continue;
    }
    if (isHeicPath(asset.sourcePath)) {
      sources16.push(undefined);
      continue;
    }
    try {
      const pipeline = sharp(asset.sourcePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
      const metadata = await pipeline.metadata();
      if (metadata.depth === 'ushort') {
        const ushort = await pipeline.clone().rotate().removeAlpha().toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
        sources16.push({
          width: ushort.info.width,
          height: ushort.info.height,
          channels: 3,
          data: new Uint16Array(ushort.data.buffer, ushort.data.byteOffset, ushort.data.byteLength / 2),
        });
      } else {
        sources16.push(undefined);
      }
    } catch {
      // 单张 16 位解码失败时整批退回 8 位路径，而不是中断整个合成。
      sources16.push(undefined);
    }
  }
  const use16Bit = sources16.length === ready.length && sources16.every((source): source is Hdr16Source => Boolean(source));
  let merged8: ReturnType<typeof mergeExposures> | undefined;
  let merged16: ReturnType<typeof mergeExposures16> | undefined;
  if (use16Bit) {
    const targetWidth = Math.min(...sources16.map((source) => (source as Hdr16Source).width));
    const targetHeight = Math.min(...sources16.map((source) => (source as Hdr16Source).height));
    merged16 = mergeExposures16(sources16.map((source) => resizeHdr16(source as Hdr16Source, targetWidth, targetHeight)), { align: true });
  } else {
    const sources: HdrSource[] = [];
    const dimensions: Array<{ width: number; height: number }> = [];
    for (const asset of ready) {
      const sourcePath = isRawPath(asset.sourcePath) ? rawCachePath(asset.id) : asset.sourcePath;
      const decodedHeic = isHeicPath(asset.sourcePath) ? await decodeHeicInWorker(asset.sourcePath) : undefined;
      const pipeline = decodedHeic
        ? sharp(decodedHeic.data, { raw: { width: decodedHeic.width, height: decodedHeic.height, channels: 4 } })
        : sharp(sourcePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
      const { data, info } = await pipeline.clone().rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
      sources.push({ width: info.width, height: info.height, channels: 3, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) });
      dimensions.push({ width: info.width, height: info.height });
    }
    const targetWidth = Math.min(...dimensions.map((dimension) => dimension.width));
    const targetHeight = Math.min(...dimensions.map((dimension) => dimension.height));
    const normalized: HdrSource[] = [];
    for (const source of sources) {
      if (source.width === targetWidth && source.height === targetHeight) {
        normalized.push(source);
        continue;
      }
      const resized = await sharp(Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength), {
        raw: { width: source.width, height: source.height, channels: 3 },
      }).resize({ width: targetWidth, height: targetHeight, fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
      normalized.push({ width: targetWidth, height: targetHeight, channels: 3, data: new Uint8ClampedArray(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength) });
    }
    merged8 = mergeExposures(normalized, { align: true });
  }

  const assetId = randomUUID();
  const mergedDirectory = path.join(app.getPath('userData'), 'cache', 'merged');
  const assetDirectory = path.join(app.getPath('userData'), 'cache', 'assets');
  await Promise.all([fs.mkdir(mergedDirectory, { recursive: true }), fs.mkdir(assetDirectory, { recursive: true })]);
  const mergedPath = mergedCachePath(assetId);
  const previewPath = path.join(assetDirectory, `${assetId}.jpg`);
  const mergedWidth = merged16?.width ?? merged8!.width;
  const mergedHeight = merged16?.height ?? merged8!.height;
  if (merged16) {
    await fs.writeFile(mergedPath, encodeTiff16(merged16.width, merged16.height, merged16.data, 3));
    await sharp(mergedPath).resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(previewPath);
  } else {
    const rawBuffer = Buffer.from(merged8!.data.buffer, merged8!.data.byteOffset, merged8!.data.byteLength);
    await Promise.all([
      sharp(rawBuffer, { raw: { width: merged8!.width, height: merged8!.height, channels: 3 } })
        .toColourspace('srgb').tiff({ compression: 'lzw' }).toFile(mergedPath),
      sharp(rawBuffer, { raw: { width: merged8!.width, height: merged8!.height, channels: 3 } })
        .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb').jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(previewPath),
    ]);
  }
  const stats = await fs.stat(mergedPath);
  storage.addAsset({
    id: assetId,
    rollId,
    name: `${path.parse(ready[0].name).name}-HDR`,
    sourcePath: mergedPath,
    width: mergedWidth,
    height: mergedHeight,
    format: 'TIFF',
    fileSize: stats.size,
    previewPath,
    kind: 'single',
    createdAt: Date.now(),
    sourceFingerprint: await fingerprintSource(mergedPath),
  });
  await setAssetFrameRegions(assetId, [{ corners: rectToQuad({ x: 0, y: 0, width: 1, height: 1 }) }]);
  return { asset: storage.getAsset(assetId) };
}

const CORPUS_SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.heif', '.hif']);

/**
 * Dev-only batch validation (`FILMLAB_CORPUS_DIR`): decodes every supported
 * image in a directory, runs a 16-bit export smoke per file and writes a JSON
 * report next to the corpus. RAW files are recorded but not decoded here —
 * LibRaw runs in the renderer, so RAW acceptance goes through the app UI.
 */
async function runCorpusValidation(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const entries = (await fs.readdir(resolved)).filter((name) => !name.startsWith('.'));
  const outputDirectory = path.join(resolved, 'chromik-corpus-tmp');
  await fs.mkdir(outputDirectory, { recursive: true });
  const results: Array<Record<string, unknown>> = [];
  for (const name of entries) {
    const filePath = path.join(resolved, name);
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats?.isFile()) continue;
    const extension = path.extname(name).toLowerCase();
    const isRaw = RAW_EXTENSIONS.has(extension);
    if (!isRaw && !CORPUS_SUPPORTED_EXTENSIONS.has(extension)) {
      results.push({ file: name, kind: 'unsupported', ok: false, error: '未支持的扩展名' });
      continue;
    }
    const kind = isRaw ? 'raw' : isHeicPath(filePath) ? 'heic' : 'standard';
    const decodeStart = Date.now();
    try {
      if (isRaw) {
        results.push({ file: name, kind, ok: true, sizeBytes: stats.size, note: 'LibRaw 解码在渲染进程执行，RAW 请经应用 UI 导入验收' });
        continue;
      }
      const decodedHeic = isHeicPath(filePath) ? await decodeHeicInWorker(filePath) : undefined;
      const pipeline = decodedHeic
        ? sharp(decodedHeic.data, { raw: { width: decodedHeic.width, height: decodedHeic.height, channels: 4 } })
        : sharp(filePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
      const metadata = await pipeline.metadata();
      await pipeline.clone().rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const decodeMs = Date.now() - decodeStart;
      const outputPath = path.join(outputDirectory, `${path.parse(name).name}-qa.png`);
      const exportStart = Date.now();
      await runExportWorker({
        sourcePath: filePath,
        outputPath,
        sourceDescriptor: {
          role: 'master', transfer: 'srgb', bitDepth: 16, channels: 3, colorSpace: 'srgb',
          decoder: decodedHeic ? 'heic' : 'sharp',
        },
        recipe: createDefaultRecipe(),
        config: {
          directory: outputDirectory,
          format: 'png',
          quality: 92,
          suffix: '_qa',
          bitDepth: 16,
          resizeMode: 'original',
          width: 1,
          height: 1,
          lockAspect: true,
          allowUpscale: false,
          sharpening: 0,
          colorSpace: 'srgb',
          conflictPolicy: 'rename',
          borderPadding: 0,
        },
      });
      const exportMs = Date.now() - exportStart;
      await fs.rm(outputPath, { force: true });
      results.push({
        file: name, kind, ok: true, width: metadata.width, height: metadata.height,
        sizeBytes: stats.size, decodeMs, export16Ms: exportMs,
      });
    } catch (error) {
      results.push({
        file: name, kind, ok: false, sizeBytes: stats.size,
        error: error instanceof Error ? error.message : String(error), decodeMs: Date.now() - decodeStart,
      });
    }
  }
  await fs.rm(outputDirectory, { recursive: true, force: true });
  const reportPath = path.join(resolved, 'chromik-corpus-report.json');
  const summary = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    results,
  };
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2));
  console.log(`[chromik] corpus validation report: ${reportPath} (${summary.passed}/${summary.total} passed)`);
}

function resolveUniqueOutputPath(directory: string, frame: FrameSummary, config: ExportConfig, reserved = new Set<string>()): string | null {
  const extension = config.format === 'jpeg' ? 'jpg' : config.format === 'tiff' ? 'tif' : config.format === 'dng' ? 'dng' : 'png';
  const sourceBase = path.parse(frame.name).name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
    || `Chromik-${String(frame.frameNumber).padStart(2, '0')}`;
  const suffix = config.suffix || '_positive';
  let candidate = path.join(directory, `${sourceBase}${suffix}.${extension}`);
  if (config.conflictPolicy === 'skip' && (existsSync(candidate) || reserved.has(candidate))) return null;
  let index = 2;
  while (existsSync(candidate) || reserved.has(candidate)) {
    candidate = path.join(directory, `${sourceBase}${suffix}-${index}.${extension}`);
    index += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}

interface ThumbnailWorkerInput {
  proxyPath: string;
  recipe: EditRecipe;
  width: number;
  height: number;
  background: string;
  processEdge: number;
  rawDisplayTransform?: RawDisplayTransform;
  lut?: ReturnType<typeof serializeCubeLut>;
}

interface ThumbnailPoolWorker {
  worker: Worker;
  busy: boolean;
  failed: boolean;
  currentJobId?: string;
}

interface ThumbnailPoolJob {
  jobId: string;
  task: ThumbnailWorkerInput;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

const THUMBNAIL_POOL_SIZE = 2;
const thumbnailPool: ThumbnailPoolWorker[] = [];
const thumbnailQueue: ThumbnailPoolJob[] = [];
const thumbnailInFlight = new Map<string, { job: ThumbnailPoolJob; slot: ThumbnailPoolWorker }>();
let thumbnailPoolShuttingDown = false;

function thumbnailAbortError(): Error {
  const error = new Error('缩略图读取已取消');
  error.name = 'AbortError';
  return error;
}

function cleanupThumbnailJob(job: ThumbnailPoolJob): void {
  clearTimeout(job.timeout);
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
}

function removeThumbnailSlot(slot: ThumbnailPoolWorker): void {
  const index = thumbnailPool.indexOf(slot);
  if (index >= 0) thumbnailPool.splice(index, 1);
}

function settleThumbnailJob(jobId: string, data?: Uint8Array, error?: Error): boolean {
  const active = thumbnailInFlight.get(jobId);
  if (!active) return false;
  thumbnailInFlight.delete(jobId);
  active.slot.busy = false;
  active.slot.currentJobId = undefined;
  cleanupThumbnailJob(active.job);
  // Swallow downstream handler errors so a bad resolve / reject cannot
  // bubble up to the worker bridge and crash the main process.
  const settle = () => {
    if (error) active.job.reject(error);
    else if (data) active.job.resolve(Buffer.from(data));
    else active.job.reject(new Error('缩略图工作线程未返回数据'));
  };
  try { settle(); }
  catch (handlerError) { console.warn('Chromik: 缩略图回调异常', handlerError); }
  pumpThumbnailPool();
  return true;
}

function failThumbnailWorker(slot: ThumbnailPoolWorker, error: Error, terminate = true): void {
  if (slot.failed) return;
  slot.failed = true;
  if (slot.currentJobId) settleThumbnailJob(slot.currentJobId, undefined, error);
  removeThumbnailSlot(slot);
  if (terminate) { try { void slot.worker.terminate(); } catch { /* already exited */ } }
  if (!thumbnailPoolShuttingDown) pumpThumbnailPool();
}

function createThumbnailWorker(): ThumbnailPoolWorker {
  const worker = new Worker(path.join(__dirname, '..', 'workers', 'thumbnail.worker.js'));
  const slot: ThumbnailPoolWorker = { worker, busy: false, failed: false };
  worker.on('message', (message: { type?: string; jobId?: string; data?: Uint8Array; error?: string }) => {
    if (message.type !== 'done' || !message.jobId) return;
    settleThumbnailJob(message.jobId, message.data, message.error ? new Error(message.error) : undefined);
  });
  worker.on('error', (error) => failThumbnailWorker(slot, new Error(`缩略图工作线程异常：${error.message}`)));
  worker.on('exit', (code) => {
    if (thumbnailPoolShuttingDown || slot.failed) return;
    failThumbnailWorker(slot, new Error(`缩略图工作线程提前退出（${code}）`), false);
  });
  return slot;
}

function pumpThumbnailPool(): void {
  if (thumbnailPoolShuttingDown) return;
  while (thumbnailPool.length < THUMBNAIL_POOL_SIZE) thumbnailPool.push(createThumbnailWorker());
  while (thumbnailQueue.length) {
    const slot = thumbnailPool.find((candidate) => !candidate.busy && !candidate.failed);
    if (!slot) return;
    const job = thumbnailQueue.shift()!;
    if (job.signal?.aborted) {
      cleanupThumbnailJob(job);
      job.reject(thumbnailAbortError());
      continue;
    }
    slot.busy = true;
    slot.currentJobId = job.jobId;
    thumbnailInFlight.set(job.jobId, { job, slot });
    try {
      slot.worker.postMessage({ type: 'task', jobId: job.jobId, task: job.task });
    } catch (error) {
      failThumbnailWorker(slot, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function cancelThumbnailJob(jobId: string): void {
  const queuedIndex = thumbnailQueue.findIndex((job) => job.jobId === jobId);
  if (queuedIndex >= 0) {
    const [job] = thumbnailQueue.splice(queuedIndex, 1);
    cleanupThumbnailJob(job);
    job.reject(thumbnailAbortError());
    return;
  }
  const active = thumbnailInFlight.get(jobId);
  if (!active) return;
  thumbnailInFlight.delete(jobId);
  cleanupThumbnailJob(active.job);
  active.job.reject(thumbnailAbortError());
  active.slot.failed = true;
  active.slot.busy = false;
  active.slot.currentJobId = undefined;
  removeThumbnailSlot(active.slot);
  void active.slot.worker.terminate();
  pumpThumbnailPool();
}

function runThumbnailWorker(task: ThumbnailWorkerInput, signal?: AbortSignal, priority = false): Promise<Buffer> {
  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => cancelThumbnailJob(jobId), 60_000);
    const job: ThumbnailPoolJob = { jobId, task, signal, timeout, resolve, reject };
    job.onAbort = () => cancelThumbnailJob(jobId);
    if (signal?.aborted) {
      clearTimeout(timeout);
      reject(thumbnailAbortError());
      return;
    }
    signal?.addEventListener('abort', job.onAbort, { once: true });
    if (priority) thumbnailQueue.unshift(job);
    else thumbnailQueue.push(job);
    pumpThumbnailPool();
  });
}

function shutdownThumbnailPool(): void {
  thumbnailPoolShuttingDown = true;
  const error = new Error('应用正在退出，缩略图任务已停止');
  for (const job of thumbnailQueue.splice(0)) {
    cleanupThumbnailJob(job);
    job.reject(error);
  }
  for (const { job } of thumbnailInFlight.values()) {
    cleanupThumbnailJob(job);
    job.reject(error);
  }
  thumbnailInFlight.clear();
  for (const slot of thumbnailPool) void slot.worker.terminate();
  thumbnailPool.length = 0;
}

async function renderProcessedThumbnail(frame: FrameSummary, width = 280, height = 180, background = '#171512', signal?: AbortSignal, priority = false): Promise<Buffer> {
  const processEdge = Math.min(1200, Math.max(480, Math.ceil(Math.max(width, height) * 1.1)));
  const lut = frame.recipe.grade.lutId ? await loadLutById(frame.recipe.grade.lutId).catch(() => undefined) : undefined;
  const proxyPath = frame.assetId ? await ensureDevelopProxy(frame.assetId) : await ensureFrameDevelopProxy(frame.id);
  const rawPositiveTransform = frame.assetId && isRawPath(frame.sourcePath) && !frame.recipe.density.enabled
    ? await rawDisplayTransform(frame.assetId)
    : undefined;
  return runThumbnailWorker({
    proxyPath,
    recipe: frame.recipe,
    width,
    height,
    background,
    processEdge,
    rawDisplayTransform: rawPositiveTransform,
    lut: lut ? serializeCubeLut(lut) : undefined,
  }, signal, priority);
}

// In-memory LRU cache for the app-media://processed endpoint. Rendering a
// thumbnail re-runs geometry + processRgb8 + sharp JPEG encoding (50-200ms);
// without this, a 200-frame export list re-renders every frame on first paint.
const processedThumbnailCache = new Map<string, Buffer>();
const PROCESSED_THUMBNAIL_CACHE_LIMIT = 100;

function processedThumbnailCacheKey(frame: FrameSummary): string {
  // recipe.updatedAt covers every renderer-driven recipe change (updateRecipe
  // always bumps it); width/height additionally cover main-process re-framing
  // (setAssetFrameRegions rewrites geometry without bumping updatedAt).
  return [frame.id, frame.recipe.updatedAt, frame.recipe.grade.lutId ?? '', frame.width, frame.height].join(':');
}

async function getCachedProcessedThumbnail(frame: FrameSummary, signal?: AbortSignal, priority = false): Promise<Buffer> {
  const key = processedThumbnailCacheKey(frame);
  const cached = processedThumbnailCache.get(key);
  if (cached) {
    // Re-insert to refresh recency: Map preserves insertion order, so the
    // eviction below drops the least recently used entry.
    processedThumbnailCache.delete(key);
    processedThumbnailCache.set(key, cached);
    return cached;
  }
  const rendered = await renderProcessedThumbnail(frame, 960, 640, '#171512', signal, priority);
  if (processedThumbnailCache.size >= PROCESSED_THUMBNAIL_CACHE_LIMIT) {
    const oldest = processedThumbnailCache.keys().next().value;
    if (oldest !== undefined) processedThumbnailCache.delete(oldest);
  }
  processedThumbnailCache.set(key, rendered);
  return rendered;
}

async function createContactSheet(rollId: string, directory: string, config: ContactSheetConfig): Promise<string> {
  const roll = storage.listRolls().find((item) => item.id === rollId);
  if (!roll) throw new Error('找不到胶卷');
  const frames = storage.listFrames(rollId);
  if (!frames.length) throw new Error('胶卷中没有画面');
  const themes = {
    classic: { background: '#FFFDF5', cell: '#171512', text: '#0F172A', muted: '#64748B', accent: '#D89722' },
    darkroom: { background: '#111317', cell: '#050506', text: '#F8FAFC', muted: '#94A3B8', accent: '#EF4444' },
    minimal: { background: '#FFFFFF', cell: '#F8FAFC', text: '#111827', muted: '#6B7280', accent: '#111827' },
  } as const;
  const theme = themes[config.style];
  const scale = config.resolution === 'preview' ? 1 : config.resolution === 'standard' ? 2 : 3;
  const columns = config.columns;
  const cellWidth = 310 * scale;
  const imageWidth = 280 * scale;
  const imageHeight = 180 * scale;
  const pageMargin = 30 * scale;
  const labelHeight = (config.showFileName || config.showMetadata ? 46 : 10) * scale;
  const cellHeight = 190 * scale + labelHeight;
  const headerHeight = 96 * scale;
  const rows = Math.ceil(frames.length / columns);
  const width = columns * cellWidth + 40 * scale;
  const height = headerHeight + rows * cellHeight + 28 * scale;
  const composites: sharp.OverlayOptions[] = [];
  for (const [index, frame] of frames.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = pageMargin + column * cellWidth;
    const top = headerHeight + row * cellHeight;
    try {
      composites.push({ input: await renderProcessedThumbnail(frame, imageWidth, imageHeight, theme.cell), left, top });
    } catch {
      // A missing frame remains represented by its label and does not abort the sheet.
    }
    if (config.showFileName || config.showMetadata) {
      const primary = config.showFileName ? `${String(frame.frameNumber).padStart(2, '0')}  ${escapeXml(frame.name)}` : `Frame ${String(frame.frameNumber).padStart(2, '0')}`;
      const metadata = config.showMetadata ? `${frame.width} × ${frame.height} · ${escapeXml(roll.filmStock || roll.filmType)}` : '';
      const label = Buffer.from(`<svg width="${imageWidth}" height="${42 * scale}"><text x="${2 * scale}" y="${17 * scale}" font-family="Arial, sans-serif" font-size="${13 * scale}" font-weight="700" fill="${theme.text}">${primary}</text><text x="${2 * scale}" y="${35 * scale}" font-family="Arial, sans-serif" font-size="${10 * scale}" fill="${theme.muted}">${metadata}</text></svg>`);
      composites.push({ input: label, left, top: top + 184 * scale });
    }
  }
  const title = config.title || roll.name;
  const rollLine = config.showMetadata ? [roll.filmStock, roll.iso ? `ISO ${roll.iso}` : '', roll.camera, roll.shotDate].filter(Boolean).join(' · ') : '';
  const background = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${theme.background}"/><rect x="${30 * scale}" y="${70 * scale}" width="${Math.min(width - 60 * scale, 120 * scale)}" height="${3 * scale}" rx="${1.5 * scale}" fill="${theme.accent}"/><text x="${30 * scale}" y="${38 * scale}" font-family="Arial, sans-serif" font-size="${24 * scale}" font-weight="700" fill="${theme.text}">${escapeXml(title)}</text><text x="${30 * scale}" y="${61 * scale}" font-family="Arial, sans-serif" font-size="${12 * scale}" fill="${theme.muted}">Chromik 珂影 Contact Sheet · ${frames.length} frames${rollLine ? ` · ${escapeXml(rollLine)}` : ''}</text></svg>`);
  const extension = config.format === 'png' ? 'png' : 'jpg';
  let outputPath = path.join(directory, `${roll.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-contact-sheet.${extension}`);
  let suffix = 2;
  while (existsSync(outputPath)) {
    outputPath = path.join(directory, `${roll.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-contact-sheet-${suffix}.${extension}`);
    suffix += 1;
  }
  let sheet = sharp(background).composite(composites).withIccProfile('srgb');
  sheet = config.format === 'png' ? sheet.png({ compressionLevel: 9 }) : sheet.jpeg({ quality: 92, chromaSubsampling: '4:4:4' });
  const encoded = await sheet.toBuffer();
  const temporaryPath = `${outputPath}.filmlab-${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, encoded, { flag: 'wx' });
  try {
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return outputPath;
}

function resolveContactSheetOutputPath(
  directory: string,
  rollName: string,
  format: ContactSheetConfig['format'],
  reserved: Set<string>,
  page?: { index: number; total: number },
): string {
  const extension = format === 'png' ? 'png' : 'jpg';
  const safeName = rollName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Chromik';
  const pageTag = page && page.total > 1 ? `-p${String(page.index).padStart(2, '0')}` : '';
  const stem = `${safeName}-contact-sheet${pageTag}`;
  let outputPath = path.join(directory, `${stem}.${extension}`);
  let suffix = 2;
  while (existsSync(outputPath) || reserved.has(outputPath)) {
    outputPath = path.join(directory, `${stem}-${suffix}.${extension}`);
    suffix += 1;
  }
  reserved.add(outputPath);
  return outputPath;
}

function emitContactSheetProgress(progress: ExportProgress): void {
  mainWindow?.webContents.send('export:progress', progress);
}

async function cleanupContactSheetOutputs(job: { outputDirectory: string; outputPaths: string[] }): Promise<void> {
  const root = path.resolve(job.outputDirectory) + path.sep;
  await Promise.all(job.outputPaths.map(async (outputPath) => {
    const resolved = path.resolve(outputPath);
    if (!resolved.startsWith(root)) return;
    await fs.rm(resolved, { force: true });
    const entries = await fs.readdir(path.dirname(resolved)).catch(() => []);
    const prefix = `${path.basename(resolved)}.`;
    await Promise.all(entries.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => fs.rm(path.join(path.dirname(resolved), name), { force: true })));
  }));
}

function cancelContactSheetJob(jobId: string): boolean {
  const job = contactSheetJobs.get(jobId);
  if (!job || job.settled) return false;
  job.cancelled = true;
  job.settled = true;
  job.worker?.postMessage({ type: 'cancel' });
  void job.worker?.terminate();
  void cleanupContactSheetOutputs(job);
  contactSheetJobs.delete(jobId);
  emitContactSheetProgress({
    jobId, taskKind: 'contact-sheet', done: 0, total: job.total, status: 'cancelled', errors: [], outputDirectory: job.outputDirectory,
    currentName: '接触印样已取消，临时文件已清理',
  });
  return true;
}

async function runContactSheetJob(
  jobId: string,
  rollIds: string[],
  directory: string,
  config: ContactSheetConfig,
): Promise<void> {
  const startedAt = Date.now();
  const job = contactSheetJobs.get(jobId);
  if (!job || job.cancelled) return;
  try {
    const reserved = new Set<string>();
    const rolls = [];
    for (const rollId of rollIds) {
      const roll = storage.getRoll(rollId);
      if (!roll) throw new Error('找不到要生成接触印样的胶卷');
      const frames = storage.listFrames(rollId);
      if (!frames.length) throw new Error(`胶卷「${roll.name}」中没有画面`);
      const preparedFrames = [];
      for (const frame of frames) {
        if (job.cancelled) return;
        const proxyPath = frame.assetId ? await ensureDevelopProxy(frame.assetId) : await ensureFrameDevelopProxy(frame.id);
        preparedFrames.push({
          id: frame.id,
          name: frame.name,
          frameNumber: frame.frameNumber,
          width: frame.width,
          height: frame.height,
          proxyPath,
          recipe: frame.recipe,
          lut: frame.recipe.grade.lutId ? await loadLutById(frame.recipe.grade.lutId).then(serializeCubeLut).catch(() => undefined) : undefined,
        });
      }
      const pages = paginateContactSheet(preparedFrames, config);
      for (const [pageIndex, pageFrames] of pages.entries()) {
        const outputPath = resolveContactSheetOutputPath(directory, roll.name, config.format, reserved, {
          index: pageIndex + 1,
          total: pages.length,
        });
        job.outputPaths.push(outputPath);
        rolls.push({
          name: pages.length > 1 ? `${roll.name} · ${pageIndex + 1}/${pages.length}` : roll.name,
          filmType: roll.filmType,
          filmStock: roll.filmStock,
          iso: roll.iso,
          camera: roll.camera,
          shotDate: roll.shotDate,
          outputPath,
          frames: pageFrames,
        });
      }
    }
    if (job.cancelled) return;
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'contact-sheet.worker.js'), {
      workerData: { jobId, config, rolls },
    });
    job.worker = worker;
    worker.on('message', (message: {
      type?: string;
      done?: number;
      total?: number;
      currentName?: string;
      cancelled?: boolean;
      fatal?: string;
      errors?: ExportProgress['errors'];
    }) => {
      if (job.settled) return;
      if (message.type === 'progress') {
        emitContactSheetProgress({
          jobId,
          taskKind: 'contact-sheet',
          done: message.done ?? 0,
          total: message.total ?? job.total,
          currentName: message.currentName,
          status: 'running',
          errors: message.errors ?? [],
          outputDirectory: directory,
        });
        return;
      }
      if (message.type !== 'result') return;
      job.settled = true;
      contactSheetJobs.delete(jobId);
      void worker.terminate();
      if (!message.cancelled && !message.fatal) recordMainTiming('contact-sheet.total', Date.now() - startedAt, { frames: job.total });
      emitContactSheetProgress({
        jobId,
        taskKind: 'contact-sheet',
        done: message.cancelled || message.fatal ? 0 : job.total,
        total: job.total,
        status: message.cancelled ? 'cancelled' : message.fatal ? 'failed' : 'completed',
        errors: message.fatal ? [{ frameId: '', name: '接触印样', message: message.fatal }] : message.errors ?? [],
        outputDirectory: directory,
        currentName: message.fatal ?? (message.cancelled ? '接触印样已取消' : '接触印样已安全写入'),
      });
    });
    worker.once('error', (error) => {
      if (job.settled) return;
      job.settled = true;
      contactSheetJobs.delete(jobId);
      void cleanupContactSheetOutputs(job);
      emitContactSheetProgress({
        jobId, taskKind: 'contact-sheet', done: 0, total: job.total, status: 'failed', outputDirectory: directory,
        errors: [{ frameId: '', name: '接触印样', message: error.message }], currentName: error.message,
      });
    });
  } catch (error) {
    if (job.settled || job.cancelled) return;
    job.settled = true;
    contactSheetJobs.delete(jobId);
    await cleanupContactSheetOutputs(job);
    const message = error instanceof Error ? error.message : String(error);
    emitContactSheetProgress({
      jobId, taskKind: 'contact-sheet', done: 0, total: job.total, status: 'failed', outputDirectory: directory,
      errors: [{ frameId: '', name: '接触印样', message }], currentName: message,
    });
  }
}

let srgbIccCache: Promise<Buffer> | undefined;

/** Lazily builds and caches the sRGB ICC profile used for 16-bit PNG encoding. */
function getSrgbIcc(): Promise<Buffer> {
  if (!srgbIccCache) {
    srgbIccCache = (async () => {
      const carrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
        .withIccProfile('srgb').png().toBuffer();
      const profile = (await sharp(carrier).metadata()).icc;
      if (!profile) throw new Error('无法生成 sRGB ICC 配置文件');
      return profile;
    })();
    // Do not cache rejections: a single sharp hiccup (OOM, libvips state,
    // OS update) would otherwise poison every later 16-bit export for the
    // whole session. Reset the cache so the next job retries the build.
    srgbIccCache.catch(() => {
      srgbIccCache = undefined;
    });
  }
  return srgbIccCache;
}

// ===== ENG-03: export worker pool =====
// A small set of resident workers replaces per-frame spawn/terminate. Each
// worker keeps its libvips context warm; tasks are queued when all workers
// are busy. On any worker crash the slot is replaced with a fresh worker and
// the affected job is retried once (fallback path mirrors the old behavior).
const EXPORT_POOL_SIZE = Math.max(1, Math.min(3, Number(process.env.EXPORT_POOL_SIZE) || 3));

interface ExportPoolWorker {
  worker: Worker;
  busy: boolean;
  currentJobId?: string;
  failed?: boolean;
}

interface ExportPoolTask {
  jobId: string;
  parentJobId: string;
  task: ExportWorkerInput;
  resolve: () => void;
  reject: (error: Error) => void;
}

const exportPool: ExportPoolWorker[] = [];
const exportPoolQueue: ExportPoolTask[] = [];
const exportPoolInFlight = new Map<string, { task: ExportPoolTask; slot: ExportPoolWorker }>();
const exportPoolJobByWorker = new WeakMap<Worker, string>();
let exportPoolShuttingDown = false;

function removePoolSlot(slot: ExportPoolWorker): void {
  const index = exportPool.indexOf(slot);
  if (index >= 0) exportPool.splice(index, 1);
}

function settlePoolJob(jobId: string, error?: Error): boolean {
  const active = exportPoolInFlight.get(jobId);
  if (!active) return false;
  exportPoolInFlight.delete(jobId);
  exportPoolJobByWorker.delete(active.slot.worker);
  active.slot.busy = false;
  active.slot.currentJobId = undefined;
  if (error) active.task.reject(error); else active.task.resolve();
  pumpExportPool();
  return true;
}

function failPoolWorker(slot: ExportPoolWorker, error: Error, terminate = true): void {
  if (slot.failed) return;
  slot.failed = true;
  const jobId = slot.currentJobId ?? exportPoolJobByWorker.get(slot.worker);
  if (jobId) {
    const active = exportPoolInFlight.get(jobId);
    exportPoolInFlight.delete(jobId);
    exportPoolJobByWorker.delete(slot.worker);
    // Never let a downstream reject handler crash the main process.
    try { active?.task.reject(error); }
    catch (rejectError) { console.warn('Chromik: 导出任务 reject 异常', rejectError); }
  }
  slot.busy = false;
  slot.currentJobId = undefined;
  removePoolSlot(slot);
  if (terminate) { try { void slot.worker.terminate(); } catch { /* already exited */ } }
  if (!exportPoolShuttingDown) pumpExportPool();
}

function createPoolWorker(): ExportPoolWorker {
  const workerPath = path.join(__dirname, '..', 'workers', 'export.worker.js');
  const worker = new Worker(workerPath, { workerData: {} });
  const slot: ExportPoolWorker = { worker, busy: false };
  worker.on('message', (message: { type: string; jobId: string; error?: string }) => {
    if (message?.type !== 'done') return;
    settlePoolJob(message.jobId, message.error ? new Error(message.error) : undefined);
  });
  worker.on('error', (error) => failPoolWorker(slot, new Error(`导出工作线程异常退出：${error.message}`)));
  worker.on('exit', (code) => {
    if (exportPoolShuttingDown || slot.failed) return;
    failPoolWorker(slot, new Error(code === 0 ? '导出工作线程提前退出' : `导出工作线程异常退出（代码 ${code}）`), false);
  });
  return slot;
}

function pumpExportPool(): void {
  if (exportPoolShuttingDown) return;
  while (exportPool.length < EXPORT_POOL_SIZE) exportPool.push(createPoolWorker());
  while (exportPoolQueue.length) {
    const idle = exportPool.find((slot) => !slot.busy && !slot.failed);
    if (!idle) return;
    const next = exportPoolQueue.shift()!;
    idle.busy = true;
    idle.currentJobId = next.jobId;
    exportPoolJobByWorker.set(idle.worker, next.jobId);
    exportPoolInFlight.set(next.jobId, { task: next, slot: idle });
    try {
      idle.worker.postMessage({ type: 'task', jobId: next.jobId, task: next.task });
    } catch (error) {
      failPoolWorker(idle, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function shutdownExportPool(): void {
  exportPoolShuttingDown = true;
  const error = new Error('应用正在退出，导出任务已停止');
  for (const task of exportPoolQueue.splice(0)) task.reject(error);
  for (const { task } of exportPoolInFlight.values()) task.reject(error);
  exportPoolInFlight.clear();
  for (const slot of exportPool) void slot.worker.terminate();
  exportPool.length = 0;
}

function runExportWorker(task: ExportWorkerInput, parentJobId = 'standalone'): Promise<void> {
  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    // Hard safety net: a stuck worker must not hang the whole export forever.
    // BUG-023：超大 TIFF/慢盘上 180 秒硬超时会误杀合法任务；按源文件大小
    // 上调时限（每 256 MiB 增加 5 分钟，上限 30 分钟）。
    let sourceBytes = 0;
    try { sourceBytes = statSync(task.sourcePath).size; } catch { /* 缺失源文件由 worker 报错 */ }
    const timeoutMs = Math.min(1_800_000, Math.max(180_000, 180_000 + Math.floor(sourceBytes / (256 * 1024 * 1024)) * 300_000));
    const timeout = setTimeout(() => {
      const index = exportPoolQueue.findIndex((item) => item.jobId === jobId);
      if (index >= 0) {
        const [queued] = exportPoolQueue.splice(index, 1);
        queued.reject(new Error('导出任务超时，已跳过该张'));
        pumpExportPool();
        return;
      }
      const active = exportPoolInFlight.get(jobId);
      if (active) {
        exportPoolInFlight.delete(jobId);
        exportPoolJobByWorker.delete(active.slot.worker);
        active.slot.busy = false;
        active.slot.currentJobId = undefined;
        active.task.reject(new Error('导出任务超时，已终止该张'));
        failPoolWorker(active.slot, new Error('导出工作线程超时'), true);
      }
    }, timeoutMs);
    exportPoolQueue.push({
      jobId,
      parentJobId,
      task,
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    pumpExportPool();
  });
}

async function renderFullResolutionProof(frameId: string, recipe: EditRecipe): Promise<{ url: string; width: number; height: number }> {
  const frame = storage.getFrame(frameId);
  if (!frame || frame.status !== 'ready') throw new Error('找不到可检查的画面');
  if (!existsSync(frame.sourcePath)) throw new Error('原图已移动，请先重新定位');
  const rawSource = isRawPath(frame.sourcePath) && Boolean(frame.assetId);
  const sourcePath = rawSource ? rawCachePath(frame.assetId!) : frame.sourcePath;
  if (!existsSync(sourcePath)) throw new Error('RAW 高位深缓存缺失，请重新导入这个原始文件');
  const sourceStats = await fs.stat(sourcePath);
  const cacheKey = createHash('sha256').update(JSON.stringify({
    version: 4,
    frameId,
    sourceSize: sourceStats.size,
    sourceModified: sourceStats.mtimeMs,
    recipe,
  })).digest('hex').slice(0, 24);
  const outputPath = path.join(proofPreviewDirectory(), `${frameId}-${cacheKey}.jpg`);
  let job = proofPreviewJobs.get(cacheKey);
  if (!job) {
    job = (async () => {
      await fs.mkdir(proofPreviewDirectory(), { recursive: true });
      if (!existsSync(outputPath)) {
        const sourceDescriptor: MasterSourceDescriptor = {
          role: 'master',
          transfer: rawSource ? await rawMasterTransfer(frame.assetId!) : recipe.density.profileId === 'linear_raw' ? 'linear' : 'srgb',
          bitDepth: 16,
          channels: 3,
          colorSpace: 'srgb',
          decoder: rawSource ? 'chromik-cache' : isHeicPath(sourcePath) ? 'heic' : 'sharp',
        };
        await runExportWorker({
          sourcePath,
          outputPath,
          sourceDescriptor,
          recipe,
          config: {
            directory: proofPreviewDirectory(),
            format: 'jpeg',
            quality: 100,
            suffix: '',
            bitDepth: 8,
            resizeMode: 'original',
            width: 1,
            height: 1,
            lockAspect: true,
            allowUpscale: false,
            sharpening: 0,
            colorSpace: 'srgb',
            conflictPolicy: 'rename',
            borderPadding: 0,
          },
          lut: recipe.grade.lutId ? await loadLutById(recipe.grade.lutId).then(serializeCubeLut) : undefined,
          srgbIcc: await getSrgbIcc().catch(() => undefined),
          displayTransform: rawSource && !recipe.density.enabled ? await rawDisplayTransform(frame.assetId!) : undefined,
        }, `proof:${frameId}`);
      }
      return outputPath;
    })().finally(() => proofPreviewJobs.delete(cacheKey));
    proofPreviewJobs.set(cacheKey, job);
  }
  const filePath = await job;
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('全分辨率检查图尺寸无效');
  const token = randomUUID();
  const now = Date.now();
  for (const [existingToken, entry] of proofPreviewReadTokens) {
    if (entry.expiresAt < now) proofPreviewReadTokens.delete(existingToken);
  }
  proofPreviewReadTokens.set(token, { filePath, expiresAt: now + 10 * 60_000 });
  return { url: `app-media://proof/${token}`, width: metadata.width, height: metadata.height };
}

async function cleanupExportTemporaryFiles(outputPath: string): Promise<void> {
  const directory = path.dirname(outputPath);
  const prefix = `${path.basename(outputPath)}.filmlab-`;
  try {
    const names = await fs.readdir(directory);
    await Promise.all(names.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => fs.rm(path.join(directory, name), { force: true })));
  } catch {
    // The directory may have disappeared while cancelling; there is no user
    // output to preserve in that case.
  }
}

function cancelExportPoolTasks(parentJobId: string): void {
  const cancellation = new Error('导出已取消');
  for (let index = exportPoolQueue.length - 1; index >= 0; index -= 1) {
    const task = exportPoolQueue[index];
    if (task.parentJobId !== parentJobId) continue;
    exportPoolQueue.splice(index, 1);
    task.reject(cancellation);
  }
  for (const [workerJobId, active] of [...exportPoolInFlight.entries()]) {
    if (active.task.parentJobId !== parentJobId) continue;
    exportPoolInFlight.delete(workerJobId);
    exportPoolJobByWorker.delete(active.slot.worker);
    active.task.reject(cancellation);
    active.slot.failed = true;
    active.slot.busy = false;
    active.slot.currentJobId = undefined;
    removePoolSlot(active.slot);
    // P1-02：先请求协作式取消（worker 在阶段边界自行停下并清理），
    // 再硬终止兜底，两者叠加保证临时文件不会残留。
    try { active.slot.worker.postMessage({ type: 'cancel', jobId: workerJobId }); } catch { /* worker already gone */ }
    void active.slot.worker.terminate();
    void cleanupExportTemporaryFiles(active.task.task.outputPath);
  }
  pumpExportPool();
}

function sendExportProgress(progress: ExportProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('export:progress', progress);
}

async function executeExport(jobId: string, frames: FrameSummary[], config: ExportConfig): Promise<void> {
  const exportStartedAt = Date.now();
  const state = exportJobs.get(jobId);
  if (!state) return;
  const progress: ExportProgress = {
    jobId,
    done: 0,
    total: frames.length,
    status: 'running',
    errors: [],
    outputDirectory: config.directory,
  };
  sendExportProgress(progress);
  // Build the sRGB ICC profile once per job; each per-frame worker would
  // otherwise repeat the 1×1 carrier construction (2 sharp operations).
  const use16Bit = config.bitDepth === 16 && config.format !== 'jpeg';
  const srgbIcc = use16Bit ? await getSrgbIcc().catch(() => undefined) : undefined;
  const largestPixels = frames.reduce((maximum, frame) => Math.max(maximum, frame.width * frame.height), 1);
  // Decode + geometry + Float32 graph + encoded output can coexist. Keep the
  // job inside a conservative fraction of physical memory and never exceed
  // the resident worker pool's 1–3 contract.
  const bytesPerTask = largestPixels * 3 * (2 + 2 + 4 + 2);
  const memoryBudget = Math.min(totalmem() * .2, 2.5 * 1024 ** 3);
  const concurrency = Math.max(1, Math.min(EXPORT_POOL_SIZE, 3, Math.floor(memoryBudget / Math.max(1, bytesPerTask))));
  const reservedOutputPaths = new Set<string>();
  let nextIndex = 0;
  let active = 0;
  // BUG-002：重名跳过（conflictPolicy='skip'）要计入进度，否则用户看到
  // “完成 N 张”却少了被跳过的文件。
  let skipped = 0;

  const exportOne = async (frame: FrameSummary) => {
    const frameStartedAt = Date.now();
    active += 1;
    progress.currentName = active > 1 ? `${frame.name}（${active} 张并行）` : frame.name;
    sendExportProgress({ ...progress });
    try {
      if (!existsSync(frame.sourcePath)) throw new Error('原图已移动，请先重新定位');
      const renderSourcePath = isRawPath(frame.sourcePath) && frame.assetId ? rawCachePath(frame.assetId) : frame.sourcePath;
      if (!existsSync(renderSourcePath)) throw new Error('RAW 高位深缓存缺失，请重新导入这个原始文件');
      const rawSource = isRawPath(frame.sourcePath) && frame.assetId;
      // COL-08：非 RAW 输入不再无条件按 sRGB 猜测。用户显式选择
      // “线性 RAW/TIFF 输入”配置（linear_raw）时，主描述符按线性解释，
      // 与密度管线里 inputTransfer 的声明保持一致。
      const declaredLinearInput = !rawSource && frame.recipe.density.profileId === 'linear_raw';
      const sourceDescriptor: MasterSourceDescriptor = {
        role: 'master',
        transfer: rawSource ? await rawMasterTransfer(frame.assetId!) : declaredLinearInput ? 'linear' : 'srgb',
        // The worker promotes every decoded source into the canonical ushort
        // processing domain before invoking the graph.
        bitDepth: 16,
        channels: 3,
        colorSpace: 'srgb',
        decoder: rawSource ? 'chromik-cache' : isHeicPath(renderSourcePath) ? 'heic' : 'sharp',
      };
      const outputPath = resolveUniqueOutputPath(config.directory, frame, config, reservedOutputPaths);
      if (!outputPath) {
        skipped += 1;
        return;
      }
      await runExportWorker({
        sourcePath: renderSourcePath,
        outputPath,
        sourceDescriptor,
        recipe: frame.recipe,
        config,
        lut: frame.recipe.grade.lutId ? await loadLutById(frame.recipe.grade.lutId).then(serializeCubeLut) : undefined,
        srgbIcc,
        // The editor, 100% proof and final positive-RAW export must make the
        // same versioned view-transform decision. Negative development still
        // goes through the shared Float32 graph below.
        displayTransform: rawSource && !frame.recipe.density.enabled && config.format !== 'dng'
          ? await rawDisplayTransform(frame.assetId!)
          : undefined,
      }, jobId);
    } catch (error) {
      if (!state.cancelled) progress.errors.push({ frameId: frame.id, name: frame.name, message: error instanceof Error ? error.message : String(error) });
    } finally {
      recordMainTiming('export.frame', Date.now() - frameStartedAt);
      active -= 1;
      progress.done += 1;
      if (skipped > 0) progress.skipped = skipped;
      sendExportProgress({ ...progress });
    }
  };

  const workerLoop = async () => {
    while (!state.cancelled) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= frames.length) return;
      await exportOne(frames[index]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  if (state.cancelled) {
    progress.status = 'cancelled';
    progress.currentName = undefined;
    sendExportProgress({ ...progress });
    exportJobs.delete(jobId);
    return;
  }
  progress.status = progress.errors.length === frames.length ? 'failed' : 'completed';
  recordMainTiming('export.job', Date.now() - exportStartedAt, { frames: frames.length, concurrency });
  progress.currentName = undefined;
  sendExportProgress({ ...progress });
  exportJobs.delete(jobId);
}

function backupsDirectory(): string {
  return path.join(app.getPath('userData'), 'backups');
}

const RELOCATABLE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.heif', '.hif', ...RAW_EXTENSIONS,
]);

async function collectRelocationCandidates(root: string, limit = 25_000): Promise<Map<string, string[]>> {
  const byName = new Map<string, string[]>();
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= limit) throw new Error(`文件夹超过 ${limit.toLocaleString()} 个项目，请选择更接近原片的目录`);
      visited += 1;
      const itemPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(itemPath);
      else if (entry.isFile() && RELOCATABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const key = entry.name.toLocaleLowerCase();
        byName.set(key, [...(byName.get(key) ?? []), itemPath]);
      }
    }
  }
  return byName;
}

async function relocateMissingSourcesFromRoot(root: string): Promise<import('../shared/types').SourceRelocationResult> {
  const references = storage.listSourceReferences().filter((item) => !existsSync(item.sourcePath));
  const candidates = await collectRelocationCandidates(root);
  const result: import('../shared/types').SourceRelocationResult = { root, matched: 0, assets: 0, frames: 0, unmatched: [] };
  for (const reference of references) {
    const sameName = candidates.get(path.basename(reference.sourcePath).toLocaleLowerCase()) ?? [];
    const expectedSize = fingerprintSize(reference.sourceFingerprint) ?? reference.fileSize;
    const sameSize: string[] = [];
    for (const candidate of sameName) {
      if ((await fs.stat(candidate).catch(() => undefined))?.size === expectedSize) sameSize.push(candidate);
    }
    let matchedPath: string | undefined;
    let matchedFingerprint: string | undefined;
    if (isStrongSourceFingerprint(reference.sourceFingerprint)) {
      for (const candidate of sameSize) {
        const fingerprint = await fingerprintSource(candidate);
        if (fingerprint === reference.sourceFingerprint) {
          if (matchedPath) {
            matchedPath = undefined;
            break;
          }
          matchedPath = candidate;
          matchedFingerprint = fingerprint;
        }
      }
    } else if (sameSize.length === 1) {
      // Legacy rows only stored size+mtime. A unique same-name/same-size file
      // is accepted once, then upgraded to the strong v2 fingerprint.
      matchedPath = sameSize[0];
      matchedFingerprint = await fingerprintSource(matchedPath);
    }
    if (!matchedPath || !matchedFingerprint) {
      result.unmatched.push({
        name: reference.displayName,
        previousPath: reference.sourcePath,
        reason: sameName.length === 0 ? '新目录中没有同名文件' : '没有唯一且校验一致的候选文件',
      });
      continue;
    }
    const updated = storage.relocateSource(reference.sourcePath, matchedPath, reference.sourceFingerprint, matchedFingerprint);
    result.matched += 1;
    result.assets += updated.assets;
    result.frames += updated.frames;
  }
  return result;
}

async function cleanRebuildableCache(): Promise<import('../shared/types').CacheMaintenanceResult> {
  let removedFiles = 0;
  let reclaimedBytes = 0;
  const removedTrackedPaths: string[] = [];
  const directories = [
    { path: path.join(app.getPath('userData'), 'cache', 'develop'), accepts: (name: string) => name.endsWith('.chpx') || name.endsWith('.tmp') },
    { path: proofPreviewDirectory(), accepts: (name: string) => name.endsWith('.jpg') || name.endsWith('.tmp') },
    // DATA-04：HDR 合并缓存与分析代理同样可重建，纳入清理范围。
    { path: path.join(app.getPath('userData'), 'cache', 'merged'), accepts: (name: string) => name.endsWith('.tiff') || name.endsWith('.tmp') },
    { path: path.join(app.getPath('userData'), 'cache', 'assets'), accepts: (name: string) => name.endsWith('-analysis.jpg') || name.includes('-display-v') || name.endsWith('.tmp') },
  ];
  for (const directory of directories) {
    if (existsSync(directory.path)) {
      for (const entry of await fs.readdir(directory.path, { withFileTypes: true })) {
        if (!entry.isFile() || !directory.accepts(entry.name)) continue;
        const filePath = path.join(directory.path, entry.name);
        const stats = await fs.stat(filePath).catch(() => undefined);
        await fs.rm(filePath, { force: true });
        removedFiles += 1;
        reclaimedBytes += stats?.size ?? 0;
        if (entry.name.endsWith('.chpx')) removedTrackedPaths.push(filePath);
      }
    }
  }
  // 簿记与文件同清，避免 cache_state 残留指向已删除缓存的孤儿记录。
  storage.deleteCacheStates(removedTrackedPaths);
  processedThumbnailCache.clear();
  developProxyJobs.clear();
  validatedDevelopProxies.clear();
  proofPreviewJobs.clear();
  proofPreviewReadTokens.clear();
  return { removedFiles, reclaimedBytes, message: '已清理可重建的开发代理与全分辨率检查图；打开画面时会按需重新生成' };
}

function currentBackupService(): BackupService {
  const databasePath = storage.databasePath;
  return new BackupService({
    backupsDirectory: backupsDirectory(),
    lutDirectory: lutDirectory(),
    appVersion: app.getVersion(),
    databasePath: () => databasePath,
    sourcePaths: () => storage.listSourceReferences().map((item) => item.sourcePath),
    checkpoint: () => storage.checkpoint(),
    close: () => storage.close(),
    reopen: () => { storage = new Storage(databasePath); },
    clearLutCache: () => lutCache.clear(),
  });
}

async function detectSprocketsForAsset(assetId: string): Promise<{ top: SprocketInfo[]; bottom: SprocketInfo[] }> {
  const asset = storage.getAsset(assetId);
  if (!asset) return { top: [], bottom: [] };
  const proxy = await loadAssetDevelopProxy(assetId);
  if (!(proxy.data instanceof Uint16Array)) return { top: [], bottom: [] };
  const resized = downscaleLinearProxy16(proxy.data, proxy.width, proxy.height, 2048);
  const normalize = (holes: SprocketRegion[]): SprocketInfo[] => holes.map((hole) => ({
    x: hole.x / resized.width,
    y: hole.y / resized.height,
    width: hole.width / resized.width,
    height: hole.height / resized.height,
  }));
  return {
    top: normalize(detectSprocketHoles(resized.data16, resized.width, resized.height, 3, 'top', 65535)),
    bottom: normalize(detectSprocketHoles(resized.data16, resized.width, resized.height, 3, 'bottom', 65535)),
  };
}

function registerIpc(): void {
  ipcMain.handle('data:recovery-issues', (event) => {
    assertTrustedSender(event);
    // DATA-01：损坏配方自动回退的可观测性出口（设置页展示）。
    return { count: storage.recoveryIssueCount(), issues: storage.listRecoveryIssues() };
  });
  ipcMain.handle('app:info', (event) => {
    assertTrustedSender(event);
    // REL-04：版本号唯一来源。
    return { version: app.getVersion(), packaged: app.isPackaged };
  });
  ipcMain.handle('app:open-release-url', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { url } = z.object({ url: z.string().url().startsWith('https://') }).parse(input);
    await shell.openExternal(url);
  });
  ipcMain.handle('roll:list', (event) => {
    assertTrustedSender(event);
    return storage.listRolls();
  });
  ipcMain.handle('roll:create', (event, input: unknown) => {
    assertTrustedSender(event);
    const rollInput = rollInputSchema.parse(input) as RollInput;
    const rollId = randomUUID();
    storage.createRoll(rollId, rollInput, Date.now());
    return storage.getRoll(rollId);
  });
  ipcMain.handle('roll:update', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ rollId: z.string().uuid(), data: rollInputSchema }).parse(input);
    storage.updateRoll(parsed.rollId, parsed.data as RollInput);
    return storage.getRoll(parsed.rollId);
  });
  ipcMain.handle('roll:delete', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { rollId } = z.object({ rollId: z.string().uuid() }).parse(input);
    const roll = storage.getRoll(rollId);
    if (!roll) return { cancelled: false, deleted: false };
    const frameDevelopPaths = storage.listFrames(rollId).map((frame) => frameDevelopProxyPath(frame.id));
    const rawPaths = storage.listAssets(rollId).flatMap((asset) => [
      rawCachePath(asset.id), rawCacheMetaPath(asset.id), developProxyPath(asset.id),
      rawAnalysisPreviewPath(asset.id), rawDisplayMarkerPath(asset.id), mergedCachePath(asset.id),
    ]);
    const cachePaths = storage.deleteRoll(rollId);
    storage.deleteCacheStates([...rawPaths, ...frameDevelopPaths]);
    try { await removeCachePaths([...cachePaths, ...rawPaths, ...frameDevelopPaths]); }
    catch (cleanupError) {
      console.warn('Chromik: 胶卷缓存清理失败，可在设置中执行“清理可重建缓存”', cleanupError);
    }
    return { cancelled: false, deleted: true };
  });
  ipcMain.handle('roll:recognize-edge', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { rollId, assetId, apply } = z.object({
      rollId: z.string().uuid(), assetId: z.string().uuid().optional(), apply: z.boolean().default(true),
    }).parse(input);
    const roll = storage.getRoll(rollId);
    if (!roll) throw new Error('找不到胶卷');
    const source = assetId ? storage.getAsset(assetId) : storage.listAssets(rollId).find((asset) => asset.status === 'ready');
    if (source && source.rollId !== rollId) throw new Error('所选原始素材不属于当前胶卷');
    if (!source || source.status !== 'ready') {
      storage.setRecognitionError(rollId, '没有可用的素材：请先添加能看到片基边缘文字的原始素材');
      throw new Error('请先向胶卷添加可读取、包含片基边缘文字的原始素材');
    }
    try {
      const analysisImage = await assetDevelopAnalysisPng(source.id);
      const result = await recognizeFilmEdge(analysisImage, path.join(app.getPath('userData'), 'cache'));
      const next: RollInput = {
        name: roll.name,
        filmType: result.detected.filmType ?? roll.filmType,
        camera: roll.camera,
        lens: roll.lens,
        filmStock: result.detected.filmStock ?? roll.filmStock,
        iso: result.detected.iso ?? roll.iso,
        development: roll.development,
        shotDate: roll.shotDate,
        notes: roll.notes,
      };
      if (apply && Object.keys(result.detected).length) storage.updateRoll(rollId, next, result.text);
      storage.setRecognitionError(rollId, '');
      return { ...result, roll: storage.getRoll(rollId)! };
    } catch (error) {
      // AUTO-06：识别失败不改变配方，原因持久化并返回给 UI 提示下一步。
      const message = error instanceof Error ? error.message : String(error);
      storage.setRecognitionError(rollId, message);
      return { detected: {}, text: '', confidence: 0, error: message, roll: storage.getRoll(rollId)! };
    }
  });
  ipcMain.handle('roll:detect-film-type', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { rollId, assetId, apply } = z.object({
      rollId: z.string().uuid(), assetId: z.string().uuid().optional(), apply: z.boolean().default(true),
    }).parse(input);
    const roll = storage.getRoll(rollId);
    if (!roll) throw new Error('找不到胶卷');
    const source = assetId ? storage.getAsset(assetId) : storage.listAssets(rollId).find((asset) => asset.status === 'ready');
    if (source && source.rollId !== rollId) throw new Error('所选原始素材不属于当前胶卷');
    if (!source || source.status !== 'ready') {
      storage.setRecognitionError(rollId, '没有可用的素材：请先添加一张能看到片基边缘的原始素材');
      throw new Error('请先添加一张能看到片基边缘的原始素材');
    }
    try {
      const proxy = await loadAssetDevelopProxy(source.id);
      const estimate = classifyFilmPixels(proxy.data, proxy.width, proxy.height, proxy.channels, proxy.bitDepth === 16 ? 65535 : 255);
      if (apply && estimate.filmType !== 'unknown') {
        storage.updateRoll(rollId, {
          name: roll.name, filmType: estimate.filmType, camera: roll.camera, lens: roll.lens,
          filmStock: roll.filmStock, iso: roll.iso, development: roll.development,
          shotDate: roll.shotDate, notes: roll.notes,
        });
      }
      storage.setRecognitionError(rollId, estimate.filmType === 'unknown' ? '片种识别置信度不足，已保持原设置；请手动选择片种' : '');
      return { ...estimate, roll: storage.getRoll(rollId)! };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storage.setRecognitionError(rollId, message);
      return { filmType: 'unknown' as const, confidence: 0, error: message, roll: storage.getRoll(rollId)! };
    }
  });
  ipcMain.handle('roll:save-calibration', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ rollId: z.string().uuid(), calibration: calibrationSchema }).parse(input);
    const updatedFrameIds = storage.saveRollCalibration(parsed.rollId, parsed.calibration as RollCalibration);
    return { updatedFrames: updatedFrameIds.length, updatedFrameIds, roll: storage.getRoll(parsed.rollId)! };
  });
  ipcMain.handle('asset:list', (event, input: unknown) => {
    assertTrustedSender(event);
    const { rollId } = z.object({ rollId: z.string().uuid() }).parse(input);
    return storage.listAssets(rollId);
  });
  ipcMain.handle('asset:import-dialog', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ rollId: z.string().uuid() }).parse(input);
    const qaRawCorpus = !app.isPackaged ? process.env.FILMLAB_QA_RAW_CORPUS_DIR : undefined;
    const result = qaRawCorpus ? {
      canceled: false,
      filePaths: (await fs.readdir(path.resolve(qaRawCorpus)))
        .filter((name) => isRawPath(name))
        .sort()
        .map((name) => path.join(path.resolve(qaRawCorpus), name)),
    } : await dialog.showOpenDialog(mainWindow!, {
      title: '向当前胶卷添加原始素材',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '高分辨率图像与相机 RAW', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'heic', 'heif', 'hif', '3fr', 'arw', 'cr2', 'cr3', 'dng', 'fff', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'x3f'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { cancelled: true, rollId: parsed.rollId, imported: 0, errors: [] };
    const selectedPaths = result.filePaths.map((filePath) => path.resolve(filePath));
    const duplicates = await findImportDuplicates(selectedPaths);
    if (duplicates.length) {
      const id = randomUUID();
      pendingDuplicateImports.set(id, {
        rollId: parsed.rollId,
        filePaths: selectedPaths,
        duplicatePaths: new Set(duplicates.map((item) => item.sourcePath)),
        expiresAt: Date.now() + 10 * 60_000,
      });
      return {
        cancelled: false,
        rollId: parsed.rollId,
        imported: 0,
        errors: [],
        pendingDuplicates: { id, items: duplicates },
      };
    }
    return continueSelectedImport(parsed.rollId, selectedPaths);
  });
  ipcMain.handle('asset:resolve-duplicates', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ id: z.string().uuid(), policy: z.enum(['skip', 'reference']) }).parse(input);
    const pending = pendingDuplicateImports.get(parsed.id);
    pendingDuplicateImports.delete(parsed.id);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('重复项确认已过期，请重新选择文件');
    const selected = parsed.policy === 'reference'
      ? pending.filePaths
      : pending.filePaths.filter((filePath) => !pending.duplicatePaths.has(filePath));
    if (!selected.length) {
      return { cancelled: false, rollId: pending.rollId, imported: 0, errors: [] };
    }
    return continueSelectedImport(pending.rollId, selected);
  });
  ipcMain.handle('asset:retry-raw', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      rollId: z.string().uuid(),
      sourcePaths: z.array(z.string().min(1)).min(1).max(100),
    }).parse(input);
    if (!storage.getRoll(parsed.rollId)) throw new Error('找不到要重试导入的胶卷');
    const now = Date.now();
    // Garbage-collect any expired retry authorization so the map cannot
    // grow without bound when a user imports many distinct files over time.
    for (const [path, value] of recentRawRetryPaths) {
      if (value.expiresAt < now) recentRawRetryPaths.delete(path);
    }
    const paths = [...new Set(parsed.sourcePaths.map((sourcePath) => path.resolve(sourcePath)))];
    for (const sourcePath of paths) {
      const authorization = recentRawRetryPaths.get(sourcePath);
      if (!authorization || authorization.rollId !== parsed.rollId || authorization.expiresAt < now || !isRawPath(sourcePath)) {
        recentRawRetryPaths.delete(sourcePath);
        throw new Error('RAW 重试授权已过期，请重新从导入窗口选择文件');
      }
      allowedRawImports.add(sourcePath);
    }
    return Promise.all(paths.map(issueRawImportJob));
  });
  ipcMain.handle('asset:prepare-raw-commit', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      rollId: z.string().uuid(),
      sourcePath: z.string().min(1),
      metadata: rawDecodedMetadataSchema,
    }).parse(input);
    const resolvedSourcePath = path.resolve(parsed.sourcePath);
    if (!allowedRawImports.has(resolvedSourcePath) || !isRawPath(resolvedSourcePath)) throw new Error('请重新从导入窗口选择 RAW 文件');
    const now = Date.now();
    for (const [key, value] of rawCommitTokens) if (value.expiresAt < now) rawCommitTokens.delete(key);
    const token = randomUUID();
    rawCommitTokens.set(token, { ...parsed, sourcePath: resolvedSourcePath, expiresAt: now + 15_000 });
    return token;
  });
  ipcMain.on('asset:commit-raw-port', (event, input: unknown) => {
    // BUG-015：这是 `ipcMain.on` 处理器，任何同步 throw 都会成为主进程
    // 未捕获异常（曾经可直接杀死应用）。校验失败一律通过回执返回渲染层。
    try {
      assertTrustedSender(event);
      const token = z.string().uuid().parse(input);
      const parsed = rawCommitTokens.get(token);
      rawCommitTokens.delete(token);
      if (!parsed || parsed.expiresAt < Date.now()) throw new Error('RAW 提交通道授权已过期');
      const port = event.ports[0];
      if (!port || event.ports.length !== 1) throw new Error('RAW 提交通道无效');
    const resolvedSourcePath = path.resolve(parsed.sourcePath);
    const abortController = new AbortController();
    let finished = false;
    let receivedPixels = false;
    let transferBuffer: ArrayBuffer | undefined;
    let receivedBytes = 0;
    const expectedSamples = parsed.metadata.width * parsed.metadata.height * parsed.metadata.channels;
    const expectedBytes = expectedSamples * (parsed.metadata.bits === 16 ? 2 : 1);
    const safePost = (message: unknown) => {
      if (finished) return;
      try { port.postMessage(message); } catch { /* renderer may have cancelled and closed its peer */ }
    };
    const finish = (message?: unknown) => {
      if (finished) return;
      finished = true;
      transferBuffer = undefined;
      clearTimeout(timeout);
      if (message !== undefined) {
        try { port.postMessage(message); } catch { /* renderer may have cancelled */ }
      }
      port.close();
    };
    let timeout = setTimeout(() => {
      allowedRawImports.delete(resolvedSourcePath);
      finish({ type: 'result', ok: false, message: 'RAW 像素传输握手超时' });
    }, 15_000);
    const armTransferTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        abortController.abort();
        allowedRawImports.delete(resolvedSourcePath);
        finish({ type: 'result', ok: false, message: 'RAW 像素分块传输超时，请重试' });
      }, 300_000);
    };
    port.on('message', (messageEvent) => {
      if (finished) return;
      if (messageEvent.data === 'cancel') {
        abortController.abort();
        allowedRawImports.delete(resolvedSourcePath);
        finish({ type: 'result', ok: false, message: 'RAW 导入已取消' });
        return;
      }
      const payload = messageEvent.data as { type?: unknown; byteLength?: unknown; offset?: unknown; data?: unknown };
      try {
        if (payload?.type === 'begin') {
          if (transferBuffer || receivedPixels || payload.byteLength !== expectedBytes || expectedBytes <= 0 || expectedBytes > 1_500_000_000) {
            throw new Error('RAW 像素传输长度无效');
          }
          transferBuffer = new ArrayBuffer(expectedBytes);
          receivedBytes = 0;
          armTransferTimeout();
          safePost({ type: 'chunk-ready', offset: 0 });
          return;
        }
        if (payload?.type === 'chunk') {
          if (!transferBuffer || receivedPixels || payload.offset !== receivedBytes || !(payload.data instanceof ArrayBuffer)) {
            throw new Error('RAW 像素分块顺序无效');
          }
          const chunk = new Uint8Array(payload.data);
          if (!chunk.byteLength || receivedBytes + chunk.byteLength > expectedBytes || chunk.byteLength > 4 * 1024 * 1024) {
            throw new Error('RAW 像素分块长度无效');
          }
          new Uint8Array(transferBuffer, receivedBytes, chunk.byteLength).set(chunk);
          receivedBytes += chunk.byteLength;
          armTransferTimeout();
          safePost({ type: 'chunk-ready', offset: receivedBytes });
          return;
        }
        if (payload?.type !== 'end') throw new Error('RAW 像素传输消息无效');
        if (!transferBuffer || receivedPixels || receivedBytes !== expectedBytes) throw new Error('RAW 像素传输不完整');
      } catch (error) {
        allowedRawImports.delete(resolvedSourcePath);
        finish({ type: 'result', ok: false, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      receivedPixels = true;
      clearTimeout(timeout);
      const dataBuffer = transferBuffer;
      transferBuffer = undefined;
      void (async () => {
        try {
          const data = parsed.metadata.bits === 16 ? new Uint16Array(dataBuffer) : new Uint8Array(dataBuffer);
          const result = await commitRawAsset(parsed.rollId, parsed.sourcePath, { ...parsed.metadata, data } as RawDecodedImage, {
            signal: abortController.signal,
            onProgress: (stage, elapsedMs) => safePost({ type: 'progress', stage, elapsedMs }),
          });
          finish({ type: 'result', ok: true, result });
        } catch (error) {
          allowedRawImports.delete(resolvedSourcePath);
          finish({ type: 'result', ok: false, message: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    port.on('close', () => {
      if (finished) return;
      abortController.abort();
      allowedRawImports.delete(resolvedSourcePath);
      finished = true;
      clearTimeout(timeout);
    });
      port.start();
      safePost({ type: 'ready' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Chromik: RAW 提交通道校验失败', error);
      // 尽力把失败原因送回渲染层（重复提交/过期 token/坏输入都不会再崩溃主进程）。
      try {
        const fallbackPort = event.ports[0];
        if (fallbackPort) fallbackPort.postMessage({ type: 'result', ok: false, message });
      } catch { /* renderer 可能已关闭对端 */ }
    }
  });
  ipcMain.handle('asset:update-kind', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ assetId: z.string().uuid(), kind: assetKindSchema }).parse(input);
    const asset = storage.getAsset(parsed.assetId);
    if (!asset) throw new Error('找不到要修改的原始素材');
    storage.updateAssetKind(parsed.assetId, parsed.kind as AssetKind);
    const existing = storage.listFramesForAsset(parsed.assetId);
    if (parsed.kind === 'single' && existing.length === 0) {
      await setAssetFrameRegions(parsed.assetId, [{ corners: rectToQuad({ x: 0, y: 0, width: 1, height: 1 }) }]);
    } else if (parsed.kind !== 'single' && existing.length === 1
      && existing[0].recipe.geometry.corners.every((point, index) => {
        const expected = rectToQuad({ x: 0, y: 0, width: 1, height: 1 })[index];
        return Math.abs(point.x - expected.x) < 0.0001 && Math.abs(point.y - expected.y) < 0.0001;
      })) {
      await removeCachePaths(storage.deleteFrames([existing[0].id]));
      storage.deleteCacheStates([frameDevelopProxyPath(existing[0].id)]);
    }
    return { asset: storage.getAsset(parsed.assetId)!, frames: storage.listFramesForAsset(parsed.assetId) };
  });
  ipcMain.handle('asset:delete', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { assetIds } = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(200) }).parse(input);
    const frameDevelopPaths = assetIds.flatMap((id) => storage.listFramesForAsset(id).map((frame) => frameDevelopProxyPath(frame.id)));
    const cachePaths = storage.deleteAssets(assetIds);
    const rawFiles = assetIds.flatMap((id) => [
      rawCachePath(id), rawCacheMetaPath(id), developProxyPath(id),
      rawAnalysisPreviewPath(id), rawDisplayMarkerPath(id), mergedCachePath(id),
    ]);
    storage.deleteCacheStates([...rawFiles, ...frameDevelopPaths]);
    try { await removeCachePaths([...cachePaths, ...rawFiles, ...frameDevelopPaths]); }
    catch (cleanupError) {
      console.warn('Chromik: 素材缓存清理失败，可在设置中执行“清理可重建缓存”', cleanupError);
    }
    return { cancelled: false, deleted: assetIds.length };
  });
  ipcMain.handle('asset:merge-hdr', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ rollId: z.string().uuid(), assetIds: z.array(z.string().uuid()).min(2).max(6) }).parse(input);
    return mergeHdrAssets(parsed.rollId, parsed.assetIds);
  });
  ipcMain.handle('asset:set-frames', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ assetId: z.string().uuid(), regions: z.array(frameRegionSchema).max(240) }).parse(input);
    return { frames: await setAssetFrameRegions(parsed.assetId, parsed.regions as FrameRegionInput[]) };
  });
  ipcMain.handle('frame:list', (event, input: unknown) => {
    assertTrustedSender(event);
    const { rollId } = z.object({ rollId: z.string().uuid().optional() }).parse(input);
    return storage.listFrames(rollId);
  });
  ipcMain.handle('frame:delete', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { frameIds } = z.object({ frameIds: z.array(z.string().uuid()).min(1).max(500) }).parse(input);
    const cachePaths = storage.deleteFrames(frameIds);
    storage.deleteCacheStates(frameIds.map(frameDevelopProxyPath));
    try { await removeCachePaths([...cachePaths, ...frameIds.map(frameDevelopProxyPath)]); }
    catch (cleanupError) {
      console.warn('Chromik: 画面缓存清理失败，可在设置中执行“清理可重建缓存”', cleanupError);
    }
    return { cancelled: false, deleted: frameIds.length };
  });
  ipcMain.handle('frame:save-recipe', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ frameId: z.string().uuid(), recipe: recipeSchema }).parse(input);
    return { savedAt: storage.saveRecipe(parsed.frameId, parsed.recipe as EditRecipe) };
  });
  ipcMain.handle('frame:render-proof', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ frameId: z.string().uuid(), recipe: recipeSchema }).parse(input);
    return renderFullResolutionProof(parsed.frameId, parsed.recipe as EditRecipe);
  });
  ipcMain.handle('frame:copy-recipe', (event, input: unknown) => {
    assertTrustedSender(event);
    const { frameId } = z.object({ frameId: z.string().uuid() }).parse(input);
    return { updated: storage.copyRecipeToRoll(frameId) };
  });
  ipcMain.handle('frame:relocate', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { frameId } = z.object({ frameId: z.string().uuid() }).parse(input);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '重新定位原图',
      properties: ['openFile'],
      filters: [{ name: '支持的图像', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'heic', 'heif'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const frame = storage.getFrame(frameId);
    if (!frame) throw new Error('找不到要重新定位的画面');
    const reference = storage.listSourceReferences().find((item) => item.sourcePath === frame.sourcePath);
    if (!reference) throw new Error('找不到原片校验记录');
    const candidate = path.resolve(result.filePaths[0]);
    const candidateFingerprint = await fingerprintSource(candidate);
    if (isStrongSourceFingerprint(reference.sourceFingerprint)) {
      if (candidateFingerprint !== reference.sourceFingerprint) throw new Error('所选文件与原片哈希不一致；为保护配方，未执行重定位');
    } else if (fingerprintSize(reference.sourceFingerprint) !== fingerprintSize(candidateFingerprint)) {
      throw new Error('所选文件大小与旧原片记录不一致；为保护配方，未执行重定位');
    }
    storage.relocateSource(reference.sourcePath, candidate, reference.sourceFingerprint, candidateFingerprint);
    return { cancelled: false, frame: storage.getFrame(frameId) };
  });
  ipcMain.handle('export:choose-directory', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择导出文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = path.resolve(result.filePaths[0]);
    allowedExportDirectories.add(directory);
    return directory;
  });
  ipcMain.handle('export:start', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ frameIds: z.array(z.string().uuid()).min(1).max(200), config: exportConfigSchema }).parse(input);
    const config = parsed.config as ExportConfig;
    const directory = path.resolve(config.directory);
    if (!allowedExportDirectories.has(directory)) throw new Error('请重新选择导出文件夹');
    const frames = parsed.frameIds.map((id) => storage.getFrame(id)).filter((frame): frame is FrameSummary => Boolean(frame));
    if (frames.length === 0) throw new Error('没有可导出的画面');
    // BUG-002：请求中的无效画面 ID 不能被静默吞掉，至少记录到日志。
    if (frames.length !== parsed.frameIds.length) {
      console.warn(`Chromik: 导出请求中 ${parsed.frameIds.length - frames.length} 个画面已不存在，已跳过`);
    }
    const jobId = randomUUID();
    exportJobs.set(jobId, { cancelled: false });
    void executeExport(jobId, frames, { ...config, directory });
    return { jobId };
  });
  ipcMain.handle('export:cancel', (event, input: unknown) => {
    assertTrustedSender(event);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(input);
    if (cancelContactSheetJob(jobId)) return;
    const job = exportJobs.get(jobId);
    if (job) {
      job.cancelled = true;
      cancelExportPoolTasks(jobId);
    }
  });
  ipcMain.handle('export:authorize-directory', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { directory } = z.object({ directory: z.string().min(1).max(4096) }).parse(input);
    const resolved = path.resolve(directory);
    try {
      if (!(await fs.stat(resolved)).isDirectory()) return false;
      allowedExportDirectories.add(resolved);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('export:contact-sheet', async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      rollIds: z.array(z.string().uuid()).min(1).max(50),
      directory: z.string().min(1),
      config: contactSheetConfigSchema,
    }).parse(input);
    const directory = path.resolve(parsed.directory);
    if (!allowedExportDirectories.has(directory)) throw new Error('请重新选择导出文件夹');
    const uniqueRollIds = [...new Set(parsed.rollIds)];
    const total = uniqueRollIds.reduce((sum, rollId) => sum + storage.listFrames(rollId).length, 0);
    if (!total) throw new Error('所选胶卷中没有画面');
    const jobId = randomUUID();
    contactSheetJobs.set(jobId, { cancelled: false, settled: false, total, outputDirectory: directory, outputPaths: [] });
    emitContactSheetProgress({ jobId, taskKind: 'contact-sheet', done: 0, total, status: 'running', errors: [], outputDirectory: directory, currentName: '正在准备接触印样代理…' });
    void runContactSheetJob(jobId, uniqueRollIds, directory, parsed.config as ContactSheetConfig);
    return { jobId, total };
  });
  ipcMain.handle('shell:show-in-folder', (event, input: unknown) => {
    assertTrustedSender(event);
    const { path: requestedPath } = z.object({ path: z.string().min(1) }).parse(input);
    const resolved = path.resolve(requestedPath);
    if (!allowedExportDirectories.has(resolved)) throw new Error('仅允许打开本次选择的导出文件夹');
    return shell.openPath(resolved);
  });
  ipcMain.handle('lut:list', async (event) => {
    assertTrustedSender(event);
    const directory = lutDirectory();
    await fs.mkdir(directory, { recursive: true });
    const entries = await fs.readdir(directory);
    const luts: Array<{ id: string; title: string; type: '1d' | '3d'; size: number }> = [];
    for (const name of entries) {
      if (!name.endsWith('.cube')) continue;
      const id = name.slice(0, -'.cube'.length);
      if (!z.string().uuid().safeParse(id).success) continue;
      try {
        const lut = await loadLutById(id);
        luts.push({ id, title: lut.title || id, type: lut.type, size: lut.size });
      } catch {
        // Skip unreadable LUT files.
      }
    }
    return luts;
  });
  ipcMain.handle('lut:import', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入 .cube LUT',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Cube LUT', extensions: ['cube'] }],
    });
    if (result.canceled || !result.filePaths.length) return { imported: [] as Array<{ id: string; title: string }> };
    const directory = lutDirectory();
    await fs.mkdir(directory, { recursive: true });
    const imported: Array<{ id: string; title: string }> = [];
    for (const sourcePath of result.filePaths) {
      const stats = await fs.stat(sourcePath);
      if (stats.size > 64 * 1024 * 1024) throw new Error(`${path.basename(sourcePath)} 超过 64 MB，未导入`);
      const text = await fs.readFile(sourcePath, 'utf8');
      const lut = parseCubeLut(text);
      const id = randomUUID();
      const destination = path.join(directory, `${id}.cube`);
      await fs.writeFile(destination, text, { flag: 'wx' });
      lutCache.set(id, lut);
      imported.push({ id, title: lut.title || path.basename(sourcePath, '.cube') });
    }
    return { imported };
  });
  ipcMain.handle('lut:load', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const lut = await loadLutById(id);
    return { id, ...serializeCubeLut(lut) };
  });
  ipcMain.handle('preset:list', (event) => {
    assertTrustedSender(event);
    return storage.listPresets();
  });
  ipcMain.handle('preset:save', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      name: z.string().trim().min(1).max(64),
      grade: recipeSchema.shape.grade,
    }).parse(input);
    return storage.savePreset(parsed.name, parsed.grade as EditRecipe['grade']);
  });
  ipcMain.handle('preset:delete', (event, input: unknown) => {
    assertTrustedSender(event);
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    storage.deletePreset(id);
  });
  ipcMain.handle('frame:paste-recipe', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      frameIds: z.array(z.string().uuid()).min(1).max(500),
      source: recipeSchema,
      scope: z.enum(['all', 'exposure', 'color', 'style', 'curves']),
    }).parse(input);
    return { updated: storage.pasteRecipeToFrames(parsed.frameIds, parsed.source as EditRecipe, parsed.scope as PasteScope) };
  });
  ipcMain.handle('frame:set-meta', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      frameId: z.string().uuid(),
      meta: z.object({ starred: z.boolean().optional(), tags: z.array(z.string().max(64)).max(64).optional() }),
    }).parse(input);
    return storage.setFrameMeta(parsed.frameId, parsed.meta);
  });
  ipcMain.handle('roll:set-meta', (event, input: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({
      rollId: z.string().uuid(),
      meta: z.object({ starred: z.boolean().optional(), tags: z.array(z.string().max(64)).max(64).optional() }),
    }).parse(input);
    return storage.setRollMeta(parsed.rollId, parsed.meta);
  });
  ipcMain.handle('backup:create', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { settingsJson } = z.object({ settingsJson: z.string().max(64 * 1024).optional() }).parse(input ?? {});
    if (settingsJson) JSON.parse(settingsJson);
    return currentBackupService().create(settingsJson);
  });
  ipcMain.handle('backup:list', async (event) => {
    assertTrustedSender(event);
    return currentBackupService().list();
  });
  ipcMain.handle('backup:restore', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { path: requestedPath } = z.object({ path: z.string().min(1).max(4096) }).parse(input);
    const result = await currentBackupService().restore(requestedPath);
    if (result.ok) {
      // BUG-033：恢复替换了数据库文件，主进程侧所有引用旧库内容的缓存
      // 必须立刻清空，否则恢复后用户看到/导出的是旧数据。
      processedThumbnailCache.clear();
      developProxyJobs.clear();
      validatedDevelopProxies.clear();
      proofPreviewJobs.clear();
      proofPreviewReadTokens.clear();
    }
    return result;
  });
  ipcMain.handle('source:relocate-missing', async (event) => {
    assertTrustedSender(event);
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择原片移动后的根文件夹',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return { cancelled: true, matched: 0, assets: 0, frames: 0, unmatched: [] };
    }
    return { cancelled: false, ...await relocateMissingSourcesFromRoot(path.resolve(selection.filePaths[0])) };
  });
  ipcMain.handle('cache:clean-rebuildable', async (event) => {
    assertTrustedSender(event);
    return cleanRebuildableCache();
  });
  ipcMain.handle('asset:sprockets', async (event, input: unknown) => {
    assertTrustedSender(event);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(input);
    return detectSprocketsForAsset(assetId);
  });
}

async function createWindow(): Promise<void> {
  const qaAutomation = !app.isPackaged;
  const initialWidth = Math.max(920, (qaAutomation ? Number(process.env.FILMLAB_QA_WIDTH) : 0) || 1440);
  const initialHeight = Math.max(680, (qaAutomation ? Number(process.env.FILMLAB_QA_HEIGHT) : 0) || 920);
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 920,
    minHeight: 680,
    backgroundColor: '#FFF9E7',
    title: 'Chromik 珂影',
    show: false,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 16, y: 22 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  if (qaAutomation && process.env.FILMLAB_QA_RAW_CORPUS_DIR) {
    mainWindow.webContents.on('console-message', (details) => {
      if (details.message.startsWith('CHROMIK_RAW_DECODE ')
        || details.message.startsWith('CHROMIK_RAW_CACHE ')
        || details.message.startsWith('CHROMIK_RAW_COMMIT_ERROR ')) console.log(details.message);
    });
  }
  mainWindow.on('rotate-gesture', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedRendererUrl = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : pathToFileURL(path.join(__dirname, '..', '..', 'dist')).toString();
  const guardNavigation = (event: Electron.Event, targetUrl: string) => {
    const allowed = process.env.VITE_DEV_SERVER_URL
      ? new URL(targetUrl).origin === allowedRendererUrl
      : targetUrl.startsWith(allowedRendererUrl);
    if (!allowed) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // REL-03：启动时手动检查本地更新清单（version.json），只提示、不自动下载。
  void (async () => {
    try {
      const candidates = updateManifestCandidates(path.dirname(app.getPath('exe')), process.resourcesPath);
      if (!app.isPackaged && process.env.FILMLAB_QA_UPDATE_FILE) candidates.unshift(process.env.FILMLAB_QA_UPDATE_FILE);
      const manifest = await readUpdateManifest(candidates);
      const evaluation = evaluateUpdate(manifest, app.getVersion());
      if (evaluation.available && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update-available', { version: evaluation.version, url: evaluation.url, notes: evaluation.notes });
      }
    } catch (error) {
      console.warn('Chromik: 更新检查失败（不影响使用）', error);
    }
  })();

  // QA automation: development/screenshot hooks only, never active in packaged builds.
  if (qaAutomation) {
  // QA-06 故障注入闭环：截断/改坏/删除开发代理缓存，验证自愈重建。
  // 该 hook 自行写报告并以退出码结束应用，不与截图序列混跑。
  if (process.env.FILMLAB_QA_FAULT_INJECT) {
    void runQaFaultInjection({
      storage,
      ensureDevelopProxy,
      ensureFrameDevelopProxy,
      developProxyPath,
      frameDevelopProxyPath,
      fetchDevelop: async (url) => {
        const response = await net.fetch(url);
        const buffer = await response.arrayBuffer();
        return { status: response.status, bytes: buffer.byteLength };
      },
      reportPath: () => process.env.FILMLAB_QA_FAULT_REPORT ?? path.join(app.getPath('userData'), 'fault-inject-report.json'),
      exit: (code) => app.exit(code),
    });
  }
  // P2：截图/交互 QA 钩子已拆出主窗口生命周期（src/main/qa-automation.ts）。
  runQaAutomation({ mainWindow, quit: () => app.quit(), exit: (code) => app.exit(code), log: (line) => console.log(line) });
  }
}

async function seedQaDemoLibrary(): Promise<void> {
  const rawCorpus = !app.isPackaged && process.env.FILMLAB_QA_RAW_CORPUS_DIR;
  if (app.isPackaged || (!rawCorpus && process.env.FILMLAB_SEED_DEMO !== '1') || storage.listRolls().length) return;
  const rollId = '10000000-0000-4000-8000-000000000001';
  storage.createRoll(rollId, {
    name: rawCorpus ? 'Sony A7M4 QA 回归' : 'QA 示例胶卷', filmType: 'color_negative', camera: rawCorpus ? 'Sony A7M4' : 'Synthetic QA', lens: 'Reference',
    filmStock: 'Generic color negative', iso: 100, development: 'Synthetic', shotDate: '2026-08-24', notes: '仅用于本地界面冒烟测试',
  }, 1);
  if (rawCorpus) return;
  const sourceDirectory = path.join(app.getPath('userData'), 'qa-samples');
  const sourcePath = path.join(sourceDirectory, 'chromik-gradient-negative.png');
  await fs.mkdir(sourceDirectory, { recursive: true });
  if (!existsSync(sourcePath)) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f4a66c"/><stop offset=".48" stop-color="#8f746a"/><stop offset="1" stop-color="#182b48"/></linearGradient></defs>
      <rect width="1600" height="1000" fill="#e6965c"/><rect x="80" y="80" width="1440" height="840" rx="24" fill="url(#g)"/>
      <circle cx="520" cy="470" r="230" fill="#d69066" fill-opacity=".65"/><rect x="850" y="230" width="420" height="520" rx="36" fill="#355372" fill-opacity=".8"/>
    </svg>`);
    const temporary = `${sourcePath}.${randomUUID()}.tmp`;
    await sharp(svg).png({ compressionLevel: 9 }).toFile(temporary);
    await fs.rename(temporary, sourcePath);
  }
  // The segment smoke target needs a multi-frame source so the normal asset
  // workflow opens ManualFramer instead of correctly bypassing it for a
  // single-frame source.
  const demoKind = process.env.FILMLAB_CAPTURE_VIEW === 'segment' ? 'strip' : 'single';
  await importAssetPaths(rollId, [sourcePath], demoKind, 2);
  const requestedFrameCount = Number(process.env.FILMLAB_QA_LIBRARY_COUNT ?? 0);
  const targetFrameCount = Number.isFinite(requestedFrameCount) ? Math.max(1, Math.min(2_000, Math.floor(requestedFrameCount))) : 1;
  const seedFrame = storage.listFrames(rollId)[0];
  if (seedFrame && targetFrameCount > 1) {
    const seedFingerprint = await fingerprintSource(seedFrame.sourcePath);
    for (let index = 1; index < targetFrameCount; index += 1) {
      storage.addFrame({
        id: randomUUID(),
        rollId,
        assetId: seedFrame.assetId,
        name: `QA 虚拟图库 ${String(index + 1).padStart(4, '0')}`,
        sourcePath: seedFrame.sourcePath,
        sourceFingerprint: seedFingerprint,
        width: seedFrame.width,
        height: seedFrame.height,
        format: seedFrame.format,
        fileSize: seedFrame.fileSize,
        previewPath: storage.getFramePaths(seedFrame.id)?.previewPath ?? seedFrame.sourcePath,
        recipe: { ...seedFrame.recipe, updatedAt: seedFrame.recipe.updatedAt + index },
        createdAt: 2 + index,
      });
    }
  }
}

function monitorQaRawCorpus(): void {
  const corpusDirectory = process.env.FILMLAB_QA_RAW_CORPUS_DIR;
  if (app.isPackaged || !corpusDirectory) return;
  const startedAt = Date.now();
  let peakRss = process.memoryUsage().rss;
  // PERF-05/§13.2：分进程峰值内存（Browser/Renderer/GPU/Utility），
  // 回答"A7M4 单张导入峰值 <1.2GB"这一验收项的完整证据。
  const peakWorkingSetByProcess = new Map<string, number>();
  let sawActivity = false;
  const timeoutMs = 30 * 60_000;
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    for (const metric of app.getAppMetrics()) {
      const workingSet = metric.memory?.workingSetSize ?? 0;
      peakWorkingSetByProcess.set(metric.type, Math.max(peakWorkingSetByProcess.get(metric.type) ?? 0, workingSet));
    }
    if (allowedRawImports.size || rawImportReadTokens.size) sawActivity = true;
    if (!sawActivity || allowedRawImports.size || rawImportReadTokens.size) {
      if (Date.now() - startedAt < timeoutMs) return;
    }
    clearInterval(timer);
    void (async () => {
      const expectedNames = (await fs.readdir(path.resolve(corpusDirectory))).filter((name) => isRawPath(name)).sort();
      const roll = storage.listRolls()[0];
      const assets = roll ? storage.listAssets(roll.id) : [];
      const frames = roll ? storage.listFrames(roll.id) : [];
      const results = await Promise.all(assets.map(async (asset) => {
        let proxy: { width?: number; height?: number; bitDepth?: number; transfer?: string; valid: boolean } = { valid: false };
        try {
          const decoded = decodeDevelopProxy(await fs.readFile(developProxyPath(asset.id)));
          proxy = { width: decoded.width, height: decoded.height, bitDepth: decoded.bitDepth, transfer: decoded.transfer, valid: decoded.data instanceof Uint16Array };
        } catch { /* report invalid below */ }
        const rawMeta = await fs.readFile(rawCacheMetaPath(asset.id), 'utf8').then((textValue) => JSON.parse(textValue) as unknown).catch(() => undefined);
        return { name: asset.name, status: asset.status, width: asset.width, height: asset.height, format: asset.format, frameCount: asset.frameCount, proxy, rawMeta };
      }));
      const report = {
        format: 'chromik-sony-raw-regression', version: 2, generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt, peakMainProcessRssBytes: peakRss,
        peakWorkingSetByProcess: Object.fromEntries(peakWorkingSetByProcess),
        expected: expectedNames.length, imported: assets.length, frames: frames.length,
        passed: assets.length === expectedNames.length
          && results.every((item) => item.status === 'ready' && item.proxy.valid && item.proxy.bitDepth === 16 && item.proxy.transfer === 'linear'),
        missing: expectedNames.filter((name) => !assets.some((asset) => asset.name === name)), results,
      };
      const output = path.resolve(process.env.FILMLAB_QA_RAW_REPORT ?? path.join(app.getPath('userData'), 'sony-raw-report.json'));
      await fs.mkdir(path.dirname(output), { recursive: true });
      const temporary = `${output}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporary, output);
      console.log(`CHROMIK_RAW_CORPUS ${JSON.stringify({ output, passed: report.passed, imported: report.imported, expected: report.expected, durationMs: report.durationMs })}`);
      app.quit();
    })().catch((error) => {
      console.error('CHROMIK_RAW_CORPUS_FAILED', error);
      app.exit(1);
    });
  }, 1000);
}

app.whenReady().then(async () => {
  mkdirSync(app.getPath('userData'), { recursive: true });
  // P2：本地崩溃转储（不上传）。崩溃文件放在用户数据目录，供支持时分析。
  crashReporter.start({
    uploadToServer: false,
    submitURL: '',
    productName: 'Chromik',
    companyName: 'Chromik',
    compress: true,
  });
  storage = new Storage(path.join(app.getPath('userData'), 'filmlab.sqlite'));
  await seedQaDemoLibrary();
  protocol.handle('app-media', async (request) => {
    const url = new URL(request.url);
    if (!['frame', 'asset', 'asset-analysis', 'processed', 'develop', 'develop-frame', 'raw-import', 'proof'].includes(url.hostname)) {
      return new Response('Not found', { status: 404 });
    }
    const mediaId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (url.hostname === 'raw-import') {
      // Best-effort GC: drop any tokens that already expired before they
      // pile up across many import sessions.
      const now = Date.now();
      for (const [id, expired] of rawImportReadTokens) {
        if (expired.expiresAt < now) rawImportReadTokens.delete(id);
      }
      const entry = rawImportReadTokens.get(mediaId);
      rawImportReadTokens.delete(mediaId);
      if (!entry || entry.expiresAt < Date.now() || !allowedRawImports.has(entry.sourcePath) || !isRawPath(entry.sourcePath)) {
        return new Response('RAW import token expired', { status: 403 });
      }
      try {
        const stats = await fs.stat(entry.sourcePath);
        if (!stats.isFile() || stats.size > MAX_RAW_IMPORT_BYTES) return new Response('RAW file is not readable', { status: 400 });
        return net.fetch(pathToFileURL(entry.sourcePath).toString());
      } catch {
        return new Response('RAW file is not readable', { status: 404 });
      }
    }
    if (url.hostname === 'proof') {
      const entry = proofPreviewReadTokens.get(mediaId);
      if (!entry || entry.expiresAt < Date.now() || !path.resolve(entry.filePath).startsWith(path.resolve(proofPreviewDirectory()) + path.sep)) {
        proofPreviewReadTokens.delete(mediaId);
        return new Response('Proof preview token expired', { status: 403 });
      }
      if (!existsSync(entry.filePath)) return new Response('Proof preview not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(entry.filePath).toString());
      const body = await response.arrayBuffer();
      return new Response(body, {
        headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=600, immutable' },
      });
    }
    if (url.hostname === 'develop' || url.hostname === 'develop-frame') {
      try {
        const rawAssetId = url.hostname === 'develop'
          ? (storage.getAsset(mediaId) && isRawPath(storage.getAsset(mediaId)!.sourcePath) ? mediaId : undefined)
          : (() => {
            const frame = storage.getFrame(mediaId);
            return frame?.assetId && isRawPath(frame.sourcePath) ? frame.assetId : undefined;
          })();
        const requestedPath = url.hostname === 'develop'
          ? await ensureDevelopProxy(mediaId)
          : await ensureFrameDevelopProxy(mediaId);
        const bytes = await fs.readFile(requestedPath);
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return new Response(body, {
          headers: {
            'Content-Type': DEVELOP_PROXY_MIME,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=31536000, immutable',
            ...(rawAssetId ? { 'X-Chromik-Raw-Display': await rawDisplayTransform(rawAssetId) } : {}),
          },
        });
      } catch (error) {
        console.warn('Chromik: develop proxy failed', mediaId, error);
        return new Response('Develop proxy failed', { status: 500 });
      }
    }
    if (url.hostname === 'processed') {
      const frame = storage.getFrame(mediaId);
      if (!frame || frame.status !== 'ready') return new Response('Not found', { status: 404 });
      try {
        const rendered = await getCachedProcessedThumbnail(frame, request.signal, url.searchParams.get('priority') === 'hero');
        const body = rendered.buffer.slice(rendered.byteOffset, rendered.byteOffset + rendered.byteLength) as ArrayBuffer;
        return new Response(body, {
          headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=31536000, immutable' },
        });
      } catch {
        return new Response('Preview failed', { status: 500 });
      }
    }
    const paths = url.hostname === 'asset' || url.hostname === 'asset-analysis' ? storage.getAssetPaths(mediaId) : storage.getFramePaths(mediaId);
    if (!paths?.previewPath || !existsSync(paths.previewPath)) return new Response('Not found', { status: 404 });
    const requestedPath = url.hostname === 'asset-analysis' && existsSync(rawAnalysisPreviewPath(mediaId)) ? rawAnalysisPreviewPath(mediaId) : paths.previewPath;
    if (url.hostname === 'asset') queueLegacyRawDisplayPreview(mediaId);
    const response = await net.fetch(pathToFileURL(requestedPath).toString());
    const body = await response.arrayBuffer();
    return new Response(body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });
  registerIpc();
  if (!app.isPackaged) {
    if (process.env.FILMLAB_QA_EXPORT_DIRECTORY) {
      const directory = path.resolve(process.env.FILMLAB_QA_EXPORT_DIRECTORY);
      await fs.mkdir(directory, { recursive: true });
      allowedExportDirectories.add(directory);
      const firstRoll = storage.listRolls()[0];
      if (firstRoll) console.log(`contact-sheet=${await createContactSheet(firstRoll.id, directory, {
        style: 'classic', resolution: 'best', columns: 4, showFileName: true, showMetadata: true, title: '', format: 'jpeg',
      })}`);
    }
    if (process.env.FILMLAB_CORPUS_DIR) {
      try {
        await runCorpusValidation(process.env.FILMLAB_CORPUS_DIR);
      } catch (error) {
        console.error('[chromik] corpus validation failed', error);
      }
    }
  }
  await createWindow();
  monitorQaRawCorpus();
});

// On every window close, release the long-running worker pools so a re-open
// via the macOS dock (or the next app launch) does not stack extra native
// threads. Storage stays open because on macOS the process lingers after
// window-all-closed and is reactivated through the activate event; closing
// the SQLite handle here would strand the next window. The before-quit hook
// owns the storage close so genuine Cmd+Q still tears the WAL down cleanly.
let poolsShutdown = false;
function releaseWorkerPools() {
  if (poolsShutdown) return;
  poolsShutdown = true;
  shutdownExportPool();
  shutdownThumbnailPool();
}

app.on('window-all-closed', () => {
  releaseWorkerPools();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  poolsShutdown = false;
  // Restore the per-pool "still serving" flags so a re-opened window on
  // macOS can submit export / thumbnail tasks again. releaseWorkerPools
  // flipped these to true when the last window went away.
  exportPoolShuttingDown = false;
  thumbnailPoolShuttingDown = false;
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  releaseWorkerPools();
  storage?.close();
});
