import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8, processRgb16 } from '../core/reconstruct';

/**
 * Locks the platform behaviour that export.worker.ts relies on for 8-bit
 * sources exported at 16-bit depth.
 *
 * Measured on sharp 0.35.3 / libvips (arm64 macOS): `raw({ depth: 'ushort' })`
 * zero-extends 8-bit samples (value 10 stays 10 — it does NOT pre-scale by
 * 257). The worker's `* 257` promotion loop is therefore the ONLY mapping
 * from 0-255 to 0-65535; deleting it would render 8-bit sources nearly black,
 * not white. If a future sharp/libvips upgrade starts pre-scaling, this test
 * fails and the loop must be removed instead.
 */
describe('export worker 8-bit → 16-bit source scaling', () => {
  it('raw ushort zero-extends, and *257 + processRgb16 matches processRgb8', async () => {
    const width = 8;
    const height = 4;
    const source8 = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height * 3; index += 1) source8[index] = (index * 37 + 11) % 256;
    const jpeg = await sharp(source8, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    const decoded8 = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const reference8 = new Uint8Array(decoded8.data.buffer, decoded8.data.byteOffset, decoded8.data.byteLength);

    // Mirror export.worker.ts: no rgb16 re-encode for 8-bit sources.
    const metadata = await sharp(jpeg).metadata();
    const sourceIs16Bit = metadata.depth === 'ushort';
    let pipeline = sharp(jpeg, { failOn: 'error', limitInputPixels: 1_000_000_000 }).clone().rotate().removeAlpha();
    if (sourceIs16Bit) pipeline = pipeline.toColourspace('rgb16');
    const { data } = await pipeline.raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const source16 = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);

    // Platform contract: zero-extension, not pre-scaling by 257.
    expect(source16.length).toBe(reference8.length);
    for (let index = 0; index < reference8.length; index += 1) {
      expect(source16[index]).toBe(reference8[index]);
    }

    // The worker's promotion loop maps 0-255 → 0-65535 without overflow.
    for (let index = 0; index < source16.length; index += 1) source16[index] *= 257;
    expect(source16.reduce((maximum, value) => Math.max(maximum, value), 0)).toBeLessThanOrEqual(65535);

    const recipe = createDefaultRecipe();
    const out16 = processRgb16(source16, 3, recipe);
    const out8 = processRgb8(reference8, 3, recipe);
    let maxDifference = 0;
    for (let index = 0; index < out16.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(out16[index] / 65535 - out8[index] / 255));
    }
    expect(maxDifference).toBeLessThan(0.02);
  });
});
