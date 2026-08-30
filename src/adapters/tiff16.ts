import { deflateSync, inflateSync } from 'node:zlib';

export interface DecodedTiff16 {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint16Array;
}

const IS_LITTLE_ENDIAN = (() => {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 0x1234, true);
  return new Uint16Array(buffer)[0] === 0x1234;
})();

/**
 * Encodes interleaved 16-bit RGB(A) samples into a little-endian, deflate
 * (zlib) compressed classic TIFF (PhotometricInterpretation=RGB,
 * PlanarConfiguration=chunky).
 *
 * sharp/libvips cannot ingest raw 16-bit buffers: its `raw` input option only
 * understands 8-bit samples (see the `Raw` interface in sharp's typings — it
 * has no `depth` field). Passing a 16-bit buffer made libvips consume the
 * first half of the byte stream as uchar values and silently corrupted both
 * the 16-bit cache and the preview proxy. Wrapping the decoded samples in a
 * real TIFF container lets sharp read them back correctly for export.
 *
 * The samples are stored as-is; no colour-space conversion is applied. The
 * caller decides the encoding (LibRaw's outputColor=1 produces sRGB-encoded
 * 16-bit values, which matches the shared recipe inputTransfer 'srgb').
 */
export interface Tiff16EncodeOptions {
  compression?: 'deflate' | 'none';
}

export function encodeTiff16(
  width: number,
  height: number,
  pixels: Uint16Array,
  channels: number,
  options: Tiff16EncodeOptions = {},
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('无效的 TIFF 尺寸');
  }
  if (channels !== 3 && channels !== 4) throw new Error('TIFF 仅支持 3/4 通道');
  if (pixels.length !== width * height * channels) throw new Error('16-bit TIFF 像素尺寸不匹配');

  const compression = options.compression ?? 'deflate';
  const rowsPerStrip = compression === 'none' ? 256 : 16;
  const stripCount = Math.ceil(height / rowsPerStrip);
  const strips: Buffer[] = [];
  const stripOffsets: number[] = [];
  const stripByteCounts: number[] = [];

  // Layout: header(8) | IFD(2 + 10*12 + 4) | BitsPerSample(6) | [StripOffsets]
  // | [StripByteCounts] | strip data. The offset/count arrays exist only when
  // there is more than one strip; with a single strip the values are inlined
  // into their IFD entries (TIFF inline-value rule: size <= 4 bytes).
  const entryCount = 10;
  const ifdSize = 2 + entryCount * 12 + 4;
  const bitsOffset = 8 + ifdSize;
  const offsetsOffset = stripCount > 1 ? bitsOffset + 6 : 0;
  const countsOffset = stripCount > 1 ? offsetsOffset + stripCount * 4 : 0;
  let dataOffset = (stripCount > 1 ? countsOffset + stripCount * 4 : bitsOffset + 6);
  const stride = width * channels * 2;

  for (let row = 0; row < height; row += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - row);
    const source = Buffer.from(pixels.buffer, pixels.byteOffset + row * width * channels * 2, rows * stride);
    const raw = IS_LITTLE_ENDIAN ? source : Buffer.from(source).swap16();
    const compressed = compression === 'deflate' ? deflateSync(raw) : raw;
    stripOffsets.push(dataOffset);
    stripByteCounts.push(compressed.length);
    strips.push(compressed);
    dataOffset += compressed.length + (compressed.length % 2);
  }

  const buffer = Buffer.alloc(dataOffset);
  buffer.writeUInt16LE(0x4949, 0); // 'II'
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  let cursor = 8;
  buffer.writeUInt16LE(entryCount, cursor);
  cursor += 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(count, cursor + 4);
    const byteSize = (type === 3 ? 2 : 4) * count;
    if (byteSize <= 4) {
      // Inline value: the value field holds the data itself, not an offset.
      if (type === 3) {
        buffer.writeUInt16LE(value, cursor + 8);
        buffer.writeUInt16LE(0, cursor + 10);
      } else {
        buffer.writeUInt32LE(value, cursor + 8);
      }
    } else {
      // Value is an absolute offset to the data array that follows the IFD.
      buffer.writeUInt32LE(value, cursor + 8);
    }
    cursor += 12;
  };
  entry(256, 4, 1, width); // ImageWidth
  entry(257, 4, 1, height); // ImageLength
  entry(258, 3, 3, bitsOffset); // BitsPerSample = 16,16,16
  entry(259, 3, 1, compression === 'deflate' ? 8 : 1);
  entry(262, 3, 1, 2); // PhotometricInterpretation = RGB
  entry(273, 4, stripCount, stripCount > 1 ? offsetsOffset : stripOffsets[0]); // StripOffsets
  entry(277, 3, 1, channels); // SamplesPerPixel
  entry(278, 4, 1, rowsPerStrip); // RowsPerStrip
  entry(279, 4, stripCount, stripCount > 1 ? countsOffset : stripByteCounts[0]); // StripByteCounts
  entry(284, 3, 1, 1); // PlanarConfiguration = chunky
  buffer.writeUInt32LE(0, cursor); // next IFD

  for (let index = 0; index < 3; index += 1) {
    buffer.writeUInt16LE(16, bitsOffset + index * 2);
  }
  if (stripCount > 1) {
    for (let index = 0; index < stripCount; index += 1) {
      buffer.writeUInt32LE(stripOffsets[index], offsetsOffset + index * 4);
      buffer.writeUInt32LE(stripByteCounts[index], countsOffset + index * 4);
    }
  }
  for (let index = 0; index < stripCount; index += 1) {
    strips[index].copy(buffer, stripOffsets[index]);
  }
  return buffer;
}

