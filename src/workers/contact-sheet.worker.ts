import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { decodeDevelopProxy, describeDevelopProxy, downscaleLinearProxy16 } from '../core/develop-proxy';
import { deserializeCubeLut, type SerializedCubeLut } from '../core/cube';
import { applyGeometry } from '../core/geometry';
import { processPixelSource } from '../core/reconstruct';
import { quantizeUint16To8 } from '../core/quantize';
import type { ContactSheetConfig, EditRecipe } from '../shared/types';

interface ContactFrame {
  id: string;
  name: string;
  frameNumber: number;
  width: number;
  height: number;
  proxyPath: string;
  recipe: EditRecipe;
  lut?: SerializedCubeLut;
}

interface ContactRoll {
  name: string;
  filmType: string;
  filmStock: string;
  iso?: number;
  camera: string;
  shotDate: string;
  outputPath: string;
  frames: ContactFrame[];
}

interface WorkerInput {
  jobId: string;
  config: ContactSheetConfig;
  rolls: ContactRoll[];
}

let cancelled = false;
parentPort?.on('message', (message: { type?: unknown }) => {
  if (message?.type === 'cancel') cancelled = true;
});

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/** BUG-017：4 通道代理必须先把 alpha 剥成 3 通道；quantize 会保留 alpha，
 * 而 sharp 按 3 通道解码，直接混用会逐像素错位。 */
function toRgb16(input: Uint16Array, width: number, height: number, channels: number): Uint16Array {
  if (channels === 3) return input;
  const output = new Uint16Array(width * height * 3);
  for (let pixel = 0, from = 0, to = 0; pixel < width * height; pixel += 1, from += 4, to += 3) {
    output[to] = input[from];
    output[to + 1] = input[from + 1];
    output[to + 2] = input[from + 2];
  }
  return output;
}

