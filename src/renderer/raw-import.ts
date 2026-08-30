import LibRaw from 'libraw-wasm';
import { cameraRgb16ToLinearSrgb16InPlaceRange, parseCameraToSrgbMatrix } from '../core/camera-color';
import type { RawDecodedImage } from '../shared/types';

interface RawDecodeOptions {
  signal?: AbortSignal;
  onEmbeddedPreview?: (preview: { data: Uint8Array; width: number; height: number; format: 'jpeg' | 'bitmap' | 'unknown' }) => void;
  onStage?: (stage: 'opened' | 'thumbnail' | 'pixels' | 'metadata' | 'color', elapsedMs: number) => void;
}

/** Decode a camera RAW off the React thread through LibRaw's dedicated Web Worker. */
export async function decodeRawImport(buffer: ArrayBuffer, options: RawDecodeOptions = {}): Promise<RawDecodedImage> {
  const decoder = new LibRaw();
  const startedAt = performance.now();
  const reportStage = (stage: Parameters<NonNullable<RawDecodeOptions['onStage']>>[0]) => options.onStage?.(stage, performance.now() - startedAt);
  const abort = () => decoder.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new DOMException('RAW 导入已取消', 'AbortError');
    await decoder.open(new Uint8Array(buffer), {
      outputBps: 16,
      // Keep demosaiced camera RGB until metadata exposes LibRaw's signed
      // camera-to-sRGB matrix. Applying that matrix below in floating point
      // avoids unsigned 16-bit per-channel clipping.
      outputColor: 0,
      outputTiff: false,
      useCameraWb: true,
      useCameraMatrix: 3,
      userFlip: -1,
      userQual: 3,
      highlight: 5,
      noAutoBright: true,
      // Canonical develop data is linear-light. Display gamma is applied only
      // when painting the UI or encoding a deliverable.
      gamm: [1, 1],
    });
    reportStage('opened');
    if (options.signal?.aborted) throw new DOMException('RAW 导入已取消', 'AbortError');
    try {
      const thumbnail = await decoder.thumbnailData();
      if (thumbnail?.data?.length) options.onEmbeddedPreview?.(thumbnail);
    } catch {
      // Some RAW variants have no embedded preview; full decode remains valid.
    }
    reportStage('thumbnail');
    if (options.signal?.aborted) throw new DOMException('RAW 导入已取消', 'AbortError');
    // LibRaw serializes calls internally. Keep the order explicit so progress
    // reflects the expensive demosaic stage and so a full metadata object is
    // never prepared while the ~200 MB Sony RGB16 transfer is still in flight.
    const image = await decoder.imageData();
    reportStage('pixels');
    if (options.signal?.aborted) throw new DOMException('RAW 导入已取消', 'AbortError');
    const metadata = await decoder.metadata(true);
    reportStage('metadata');
    if (!image || !image.width || !image.height || (image.colors !== 3 && image.colors !== 4)) {
      throw new Error('RAW 解码器没有返回可用的 RGB 图像');
    }
    const expected = image.width * image.height * image.colors;
    if (image.data.length !== expected) throw new Error('RAW 解码结果长度与图像尺寸不一致');
    const cameraToSrgb = parseCameraToSrgbMatrix(metadata?.color_data?.rgb_cam);
    if (image.bits !== 16 || !(image.data instanceof Uint16Array) || image.colors !== 3) {
      throw new Error('RAW 浮点色彩转换需要三通道 16 位解码结果');
    }
    if (!cameraToSrgb) throw new Error('RAW 文件缺少可用的相机色彩矩阵');
    // Each A7M4 RGB16 decode is ~200 MB. Transform the transferred LibRaw
    // carrier in place so the renderer process never owns a second full-sized
    // colour-conversion array; chunk the ~1 亿次浮点迭代 with event-loop
    // yields so the UI thread never blocks for 100 ms+ (§13.2).
    const linearSrgb = image.data;
    const CHUNK_SAMPLES = 1_500_000; // ≈ 50 万像素/块
    for (let start = 0; start < linearSrgb.length; start += CHUNK_SAMPLES) {
      if (options.signal?.aborted) throw new DOMException('RAW 导入已取消', 'AbortError');
      cameraRgb16ToLinearSrgb16InPlaceRange(linearSrgb, cameraToSrgb, start, start + CHUNK_SAMPLES);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    reportStage('color');
    const rawIso = metadata?.iso_speed;
    const rawAperture = metadata?.aperture;
    const rawFocalLength = metadata?.focal_len;
    return {
      width: image.width,
      height: image.height,
      channels: image.colors,
      bits: image.bits === 16 ? 16 : 8,
      data: linearSrgb,
      transfer: 'linear',
      cameraMake: metadata?.normalized_make?.trim() || metadata?.camera_make?.trim() || undefined,
      cameraModel: metadata?.normalized_model?.trim() || metadata?.camera_model?.trim() || undefined,
      lens: metadata?.lens?.Lens?.trim() || undefined,
      iso: Number.isFinite(rawIso) && (rawIso ?? 0) > 0 ? Math.round(rawIso as number) : undefined,
      shutter: formatRawShutter(metadata?.shutter),
      aperture: Number.isFinite(rawAperture) && (rawAperture ?? 0) > 0 ? `f/${Number((rawAperture as number).toFixed(1))}` : undefined,
      focalLength: Number.isFinite(rawFocalLength) && (rawFocalLength ?? 0) > 0 ? `${Number((rawFocalLength as number).toFixed(1))} mm` : undefined,
      shotAt: metadata?.timestamp instanceof Date && Number.isFinite(metadata.timestamp.getTime()) ? metadata.timestamp.toISOString() : undefined,
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    decoder.dispose();
  }
}

export function formatRawShutter(seconds: number | undefined): string | undefined {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return undefined;
  if (seconds >= 1) return `${Number(seconds.toFixed(2))} 秒`;
  return `1/${Math.max(1, Math.round(1 / seconds))}`;
}