/** Read the classic little/big-endian TIFF emitted by encodeTiff16. */
export function decodeTiff16(buffer: Buffer): DecodedTiff16 | null {
  if (buffer.length < 16) return null;
  const order = buffer.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = (offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const typeSize = (type: number) => type === 3 ? 2 : type === 4 ? 4 : 0;
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > buffer.length) return null;
  const entries = new Map<number, { type: number; count: number; offset: number }>();
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const at = ifd + 2 + index * 12;
    if (at + 12 > buffer.length) return null;
    const type = u16(at + 2);
    const itemCount = u32(at + 4);
    const bytes = typeSize(type) * itemCount;
    const offset = bytes <= 4 ? at + 8 : u32(at + 8);
    if (!typeSize(type) || offset + bytes > buffer.length) return null;
    entries.set(u16(at), { type, count: itemCount, offset });
  }
  const readValues = (tag: number): number[] => {
    const entry = entries.get(tag);
    if (!entry) return [];
    const result: number[] = [];
    for (let index = 0; index < entry.count; index += 1) {
      const at = entry.offset + index * typeSize(entry.type);
      result.push(entry.type === 3 ? u16(at) : u32(at));
    }
    return result;
  };
  const width = readValues(256)[0] ?? 0;
  const height = readValues(257)[0] ?? 0;
  const bits = readValues(258);
  const compression = readValues(259)[0] ?? 1;
  const offsets = readValues(273);
  const channels = readValues(277)[0] ?? 0;
  const rowsPerStrip = readValues(278)[0] ?? height;
  const byteCounts = readValues(279);
  if (!width || !height || (channels !== 3 && channels !== 4) || bits.some((value) => value !== 16)
    || (compression !== 1 && compression !== 8) || offsets.length !== byteCounts.length) return null;
  const output = new Uint16Array(width * height * channels);
  let row = 0;
  for (let strip = 0; strip < offsets.length && row < height; strip += 1) {
    const start = offsets[strip];
    const end = start + byteCounts[strip];
    if (end > buffer.length) return null;
    let raw: Buffer;
    try { raw = compression === 8 ? inflateSync(buffer.subarray(start, end)) : buffer.subarray(start, end); } catch { return null; }
    const rows = Math.min(rowsPerStrip, height - row);
    const expectedBytes = rows * width * channels * 2;
    if (raw.length < expectedBytes) return null;
    for (let index = 0; index < expectedBytes / 2; index += 1) {
      const source = index * 2;
      const value = little ? raw.readUInt16LE(source) : raw.readUInt16BE(source);
      output[row * width * channels + index] = value;
    }
    row += rows;
  }
  return row === height ? { width, height, channels, data: output } : null;
}
