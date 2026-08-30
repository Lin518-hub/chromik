import { parentPort } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { decodeDevelopProxy, describeDevelopProxy, downscaleLinearProxy16 } from '../core/develop-proxy';
import { applyGeometry } from '../core/geometry';
import { deserializeCubeLut, type SerializedCubeLut } from '../core/cube';
import { preparePositiveRawLinear16 } from '../core/raw-display';
import { processPixelSource } from '../core/reconstruct';
import { quantizeUint16To8 } from '../core/quantize';
import type { EditRecipe } from '../shared/types';

interface ThumbnailTask {
  proxyPath: string;
  recipe: EditRecipe;
  width: number;
  height: number;
  background: string;
  processEdge: number;
  rawDisplayTransform?: 'camera-raw-neutral' | 'camera-raw-legacy-lift';
  lut?: SerializedCubeLut;
}

interface ThumbnailMessage {
  type: 'task';
  jobId: string;
  task: ThumbnailTask;
}

async function render(task: ThumbnailTask): Promise<Uint8Array> {
  const proxy = decodeDevelopProxy(await fs.readFile(task.proxyPath));
  if (!(proxy.data instanceof Uint16Array)) throw new Error('开发代理不是 16 位数据');
  const descriptor = describeDevelopProxy(proxy);
  const resized = downscaleLinearProxy16(proxy.data, proxy.width, proxy.height, task.processEdge);
  const transformed = applyGeometry(resized.data16, resized.width, resized.height, proxy.channels, task.recipe.geometry);
  const graphInput = task.rawDisplayTransform
    ? preparePositiveRawLinear16(transformed.data as Uint16Array, descriptor.transfer, task.rawDisplayTransform)
    : transformed.data as Uint16Array;
  const graphDescriptor = task.rawDisplayTransform
    ? { ...descriptor, transfer: 'linear' as const }
    : descriptor;
  const processed = processPixelSource(graphInput, transformed.channels, task.recipe, graphDescriptor, {
    width: transformed.width,
    height: transformed.height,
    lut: task.lut ? deserializeCubeLut(task.lut) : undefined,
  });
  if (!(processed instanceof Uint16Array)) throw new Error('缩略图处理结果位深无效');
  // BUG-017：4 通道代理先剥 alpha，避免 quantize 保留 alpha 后按 3 通道
  // 声明 sharp 造成的逐像素错位。
  let rgb = processed;
  if (transformed.channels === 4) {
    rgb = new Uint16Array(transformed.width * transformed.height * 3);
    for (let pixel = 0, from = 0, to = 0; pixel < transformed.width * transformed.height; pixel += 1, from += 4, to += 3) {
      rgb[to] = processed[from];
      rgb[to + 1] = processed[from + 1];
      rgb[to + 2] = processed[from + 2];
    }
  }
  const display = quantizeUint16To8(rgb, transformed.width, 3);
  const encoded = await sharp(Buffer.from(display.buffer, display.byteOffset, display.byteLength), {
    raw: { width: transformed.width, height: transformed.height, channels: 3 },
  }).resize({ width: task.width, height: task.height, fit: 'contain', background: task.background })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  // Own an exact ArrayBuffer so transferring it never exposes Buffer-pool data.
  return new Uint8Array(encoded);
}

parentPort?.on('message', (message: ThumbnailMessage) => {
  if (message?.type !== 'task') return;
  void render(message.task).then((data) => {
    parentPort?.postMessage({ type: 'done', jobId: message.jobId, data }, [data.buffer as ArrayBuffer]);
  }).catch((error: unknown) => {
    parentPort?.postMessage({ type: 'done', jobId: message.jobId, error: error instanceof Error ? error.message : String(error) });
  });
});
