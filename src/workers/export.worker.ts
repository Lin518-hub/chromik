import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import { decodeHeicFile, isHeicPath } from '../adapters/heic';
import { encodePng16 } from '../adapters/png16';
import { encodeLinearDng } from '../adapters/dng';
import { deserializeCubeLut, type SerializedCubeLut } from '../core/cube';
import { applyGeometry } from '../core/geometry';
import { processPixelSource } from '../core/reconstruct';
import { quantizeUint16To8 } from '../core/quantize';
import { preparePositiveRawLinear16 } from '../core/raw-display';
import type { EditRecipe, ExportConfig, MasterSourceDescriptor } from '../shared/types';
import { atomicWriteFile } from '../main/atomic-write';

interface ExportTask {
  sourcePath: string;
  outputPath: string;
  sourceDescriptor: MasterSourceDescriptor;
  recipe: EditRecipe;
  config: ExportConfig;
  lut?: SerializedCubeLut;
  /** Pre-built sRGB ICC profile from the main process (Buffer arrives as Uint8Array). */
  srgbIcc?: Uint8Array;
  /** Versioned positive-camera-RAW view transform shared by preview, proof and final export. */
  displayTransform?: 'camera-raw-neutral' | 'camera-raw-legacy-lift';
}

async function run(task: ExportTask, jobId: string): Promise<void> {
  const output16Bit = task.config.format === 'dng' || (task.config.bitDepth === 16 && task.config.format !== 'jpeg');
  const outputProfile = task.config.colorSpace === 'p3' ? 'p3' : 'srgb';
  const decodedHeic = isHeicPath(task.sourcePath) ? await decodeHeicFile(task.sourcePath) : undefined;
  assertNotCancelled(jobId);
  const sourcePipeline = decodedHeic
    ? sharp(decodedHeic.data, { raw: { width: decodedHeic.width, height: decodedHeic.height, channels: 4 } })
    : sharp(task.sourcePath, { failOn: 'error', limitInputPixels: 1_000_000_000 });
  const sourceMetadata = await sourcePipeline.metadata();
  const sourceIs16Bit = sourceMetadata.depth === 'ushort';
  let decodedPipeline = sourcePipeline.clone().rotate().removeAlpha();
  if (task.sourceDescriptor.transfer === 'srgb') {
    // Normalize embedded P3/other input profiles into the 1.0 working
    // primaries. The descriptor therefore describes the pixels entering the
    // graph, not merely the file extension.
    decodedPipeline = decodedPipeline.withIccProfile('srgb', { attach: false });
  }
  if (sourceIs16Bit) {
    // raw({ depth: 'ushort' }) straight from a freshly loaded 16-bit TIFF
    // returns high-byte-truncated samples (libvips reads them through an
    // 8-bit cast). An explicit rgb16 re-encode is a numerically neutral no-op
    // for unprofiled 16-bit sources (the RAW cache, linear scanner TIFFs) and
    // restores native little-endian 16-bit output.
    decodedPipeline = decodedPipeline.toColourspace('rgb16');
  }
  const { data, info } = await decodedPipeline
    .raw({ depth: 'ushort' })
    .toBuffer({ resolveWithObject: true });
  assertNotCancelled(jobId);
  const source16 = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  if (!sourceIs16Bit) {
    // libvips zero-extends uchar samples when requesting ushort. Promote the
    // entire master into the canonical 0...65535 domain before any geometry
    // or colour operation so every export format uses the Float32 graph.
    for (let index = 0; index < source16.length; index += 1) source16[index] *= 257;
  }
  const transformed = applyGeometry(source16, info.width, info.height, info.channels, task.recipe.geometry);
  // A legacy RAW view is an input compatibility transform, not an alternate
  // renderer. It must feed the same Float32 graph so grading is never skipped.
  const graphInput = task.displayTransform
    ? preparePositiveRawLinear16(transformed.data as Uint16Array, task.sourceDescriptor.transfer, task.displayTransform)
    : transformed.data as Uint16Array;
  // The task descriptor records the decoded file contract. At this boundary
  // every source has been promoted into the canonical 16-bit carrier, so the
  // descriptor passed into the Float32 graph must describe those pixels.
  const graphSourceDescriptor: MasterSourceDescriptor = {
    ...task.sourceDescriptor,
    bitDepth: 16,
    ...(task.displayTransform ? { transfer: 'linear' as const } : {}),
  };
  const processed = processPixelSource(graphInput, transformed.channels, task.recipe, graphSourceDescriptor, {
    width: transformed.width,
    height: transformed.height,
    lut: task.lut ? deserializeCubeLut(task.lut) : undefined,
  });
  assertNotCancelled(jobId);
  if (!(processed instanceof Uint16Array)) throw new Error('导出处理图返回了错误位深');
  const converted = processed;
  if (task.config.format === 'dng') {
    const dng = encodeLinearDng(
      transformed.width,
      transformed.height,
      converted,
      task.recipe.density.enabled ? 'linear' : 'srgb',
    );
    await writeOutputFile(task.outputPath, dng);
    return;
  }
  const profile = task.srgbIcc ?? await (async () => {
    const profileCarrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
      .withIccProfile('srgb').png().toBuffer();
    return (await sharp(profileCarrier).metadata()).icc;
  })();
  const png16 = encodePng16(transformed.width, transformed.height, converted, profile);
  let pipeline = sharp(png16).pipelineColourspace('rgb16');

  if (task.config.resizeMode === 'dimensions') {
    pipeline = pipeline.resize({
      width: task.config.width,
      height: task.config.height,
      fit: task.config.lockAspect ? 'inside' : 'fill',
      withoutEnlargement: !task.config.allowUpscale,
    });
  }
  if (task.config.sharpening > 0) pipeline = pipeline.sharpen({ sigma: 0.5 + task.config.sharpening / 45 });
  if (task.config.borderPadding > 0) {
    const padding = task.config.borderPadding;
    pipeline = pipeline.extend({ top: padding, bottom: padding, left: padding, right: padding, background: '#ffffff' });
  }
  if (output16Bit) {
    if (outputProfile === 'srgb') pipeline = pipeline.keepIccProfile().toColourspace('rgb16');
    else pipeline = pipeline.withIccProfile(outputProfile).toColourspace('rgb16');
  } else {
    if (outputProfile !== 'srgb') pipeline = pipeline.withIccProfile(outputProfile, { attach: false });
    const rawOutput = await pipeline.toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const output16 = new Uint16Array(rawOutput.data.buffer, rawOutput.data.byteOffset, rawOutput.data.byteLength / 2);
    const output8 = quantizeUint16To8(output16, rawOutput.info.width, rawOutput.info.channels);
    pipeline = sharp(Buffer.from(output8), {
      raw: { width: rawOutput.info.width, height: rawOutput.info.height, channels: rawOutput.info.channels as 3 },
    }).withIccProfile(outputProfile);
  }

  if (task.config.format === 'jpeg') pipeline = pipeline.jpeg({ quality: task.config.quality, chromaSubsampling: '4:4:4', mozjpeg: true });
  else if (task.config.format === 'png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false });
  else pipeline = pipeline.tiff({ compression: 'lzw', quality: 100 });

  const encoded = await pipeline.toBuffer();
  await writeOutputFile(task.outputPath, encoded);
}

/** Atomic write via a per-task unique temporary file, then rename. */
async function writeOutputFile(outputPath: string, encoded: Buffer): Promise<void> {
  await atomicWriteFile(outputPath, encoded);
}

interface PoolMessage {
  type: 'task' | 'cancel';
  jobId: string;
  task?: ExportTask;
}

/** P1-02：协作式取消。主进程发出 cancel 后，任务在下一个阶段边界自行停下；
 * 原子写入保证任何时刻放弃都不会留下半成品输出文件。 */
const cancelledJobIds = new Set<string>();

function assertNotCancelled(jobId: string): void {
  if (cancelledJobIds.has(jobId)) {
    const error = new Error('导出已取消');
    error.name = 'AbortError';
    throw error;
  }
}

// Pool protocol (ENG-03): the worker stays alive between tasks. Startup
// configuration (e.g. the pre-built sRGB ICC profile) arrives once via
// workerData; each job is posted as a message and acknowledged with `done`.
parentPort?.postMessage({ type: 'ready' });
parentPort?.on('message', (message: PoolMessage) => {
  if (message?.type === 'cancel') {
    cancelledJobIds.add(message.jobId);
    return;
  }
  if (message?.type !== 'task' || !message.task) return;
  const { jobId, task } = message;
  void run(task, jobId)
    .then(() => parentPort?.postMessage({ type: 'done', jobId }))
    .catch((error: unknown) => parentPort?.postMessage({ type: 'done', jobId, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => cancelledJobIds.delete(jobId));
});
