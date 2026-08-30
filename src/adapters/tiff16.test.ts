import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeTiff16, encodeTiff16 } from './tiff16';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8, processRgb16 } from '../core/reconstruct';

describe('encodeTiff16', () => {
  it('writes a sharp-readable 16-bit TIFF that round-trips exact ushort values', async () => {
    const width = 37;
    const height = 5; // single strip (rowsPerStrip = 16)
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 997 + 13) % 65536;
    const tiff = encodeTiff16(width, height, pixels, 3);
    const metadata = await sharp(tiff).metadata();
    expect(metadata.format).toBe('tiff');
    expect(metadata.depth).toBe('ushort');
    // Mirrors export.worker.ts: an explicit rgb16 re-encode before the raw
    // extraction yields exact little-endian values.
    const { data, info } = await sharp(tiff).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
    expect(info.channels).toBe(3);
    const readback = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    expect([...readback]).toEqual([...pixels]);
  });

  it('round-trips multi-strip images', async () => {
    const width = 13;
    const height = 40; // three strips
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 131) % 65536;
    const tiff = encodeTiff16(width, height, pixels, 3);
    const { data } = await sharp(tiff).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const readback = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    expect([...readback]).toEqual([...pixels]);
  });

  it('decodes the cached TIFF without passing through an 8-bit proxy', () => {
    const width = 19;
    const height = 23;
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 4093 + 321) % 65536;
    const decoded = decodeTiff16(encodeTiff16(width, height, pixels, 3));
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    expect(decoded?.channels).toBe(3);
    expect([...decoded!.data]).toEqual([...pixels]);
  });

  it('round-trips an uncompressed 16-bit cache TIFF', () => {
    const width = 5;
    const height = 3;
    const pixels = Uint16Array.from({ length: width * height * 3 }, (_, index) => (index * 1453) % 65536);
    const tiff = encodeTiff16(width, height, pixels, 3, { compression: 'none' });
    const decoded = decodeTiff16(tiff);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    expect(Array.from(decoded?.data ?? [])).toEqual(Array.from(pixels));
  });

  it('reads back as 8-bit with high-byte scaling', async () => {
    const width = 4;
    const height = 2;
    const pixels = new Uint16Array([
      13, 1010, 2007, 3004, 4001, 4998, 5995, 6992, 7989, 8986, 9983, 10980,
      11977, 12974, 13971, 14968, 15965, 16962, 17959, 18956, 19953, 20950, 21947, 22944,
    ]);
    const tiff = encodeTiff16(width, height, pixels, 3);
    const { data } = await sharp(tiff).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const readback = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    expect(readback.length).toBe(pixels.length);
    for (let index = 0; index < pixels.length; index += 1) {
      expect(Math.abs(readback[index] - Math.round(pixels[index] * 255 / 65535))).toBeLessThanOrEqual(1);
    }
  });

  it('rejects mismatched or invalid input', () => {
    expect(() => encodeTiff16(0, 4, new Uint16Array(0), 3)).toThrow();
    expect(() => encodeTiff16(4, 4, new Uint16Array(16), 3)).toThrow();
    expect(() => encodeTiff16(4, 4, new Uint16Array(4 * 4 * 2), 2)).toThrow();
  });

  it('RAW cache export path matches the 8-bit proxy path (no double gamma)', async () => {
    // Synthetic "LibRaw sRGB-encoded 16-bit" scene with an orange border.
    const width = 12;
    const height = 4;
    const encode = (linear: number) => {
      const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
      return Math.round(value * 65535);
    };
    const s16 = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const border = y === 0 || y === height - 1 || x === 0 || x === width - 1;
        const linear = border ? [0.86, 0.58, 0.33] : [0.5, 0.4, 0.3];
        s16[index] = encode(linear[0]);
        s16[index + 1] = encode(linear[1]);
        s16[index + 2] = encode(linear[2]);
      }
    }
    const tiff = encodeTiff16(width, height, s16, 3);
    // Mirrors export.worker.ts: conditional rgb16 re-encode + raw ushort.
    const metadata = await sharp(tiff).metadata();
    let pipeline = sharp(tiff).rotate().removeAlpha();
    if (metadata.depth === 'ushort') pipeline = pipeline.toColourspace('rgb16');
    const { data } = await pipeline.raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const exportSource = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    expect([...exportSource]).toEqual([...s16]);

    const proxy = new Uint8ClampedArray(width * height * 3);
    for (let index = 0; index < s16.length; index += 1) proxy[index] = Math.round(s16[index] * 255 / 65535);

    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.density.inputTransfer = 'srgb';
    // baseRgb is always in 8-bit proxy scale (the recipe is produced by
    // analysis on the 8-bit preview proxy), even for 16-bit exports.
    recipe.baseRgb = [
      Math.round(encode(0.86) * 255 / 65535),
      Math.round(encode(0.58) * 255 / 65535),
      Math.round(encode(0.33) * 255 / 65535),
    ];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1.6, 1.6, 1.6];
    const out16 = processRgb16(exportSource, 3, recipe);
    const out8 = processRgb8(proxy, 3, recipe);
    let maxDifference = 0;
    for (let index = 0; index < out16.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(out16[index] / 65535 - out8[index] / 255));
    }
    // Only 8/16-bit quantization noise may remain; a double gamma error would
    // shift every sample by tens of percent.
    expect(maxDifference).toBeLessThan(0.01);
  });
});
