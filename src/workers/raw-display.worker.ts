import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import { decodeTiff16 } from '../adapters/tiff16';
import { downscaleLinearProxy16 } from '../core/develop-proxy';
import { liftLinearRawDisplayProxy16, liftRawDisplayProxy16, linear16ToSrgb8, RAW_DISPLAY_VERSION } from '../core/raw-display';

interface WorkerInput {
  rawPath: string;
  rawMetaPath: string;
  currentPreviewPath: string;
  analysisPath: string;
  displayPath: string;
  markerPath: string;
}

async function atomicWrite(filePath: string, data: Buffer | string): Promise<void> {
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

async function run(input: WorkerInput): Promise<void> {
  if (!existsSync(input.analysisPath)) await fs.copyFile(input.currentPreviewPath, input.analysisPath);
  const decoded = decodeTiff16(await fs.readFile(input.rawPath));
  if (!decoded) throw new Error('16 位 RAW 缓存不可读取');
  let linear = false;
  let matrixAware = false;
  try {
    const meta = JSON.parse(await fs.readFile(input.rawMetaPath, 'utf8')) as { transfer?: unknown; version?: unknown; cameraMatrixPrecision?: unknown };
    linear = meta.transfer === 'linear';
    matrixAware = typeof meta.version === 'number' && meta.version >= 2 && meta.cameraMatrixPrecision === 'float';
  } catch { /* old caches are sRGB encoded */ }
  const proxy = downscaleLinearProxy16(decoded.data, decoded.width, decoded.height, 3072);
  const displayPixels = linear
    ? matrixAware ? linear16ToSrgb8(proxy.data16) : liftLinearRawDisplayProxy16(proxy.data16)
    : liftRawDisplayProxy16(proxy.data16);
  const display = await sharp(Buffer.from(displayPixels), {
    raw: { width: proxy.width, height: proxy.height, channels: 3 },
  }).jpeg({ quality: 89, chromaSubsampling: '4:4:4' }).toBuffer();
  await atomicWrite(input.displayPath, display);
  await atomicWrite(input.markerPath, `${RAW_DISPLAY_VERSION}\n`);
}

void run(workerData as WorkerInput)
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch((error) => parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }));
