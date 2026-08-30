import type { DevelopProxyDescriptor, InputTransfer } from '../shared/types';

// v2 is the first cache generation whose processing source is guaranteed to
// come from the high-precision master/RAW cache. Bumping the on-disk version is
// intentional: early v1 development builds could promote an 8-bit analysis
// JPEG into CHPX, preserving the container bit depth while permanently baking
// in the posterization that the container was meant to avoid.
export const DEVELOP_PROXY_VERSION = 4;
export const DEVELOP_PROXY_MIME = 'application/x-chromik-develop-proxy';

const HEADER_SIZE = 32;
const MAGIC = [0x43, 0x48, 0x50, 0x58] as const; // CHPX

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface DevelopProxy {
  role: 'develop';
  version: number;
  width: number;
  height: number;
  channels: 3 | 4;
  bitDepth: 8 | 16;
  transfer: InputTransfer;
  data: Uint8Array | Uint16Array;
}

export function describeDevelopProxy(proxy: Pick<DevelopProxy, 'version' | 'channels' | 'bitDepth' | 'transfer'>): DevelopProxyDescriptor {
  if (proxy.bitDepth !== 16 || proxy.transfer !== 'linear') {
    throw new Error('处理图只接受 16 位线性开发代理');
  }
  return {
    role: 'develop',
    version: proxy.version,
    channels: proxy.channels,
    bitDepth: 16,
    transfer: 'linear',
    colorSpace: 'srgb',
  };
}

function expectedSamples(width: number, height: number, channels: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100_000 || height > 100_000) {
    throw new Error('开发代理尺寸无效');
  }
  if (channels !== 3 && channels !== 4) throw new Error('开发代理仅支持 RGB/RGBA');
  const samples = width * height * channels;
  if (!Number.isSafeInteger(samples) || samples > 1_500_000_000) throw new Error('开发代理像素数量无效');
  return samples;
}

/**
 * Reads the payload checksum stamped by encodeDevelopProxy. Format knowledge
 * stays with the container so callers (cache bookkeeping, QA reports) never
 * re-derive byte offsets.
 */
export function developProxyPayloadChecksum(encoded: Uint8Array): number {
  if (encoded.byteLength < HEADER_SIZE) throw new Error('开发代理文件头无效');
  return new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(24, true);
}

/**
 * A tiny, deterministic container for the processing proxy. Samples are
 * little-endian and carry their transfer function explicitly, so a browser
 * worker never has to infer colour meaning from a file extension or recipe.
 */
export function encodeDevelopProxy(input: Omit<DevelopProxy, 'role' | 'version'>): Uint8Array {
  const samples = expectedSamples(input.width, input.height, input.channels);
  const bytesPerSample = input.bitDepth === 16 ? 2 : 1;
  if (input.data.length !== samples) throw new Error('开发代理像素长度不匹配');
  if (input.bitDepth === 16 && !(input.data instanceof Uint16Array)) throw new Error('16 位开发代理必须使用 Uint16Array');
  if (input.bitDepth === 8 && input.data instanceof Uint16Array) throw new Error('8 位开发代理不能使用 Uint16Array');

  const output = new Uint8Array(HEADER_SIZE + samples * bytesPerSample);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint8(4, DEVELOP_PROXY_VERSION);
  view.setUint8(5, input.channels);
  view.setUint8(6, input.bitDepth);
  view.setUint8(7, input.transfer === 'linear' ? 1 : 0);
  view.setUint32(8, input.width, true);
  view.setUint32(12, input.height, true);
  view.setUint32(16, samples, true);
  view.setUint32(20, samples * bytesPerSample, true);

  if (input.bitDepth === 8) {
    output.set(new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength), HEADER_SIZE);
  } else {
    const source = input.data as Uint16Array;
    const payload = new DataView(output.buffer, HEADER_SIZE);
    for (let index = 0; index < source.length; index += 1) payload.setUint16(index * 2, source[index], true);
  }
  // Payload checksum makes this rebuildable cache self-validating after an
  // interrupted write, disk error or manual tampering. Header bytes 28–31 stay
  // reserved for a future checksum/codec extension.
  view.setUint32(24, crc32(output.subarray(HEADER_SIZE)), true);
  return output;
}

export function decodeDevelopProxy(buffer: ArrayBuffer | ArrayBufferView): DevelopProxy {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.byteLength < HEADER_SIZE || MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error('开发代理文件头无效');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== DEVELOP_PROXY_VERSION) throw new Error(`不支持的开发代理版本：${version}`);
  const channels = view.getUint8(5);
  const bitDepth = view.getUint8(6);
  if ((channels !== 3 && channels !== 4) || (bitDepth !== 8 && bitDepth !== 16)) throw new Error('开发代理格式无效');
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const samples = expectedSamples(width, height, channels);
  const declaredSamples = view.getUint32(16, true);
  const declaredBytes = view.getUint32(20, true);
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  if (declaredSamples !== samples || declaredBytes !== samples * bytesPerSample || HEADER_SIZE + declaredBytes !== bytes.byteLength) {
    throw new Error('开发代理文件长度无效');
  }
  const declaredChecksum = view.getUint32(24, true);
  const actualChecksum = crc32(bytes.subarray(HEADER_SIZE));
  if (declaredChecksum !== actualChecksum) throw new Error('开发代理校验和无效');

  let data: Uint8Array | Uint16Array;
  if (bitDepth === 8) {
    data = bytes.slice(HEADER_SIZE);
  } else {
    const payload = new DataView(bytes.buffer, bytes.byteOffset + HEADER_SIZE, declaredBytes);
    const pixels = new Uint16Array(samples);
    for (let index = 0; index < samples; index += 1) pixels[index] = payload.getUint16(index * 2, true);
    data = pixels;
  }
  return {
    role: 'develop',
    version,
    width,
    height,
    channels: channels as 3 | 4,
    bitDepth: bitDepth as 8 | 16,
    transfer: view.getUint8(7) === 1 ? 'linear' : 'srgb',
    data,
  };
}

/** Area-average resize that keeps the canonical 16-bit linear transfer. */
export function downscaleLinearProxy16(source: Uint16Array, width: number, height: number, maxEdge: number): {
  width: number;
  height: number;
  data16: Uint16Array;
} {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return { width, height, data16: source };
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const data16 = new Uint16Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y += 1) {
    const sy0 = Math.floor(y * height / outHeight);
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.floor((y + 1) * height / outHeight)));
    for (let x = 0; x < outWidth; x += 1) {
      const sx0 = Math.floor(x * width / outWidth);
      const sx1 = Math.max(sx0 + 1, Math.min(width, Math.floor((x + 1) * width / outWidth)));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const from = (sy * width + sx) * 3;
          sumR += source[from];
          sumG += source[from + 1];
          sumB += source[from + 2];
          count += 1;
        }
      }
      const to = (y * outWidth + x) * 3;
      data16[to] = Math.round(sumR / count);
      data16[to + 1] = Math.round(sumG / count);
      data16[to + 2] = Math.round(sumB / count);
    }
  }
  return { width: outWidth, height: outHeight, data16 };
}