async function renderFrame(frame: ContactFrame, width: number, height: number, background: string): Promise<Buffer> {
  const proxy = decodeDevelopProxy(await fs.readFile(frame.proxyPath));
  if (!(proxy.data instanceof Uint16Array)) throw new Error(`${frame.name} 的开发代理不是 16 位`);
  const processEdge = Math.min(1600, Math.max(640, Math.ceil(Math.max(width, height) * 1.25)));
  const resized = downscaleLinearProxy16(proxy.data, proxy.width, proxy.height, processEdge);
  const transformed = applyGeometry(resized.data16, resized.width, resized.height, proxy.channels, frame.recipe.geometry);
  const rendered = processPixelSource(transformed.data as Uint16Array, transformed.channels, frame.recipe, describeDevelopProxy(proxy), {
    width: transformed.width,
    height: transformed.height,
    lut: frame.lut ? deserializeCubeLut(frame.lut) : undefined,
  });
  if (!(rendered instanceof Uint16Array)) throw new Error('接触印样处理结果位深无效');
  const rgb = toRgb16(rendered, transformed.width, transformed.height, transformed.channels);
  const converted = quantizeUint16To8(rgb, transformed.width, 3);
  return sharp(Buffer.from(converted.buffer, converted.byteOffset, converted.byteLength), {
    raw: { width: transformed.width, height: transformed.height, channels: 3 },
  }).resize({ width, height, fit: 'contain', background }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, data, { flag: 'wx' });
    if (cancelled) throw new Error('CONTACT_CANCELLED');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function renderRoll(input: WorkerInput, roll: ContactRoll, doneBefore: number, total: number): Promise<Array<{ frameId: string; name: string; message: string }>> {
  const themes = {
    classic: { background: '#FFFDF5', cell: '#171512', text: '#0F172A', muted: '#64748B', accent: '#D89722' },
    darkroom: { background: '#111317', cell: '#050506', text: '#F8FAFC', muted: '#94A3B8', accent: '#EF4444' },
    minimal: { background: '#FFFFFF', cell: '#F8FAFC', text: '#111827', muted: '#6B7280', accent: '#111827' },
  } as const;
  const config = input.config;
  const theme = themes[config.style];
  const scale = config.resolution === 'preview' ? 1 : config.resolution === 'standard' ? 2 : 3;
  const cellWidth = 310 * scale;
  const imageWidth = 280 * scale;
  const imageHeight = 180 * scale;
  const pageMargin = 30 * scale;
  const labelHeight = (config.showFileName || config.showMetadata ? 46 : 10) * scale;
  const cellHeight = 190 * scale + labelHeight;
  const headerHeight = 96 * scale;
  const rows = Math.ceil(roll.frames.length / config.columns);
  const width = config.columns * cellWidth + 40 * scale;
  const height = headerHeight + rows * cellHeight + 28 * scale;
  const composites: sharp.OverlayOptions[] = [];
  const errors: Array<{ frameId: string; name: string; message: string }> = [];

  for (const [index, frame] of roll.frames.entries()) {
    if (cancelled) throw new Error('CONTACT_CANCELLED');
    const left = pageMargin + (index % config.columns) * cellWidth;
    const top = headerHeight + Math.floor(index / config.columns) * cellHeight;
    try {
      composites.push({ input: await renderFrame(frame, imageWidth, imageHeight, theme.cell), left, top });
    } catch (error) {
      errors.push({ frameId: frame.id, name: frame.name, message: error instanceof Error ? error.message : String(error) });
    }
    if (config.showFileName || config.showMetadata) {
      const primary = config.showFileName ? `${String(frame.frameNumber).padStart(2, '0')}  ${escapeXml(frame.name)}` : `Frame ${String(frame.frameNumber).padStart(2, '0')}`;
      const metadata = config.showMetadata ? `${frame.width} × ${frame.height} · ${escapeXml(roll.filmStock || roll.filmType)}` : '';
      composites.push({
        input: Buffer.from(`<svg width="${imageWidth}" height="${42 * scale}"><text x="${2 * scale}" y="${17 * scale}" font-family="Arial, sans-serif" font-size="${13 * scale}" font-weight="700" fill="${theme.text}">${primary}</text><text x="${2 * scale}" y="${35 * scale}" font-family="Arial, sans-serif" font-size="${10 * scale}" fill="${theme.muted}">${metadata}</text></svg>`),
        left,
        top: top + 184 * scale,
      });
    }
    parentPort?.postMessage({ type: 'progress', done: doneBefore + index + 1, total, currentName: `${roll.name} · ${frame.name}`, errors });
  }

  if (cancelled) throw new Error('CONTACT_CANCELLED');
  const title = config.title || roll.name;
  const rollLine = config.showMetadata ? [roll.filmStock, roll.iso ? `ISO ${roll.iso}` : '', roll.camera, roll.shotDate].filter(Boolean).join(' · ') : '';
  const background = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${theme.background}"/><rect x="${30 * scale}" y="${70 * scale}" width="${Math.min(width - 60 * scale, 120 * scale)}" height="${3 * scale}" rx="${1.5 * scale}" fill="${theme.accent}"/><text x="${30 * scale}" y="${38 * scale}" font-family="Arial, sans-serif" font-size="${24 * scale}" font-weight="700" fill="${theme.text}">${escapeXml(title)}</text><text x="${30 * scale}" y="${61 * scale}" font-family="Arial, sans-serif" font-size="${12 * scale}" fill="${theme.muted}">Chromik 珂影 Contact Sheet · ${roll.frames.length} frames${rollLine ? ` · ${escapeXml(rollLine)}` : ''}</text></svg>`);
  let sheet = sharp(background).composite(composites).withIccProfile('srgb');
  sheet = config.format === 'png' ? sheet.png({ compressionLevel: 9 }) : sheet.jpeg({ quality: 92, chromaSubsampling: '4:4:4' });
  await atomicWrite(roll.outputPath, await sheet.toBuffer());
  return errors;
}

async function run(input: WorkerInput): Promise<void> {
  const total = input.rolls.reduce((sum, roll) => sum + roll.frames.length, 0);
  const errors: Array<{ frameId: string; name: string; message: string }> = [];
  let done = 0;
  for (const roll of input.rolls) {
    errors.push(...await renderRoll(input, roll, done, total));
    done += roll.frames.length;
  }
  parentPort?.postMessage({ type: 'result', cancelled: false, errors });
}

void run(workerData as WorkerInput).catch((error) => {
  if (cancelled || (error instanceof Error && error.message === 'CONTACT_CANCELLED')) {
    parentPort?.postMessage({ type: 'result', cancelled: true, errors: [] });
  } else {
    parentPort?.postMessage({ type: 'result', cancelled: false, fatal: error instanceof Error ? error.message : String(error), errors: [] });
  }
});
