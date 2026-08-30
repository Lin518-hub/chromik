import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { encodeTiff16 } from '../adapters/tiff16';
import { downscaleLinearProxy16, encodeDevelopProxy } from '../core/develop-proxy';
import {
  linear16ToSrgb8, RAW_DISPLAY_VERSION,
  srgb16ToLinear16, srgb8ToLinear16,
} from '../core/raw-display';
import type { InputTransfer } from '../shared/types';

interface WorkerInput {
  sourcePath: string;
  width: number;
  height: number;
  channels: 3 | 4;
  bits: 8 | 16;
  transfer: InputTransfer;
  dataBuffer: ArrayBuffer;
  paths: {
    raw: string;
    rawMeta: string;
    develop: string;
    analysis: string;
    display: string;
    displayMarker: string;
  };
}

type RawCacheStage = 'validated' | 'proxy' | 'analysis' | 'display' | 'encoded' | 'written';

function report(stage: RawCacheStage, startedAt: number): void {
  parentPort?.postMessage({ type: 'progress', stage, elapsedMs: Date.now() - startedAt });
}

async function atomicWrite(filePath: string, data: Uint8Array | Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, data, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/** P1-02：协作式取消。阶段之间检查，取消后清理全部半成品与临时文件。 */
let cancelled = false;
parentPort?.on('message', (message: { type?: string }) => {
  if (message?.type === 'cancel') cancelled = true;
});

function assertNotCancelled(): void {
  if (cancelled) {
    const error = new Error('RAW 导入已取消');
    error.name = 'AbortError';
    throw error;
  }
}

async function cleanupPartialOutputs(paths: WorkerInput['paths']): Promise<void> {
  const outputs = Object.values(paths);
  await Promise.all(outputs.map((output) => fs.rm(output, { force: true })));
  for (const output of outputs) {
    const directory = path.dirname(output);
    const prefix = `${path.basename(output)}.`;
    try {
      const entries = await fs.readdir(directory);
      await Promise.all(entries.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
        .map((name) => fs.rm(path.join(directory, name), { force: true })));
    } catch { /* 目录可能已被主进程清理 */ }
  }
}

function rgb16(input: WorkerInput): Uint16Array {
  const samples = input.width * input.height * input.channels;
  if (input.bits === 16) {
    const source = new Uint16Array(input.dataBuffer);
    if (source.length !== samples) throw new Error('RAW 16 位像素长度无效');
    if (input.channels === 3) return input.transfer === 'linear' ? source : srgb16ToLinear16(source);
    const rgb = new Uint16Array(input.width * input.height * 3);
    for (let from = 0, to = 0; from < source.length; from += 4, to += 3) {
      rgb[to] = source[from];
      rgb[to + 1] = source[from + 1];
      rgb[to + 2] = source[from + 2];
    }
    return input.transfer === 'linear' ? rgb : srgb16ToLinear16(rgb);
  }

  const source = new Uint8Array(input.dataBuffer);
  if (source.length !== samples) throw new Error('RAW 8 位像素长度无效');
  const rgb = input.channels === 3 ? source : (() => {
    const result = new Uint8Array(input.width * input.height * 3);
    for (let from = 0, to = 0; from < source.length; from += 4, to += 3) {
      result[to] = source[from];
      result[to + 1] = source[from + 1];
      result[to + 2] = source[from + 2];
    }
    return result;
  })();
  if (input.transfer === 'srgb') return srgb8ToLinear16(rgb);
  const linear = new Uint16Array(rgb.length);
  for (let index = 0; index < rgb.length; index += 1) linear[index] = rgb[index] * 257;
  return linear;
}

async function run(input: WorkerInput): Promise<void> {
  const startedAt = Date.now();
  const expectedBytes = input.width * input.height * input.channels * (input.bits === 16 ? 2 : 1);
  if (input.dataBuffer.byteLength !== expectedBytes) throw new Error('RAW Worker 输入长度无效');
  const stats = await fs.stat(input.sourcePath);
  if (!stats.isFile()) throw new Error('RAW 原始文件已移动');
  const linear = rgb16(input);
  report('validated', startedAt);
  assertNotCancelled();
  const aspect = Math.max(input.width / input.height, input.height / input.width);
  const proxy = downscaleLinearProxy16(linear, input.width, input.height, aspect >= 3 ? 4096 : 3072);
  report('proxy', startedAt);
  assertNotCancelled();
  const analysis = await sharp(Buffer.from(linear16ToSrgb8(proxy.data16)), {
    raw: { width: proxy.width, height: proxy.height, channels: 3 },
  }).jpeg({ quality: 89, chromaSubsampling: '4:4:4' }).toBuffer();
  report('analysis', startedAt);
  assertNotCancelled();
  const display = await sharp(Buffer.from(linear16ToSrgb8(proxy.data16)), {
    raw: { width: proxy.width, height: proxy.height, channels: 3 },
  }).jpeg({ quality: 89, chromaSubsampling: '4:4:4' }).toBuffer();
  report('display', startedAt);
  assertNotCancelled();
  const develop = encodeDevelopProxy({
    width: proxy.width, height: proxy.height, channels: 3, bitDepth: 16, transfer: 'linear', data: proxy.data16,
  });
  const raw = encodeTiff16(input.width, input.height, linear, 3, { compression: 'none' });
  report('encoded', startedAt);
  assertNotCancelled();
  await Promise.all([
    // Camera pixels are already close to incompressible. Deflating the master
    // cache strip-by-strip can dominate import for minutes while saving almost
    // no space. Uncompressed 16-bit TIFF stays lossless and decodes faster.
    atomicWrite(input.paths.raw, raw),
    atomicWrite(input.paths.rawMeta, JSON.stringify({ version: 2, transfer: 'linear', colorSpace: 'srgb', bitDepth: 16, decoder: 'libraw-wasm-1.6.0', cameraMatrixPrecision: 'float' })),
    atomicWrite(input.paths.develop, develop),
    atomicWrite(input.paths.analysis, analysis),
    atomicWrite(input.paths.display, display),
    atomicWrite(input.paths.displayMarker, `${RAW_DISPLAY_VERSION}\n`),
  ]);
  report('written', startedAt);
}

void run(workerData as WorkerInput)
  .then(() => parentPort?.postMessage({ type: 'result', ok: true }))
  .catch(async (error) => {
    // BUG-021：取消与任何非取消失败（磁盘满、编码异常）都不能留下半成品：
    // 全部输出路径与 .tmp 一并清理，避免缓存目录出现“成功一半”的状态。
    try { await cleanupPartialOutputs((workerData as WorkerInput).paths); }
    catch { /* 目录可能已被主进程清理 */ }
    parentPort?.postMessage({ type: 'result', ok: false, message: error instanceof Error ? error.message : String(error) });
  });
