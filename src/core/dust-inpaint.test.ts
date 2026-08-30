import { describe, expect, it } from 'vitest';
import { buildSpotMask, createPatchMatchInpainter } from './dust-inpaint';

/** Deterministic PRNG (mulberry32) so the synthetic grain is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Synthetic frame: horizontal gradient + seeded pseudo-random grain. */
function makeGrainyGradient(width: number, height: number, channels: number, seed = 12345): Float32Array {
  const data = new Float32Array(width * height * channels);
  const rand = mulberry32(seed);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const base = x / (width - 1);
      data[i] = clamp01(base + (rand() - 0.5) * 0.04);
      data[i + 1] = clamp01(base * 0.8 + 0.1 + (rand() - 0.5) * 0.04);
      data[i + 2] = clamp01(0.25 + (rand() - 0.5) * 0.04);
      if (channels === 4) data[i + 3] = 1;
    }
  }
  return data;
}

/** Overwrite a disk with a constant "dust" colour (what a dirty lens looks like). */
function stampDust(
  data: Float32Array,
  width: number,
  height: number,
  channels: number,
  cx: number,
  cy: number,
  r: number,
  color: [number, number, number],
): void {
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (Math.hypot(dx, dy) > r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * channels;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
    }
  }
}

/** 5×5 local mean map — used to detrend the variance (grain check). */
function blockMeanMap(values: Float32Array, width: number, height: number): Float32Array {
  const means = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += values[ny * width + nx];
          count += 1;
        }
      }
      means[y * width + x] = sum / count;
    }
  }
  return means;
}

/** Variance of `value - local 5×5 mean` over a list of pixels (grain energy). */
function residualVariance(values: Float32Array, means: Float32Array, pixels: number[]): number {
  const residuals: number[] = [];
  for (const i of pixels) residuals.push(values[i] - means[i]);
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  return residuals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / residuals.length;
}

describe('buildSpotMask', () => {
  it('rasterizes a disk with 1 = to repair, 0 = known', () => {
    const mask = buildSpotMask(64, 64, [{ x: 32.5 / 64, y: 32.5 / 64, r: 6 / 64 }]);
    expect(mask).toHaveLength(64 * 64);
    expect(mask[32 * 64 + 32]).toBe(1); // centre
    expect(mask[(32 - 6) * 64 + 32]).toBe(1); // top of disk (distance 6)
    expect(mask[(32 - 7) * 64 + 32]).toBe(0); // just outside
    expect(Array.from(mask).every((v) => v === 0 || v === 1)).toBe(true);
  });

  it('clips the disk at the image borders', () => {
    const mask = buildSpotMask(64, 64, [{ x: 0.5 / 64, y: 0.5 / 64, r: 6 / 64 }]);
    let count = 0;
    for (const v of mask) count += v;
    // Quarter disk of radius 6 anchored at the corner (0,0).
    expect(count).toBe(35);
    expect(mask[0]).toBe(1);
    expect(mask[7]).toBe(0); // x = 7 > radius
    expect(mask[7 * 64]).toBe(0); // y = 7 > radius
  });

  it('returns an empty mask for an empty spot list', () => {
    const mask = buildSpotMask(32, 32, []);
    expect(Array.from(mask).every((v) => v === 0)).toBe(true);
  });
});

