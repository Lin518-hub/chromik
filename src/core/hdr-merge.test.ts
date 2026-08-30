import { describe, expect, it } from 'vitest';
import { mergeExposures, mergeExposures16, type Hdr16Source, type HdrSource } from './hdr-merge';

function gradientSource(width: number, height: number, factor: number): HdrSource {
  // Textured ramp: a smooth gradient would make the Laplacian (contrast
  // weight) degenerate into quantization noise — real bracketed shots share
  // the same texture, so all sources carry the identical seeded pattern.
  let state = 987654321;
  const random = () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = x / (width - 1);
      const noise = (random() - 0.5) * 0.1;
      const value = Math.max(0, Math.min(1, t * factor + noise));
      const at = (y * width + x) * 3;
      data[at] = Math.round(value * 255);
      data[at + 1] = Math.round(value * 230);
      data[at + 2] = Math.round(value * 210);
    }
  }
  return { width, height, channels: 3, data };
}

function seededNoise(width: number, height: number, seed: number): Uint8ClampedArray {
  let state = seed;
  const random = () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
  const data = new Uint8ClampedArray(width * height * 3);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.round(random() * 255);
  return data;
}

describe('mergeExposures', () => {
  it('returns the input unchanged when all sources are identical', () => {
    const width = 48;
    const height = 32;
    const data = seededNoise(width, height, 42);
    const source: HdrSource = { width, height, channels: 3, data };
    const merged = mergeExposures([source, { ...source }], { align: true });
    expect(merged.width).toBe(width);
    expect(merged.height).toBe(height);
    let maxDifference = 0;
    for (let index = 0; index < data.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(merged.data[index] - data[index]));
    }
    expect(maxDifference).toBe(0);
  });

  it('prefers well-exposed midtone sources over clipped or dark ones', () => {
    const width = 64;
    const height = 16;
    const dark = gradientSource(width, height, 0.3);
    const mid = gradientSource(width, height, 1);
    const bright = gradientSource(width, height, 3);
    const merged = mergeExposures([dark, mid, bright], { align: false });
    // Mertens picks, per pixel, the source whose exposure is nearest 0.5 —
    // the expected value is that best-exposed source (tolerance covers the
    // ±5% shared texture).
    const expectedFor = (fraction: number): number => {
      const candidates = [0.3 * fraction, fraction, Math.min(1, 3 * fraction)];
      let bestValue = candidates[0];
      let bestDistance = Infinity;
      for (const value of candidates) {
        const distance = Math.abs(value - 0.5);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestValue = value;
        }
      }
      return Math.round(bestValue * 255);
    };
    for (const fraction of [0.2, 0.35, 0.5, 0.65]) {
      const x = Math.round(fraction * (width - 1));
      const y = Math.round(height / 2);
      const actual = merged.data[(y * merged.width + x) * 3];
      expect(Math.abs(actual - expectedFor(fraction))).toBeLessThan(40);
    }
    // Deep shadow column: every source is far from 0.5 there, the output must
    // stay dark (never lifted towards white).
    const x = Math.round(0.05 * (width - 1));
    const y = Math.round(height / 2);
    expect(merged.data[(y * merged.width + x) * 3]).toBeLessThan(80);
  });

  it('aligns a translated copy back onto the reference', () => {
    const width = 64;
    const height = 64;
    const reference = seededNoise(width, height, 7);
    // Shift a copy by (+3, -2), filling the vacated edges with black.
    const shifted = new Uint8ClampedArray(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sy = y + 2;
        const sx = x - 3;
        if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
        for (let channel = 0; channel < 3; channel += 1) {
          shifted[(y * width + x) * 3 + channel] = reference[(sy * width + sx) * 3 + channel];
        }
      }
    }
    const sources: HdrSource[] = [
      { width, height, channels: 3, data: reference },
      { width, height, channels: 3, data: shifted },
    ];
    const merged = mergeExposures(sources, { align: true });
    // Interior pixels of the overlap must match the reference.
    let error = 0;
    let count = 0;
    for (let y = 8; y < height - 8; y += 1) {
      for (let x = 8; x < width - 8; x += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
          error += Math.abs(merged.data[(y * merged.width + x) * 3 + channel] - reference[(y * width + x) * 3 + channel]);
          count += 1;
        }
      }
    }
    expect(error / count).toBeLessThan(1.5);
  });

  it('rejects mismatched or insufficient input', () => {
    const a: HdrSource = { width: 4, height: 4, channels: 3, data: new Uint8Array(48) };
    expect(() => mergeExposures([a])).toThrow();
    expect(() => mergeExposures([a, { width: 5, height: 4, channels: 3, data: new Uint8Array(60) }])).toThrow();
    expect(() => mergeExposures([a, { width: 4, height: 4, channels: 2, data: new Uint8Array(32) }])).toThrow();
  });
});

describe('mergeExposures16', () => {
  it('preserves recoverable highlights between 65280 and 65533', () => {
    const width = 8;
    const height = 8;
    const clipped = new Uint16Array(width * height * 3).fill(65535);
    const recoverable = new Uint16Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const value = 65290 + (pixel % 7) * 30;
      recoverable[pixel * 3] = value;
      recoverable[pixel * 3 + 1] = value - 20;
      recoverable[pixel * 3 + 2] = value - 40;
    }
    const merged = mergeExposures16([
      { width, height, channels: 3, data: clipped },
      { width, height, channels: 3, data: recoverable },
    ], { align: false });
    expect(merged.data[(4 * width + 4) * 3]).toBeLessThan(65534);
    expect(merged.data[(4 * width + 4) * 3]).toBeGreaterThanOrEqual(65280);
  });

  it('keeps highlight detail above the 8-bit range', () => {
    const width = 24;
    const height = 16;
    const make = (factor: number): Hdr16Source => {
      const data = new Uint16Array(width * height * 3);
      for (let index = 0; index < data.length; index += 3) {
        const value = Math.min(65535, Math.round((18000 + (index % 97) * 220) * factor));
        data[index] = value;
        data[index + 1] = Math.min(65535, value + 500);
        data[index + 2] = Math.min(65535, value + 900);
      }
      return { width, height, channels: 3, data };
    };
    const merged = mergeExposures16([make(0.55), make(1), make(2.4)], { align: false });
    expect(merged.data.length).toBe(width * height * 3);
    expect(merged.data.some((value) => value > 255)).toBe(true);
    expect(Math.max(...merged.data)).toBeGreaterThan(10000);
  });
});