describe('createPatchMatchInpainter', () => {
  it('reconstructs grain texture instead of flattening it', () => {
    const width = 64;
    const height = 64;
    const channels = 3;
    const data = makeGrainyGradient(width, height, channels);
    const cx = 32;
    const cy = 32;
    const r = 6;
    stampDust(data, width, height, channels, cx, cy, r, [0.9, 0.1, 0.1]);

    const mask = buildSpotMask(width, height, [{
      x: (cx + 0.5) / width,
      y: (cy + 0.5) / height,
      r: r / Math.min(width, height),
    }]);
    const healed = Float32Array.from(data);
    createPatchMatchInpainter().heal(healed, width, height, channels, mask);

    // ① No NaN, values stay in [0, 1] (batched — avoids per-element expect
    //    overhead in a hot loop).
    let sane = true;
    for (const v of healed) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        sane = false;
        break;
      }
    }
    expect(sane).toBe(true);

    // ② Pixels outside the mask are untouched, bit-identical.
    const outsideBefore: number[] = [];
    const outsideAfter: number[] = [];
    for (let i = 0; i < width * height; i += 1) {
      if (mask[i] === 0) {
        for (let c = 0; c < channels; c += 1) {
          outsideBefore.push(data[i * channels + c]);
          outsideAfter.push(healed[i * channels + c]);
        }
      }
    }
    expect(outsideAfter).toEqual(outsideBefore);

    // ③ The repaired region keeps the local texture variance (grain): it was
    //    sampled from the surroundings, not flattened by a fill. Comparing the
    //    detrended (residual) variance lets the horizontal gradient cancel out.
    const means = blockMeanMap(healed, width, height);
    const repairedPixels: number[] = [];
    for (let i = 0; i < width * height; i += 1) if (mask[i] !== 0) repairedPixels.push(i);
    const knownBlock: number[] = [];
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) knownBlock.push((42 + dy) * width + (32 + dx));
    }
    const repairedVar = residualVariance(healed, means, repairedPixels);
    const knownVar = residualVariance(healed, means, knownBlock);
    const ratio = repairedVar / Math.max(1e-12, knownVar);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3);
  });

  it('is a no-op for an empty mask / empty spots', () => {
    const width = 32;
    const height = 32;
    const channels = 4;
    const data = makeGrainyGradient(width, height, channels);

    const copy = Float32Array.from(data);
    createPatchMatchInpainter().heal(copy, width, height, channels, new Uint8Array(width * height));
    expect(copy).toEqual(data);

    const copy2 = Float32Array.from(data);
    createPatchMatchInpainter().heal(copy2, width, height, channels, buildSpotMask(width, height, []));
    expect(copy2).toEqual(data);
  });

  it('preserves alpha while repairing RGB for 4-channel buffers', () => {
    const width = 32;
    const height = 32;
    const channels = 4;
    const data = makeGrainyGradient(width, height, channels);
    // Distinct per-column alpha so matching has a real alpha dimension.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = x / (width - 1);
    }
    stampDust(data, width, height, channels, 16, 16, 5, [0.9, 0.1, 0.1]);
    const mask = buildSpotMask(width, height, [{ x: 16.5 / width, y: 16.5 / height, r: 5 / Math.min(width, height) }]);
    const healed = Float32Array.from(data);
    createPatchMatchInpainter().heal(healed, width, height, channels, mask);

    for (let i = 0; i < width * height; i += 1) {
      // Alpha is preserved everywhere (only RGB is repaired).
      expect(healed[i * 4 + 3]).toBe(data[i * 4 + 3]);
      if (mask[i] === 0) {
        expect(healed[i * 4]).toBe(data[i * 4]);
        expect(healed[i * 4 + 1]).toBe(data[i * 4 + 1]);
        expect(healed[i * 4 + 2]).toBe(data[i * 4 + 2]);
      }
    }
    // Sanity: the dust is actually gone (no constant-colour pixels remain).
    for (let i = 0; i < width * height; i += 1) {
      if (mask[i] !== 0) {
        const base = i * 4;
        expect(healed[base] === 0.9 && healed[base + 1] === 0.1 && healed[base + 2] === 0.1).toBe(false);
      }
    }
  });

  it('heals a 720px proxy within the interactive budget (loose guard)', () => {
    const width = 720;
    const height = 480;
    const channels = 3;
    const data = makeGrainyGradient(width, height, channels, 777);
    const spots: Array<{ x: number; y: number; r: number }> = [];
    // Ten dust spots spread over the frame.
    for (let k = 0; k < 10; k += 1) {
      const sx = 60 + k * 65;
      const sy = 40 + ((k * 37) % 400);
      stampDust(data, width, height, channels, sx, sy, 8, [0.5, 0.5, 0.5]);
      spots.push({ x: sx / width, y: sy / height, r: 8 / Math.min(width, height) });
    }
    const mask = buildSpotMask(width, height, spots);
    const healed = Float32Array.from(data);
    const started = performance.now();
    createPatchMatchInpainter().heal(healed, width, height, channels, mask);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
    // Sanity (batched): repaired output stays finite and in range.
    let sane = true;
    for (const v of healed) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        sane = false;
        break;
      }
    }
    expect(sane).toBe(true);
  });
});
