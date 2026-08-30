import { describe, expect, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import { estimateDensityAnchors, estimateFilmBase, estimateFilmBaseRobust } from './density';
import { applyDensitySeparation, compressHighlight } from './color';
import { linearToSrgb, srgbToLinear } from './image';
import { evaluateCurve, processRgb16, processRgb8 } from './reconstruct';

describe('FilmLab demo colour core', () => {
  it('round-trips the sRGB transfer function', () => {
    for (const value of [0, 0.01, 0.18, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(value))).toBeCloseTo(value, 6);
    }
  });

  it('reconstructs increasing negative density as a brighter positive', () => {
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.baseRgb = [240, 180, 120];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1.4, 1.4, 1.4];
    recipe.grade.contrast = 0;
    const input = new Uint8Array([
      220, 165, 110,
      24, 18, 12,
    ]);
    const output = processRgb8(input, 3, recipe);
    expect(output[3]).toBeGreaterThan(output[0]);
    expect(output[4]).toBeGreaterThan(output[1]);
    expect(output[5]).toBeGreaterThan(output[2]);
  });

  it('estimates film base from a synthetic border and returns finite anchors', () => {
    const width = 40;
    const height = 30;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x < 4 || y < 3 || x >= width - 4 || y >= height - 3;
        const index = (y * width + x) * 3;
        data.set(border ? [235, 160, 105] : [90 + x, 55 + y, 35 + x / 2], index);
      }
    }
    const base = estimateFilmBase(data, width, height, 3);
    expect(base[0]).toBeGreaterThan(220);
    const anchors = estimateDensityAnchors(data, width, height, 3, base);
    expect(anchors.high.every((value, index) => Number.isFinite(value) && value > anchors.low[index])).toBe(true);
  });

  it('interpolates editable curve anchors and keeps a real 16-bit path', () => {
    expect(evaluateCurve([{ x: 0, y: 0 }, { x: .5, y: .55 }, { x: 1, y: 1 }], .5)).toBeCloseTo(.55, 6);
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    const input = new Uint16Array([10001, 20003, 30007]);
    const output = processRgb16(input, 3, recipe);
    expect(output[0]).toBeGreaterThan(0);
    expect(output.some((value) => value % 257 !== 0)).toBe(true);
  });

  it('keeps neutral density neutral and rolls super-white values smoothly', () => {
    const separated = applyDensitySeparation([.7, .7, .7], 100);
    expect(separated[0]).toBeCloseTo(.7, 6);
    expect(separated[1]).toBeCloseTo(.7, 6);
    expect(separated[2]).toBeCloseTo(.7, 6);
    expect(compressHighlight(1.8, 80)).toBeGreaterThan(1);
    expect(compressHighlight(1.8, 80)).toBeLessThan(1.8);
  });

  it('preserves an unedited regular image within one 8-bit code value', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const input = new Uint8Array([12, 64, 128, 220, 180, 33]);
    expect([...processRgb8(input, 3, recipe)]).toEqual([...input]);
  });

  it('does not apply a second display encoding to normalized negative density', () => {
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.baseRgb = [255, 255, 255];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1, 1, 1];
    // This assertion isolates display-reference encoding from any optional
    // measured channel-separation profile.
    recipe.density.separation = 0;
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const halfDensity = Math.round(linearToSrgb(10 ** -0.5) * 255);
    const output = processRgb8(new Uint8Array([halfDensity, halfDensity, halfDensity]), 3, recipe);
    expect(output[0]).toBeGreaterThanOrEqual(125);
    expect(output[0]).toBeLessThanOrEqual(131);
  });

  it('rejects clipped sprocket holes when re-estimating the film base', () => {
    const width = 100;
    const height = 60;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x < 9 || x >= width - 9 || y < 6 || y >= height - 6;
        const hole = border && ((x + y * 3) % 17 < 3);
        const rgb = hole ? [255, 255, 255] : border ? [232, 158, 99] : [105, 70, 43];
        data.set(rgb, (y * width + x) * 3);
      }
    }
    const estimate = estimateFilmBaseRobust(data, width, height, 3, 'camera_srgb');
    expect(estimate.rgb[0]).toBeGreaterThan(225);
    expect(estimate.rgb[1]).toBeGreaterThan(150);
    expect(estimate.rgb[2]).toBeLessThan(110);
    expect(estimate.confidence).toBeGreaterThan(0.5);
    expect(estimate.status).toBe('ok');
    expect(estimate.sampleCount).toBeGreaterThan(0);
  });

  it('reports a status reason instead of silently returning low confidence', () => {
    const width = 64;
    const height = 48;
    const data = new Uint16Array(width * height * 3);
    // 色相杂乱、没有主导片基色相的边缘：应落入“边缘不集中/样本不足”并给出原因，
    // 而不是假装一切正常。
    for (let index = 0; index < data.length; index += 1) data[index] = 4000 + ((index * 2654435761 >>> 0) % 30000);
    const estimate = estimateFilmBaseRobust(data, width, height, 3, 'camera_srgb', 65535, 'linear');
    expect(['low_samples', 'border_dominated', 'fallback']).toContain(estimate.status);
    const anchors = estimateDensityAnchors(data, width, height, 3, estimate.rgb, {
      inputTransfer: 'linear', maxValue: 65535, baseRgbLinear: estimate.linearRgb,
    });
    expect(['ok', 'fallback', 'low_usable', 'heavily_clipped', 'low_neutral']).toContain(anchors.status);
  });

  it('does not let white sprocket holes lift the automatic positive', () => {
    const width = 120;
    const height = 80;
    const base: [number, number, number] = [232, 158, 99];
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const hole = y > 8 && y < 19 && (x % 24) > 7 && (x % 24) < 16;
        const scene = (x + y) / (width + height);
        const density = 0.08 + scene * 1.35;
        const rgb = hole ? [255, 255, 255] : [0, 1, 2].map((channel) => {
          const baseLinear = srgbToLinear(base[channel] / 255);
          return Math.round(linearToSrgb(baseLinear * 10 ** -(density + channel * .015)) * 255);
        });
        data.set(rgb, (y * width + x) * 3);
      }
    }
    const anchors = estimateDensityAnchors(data, width, height, 3, base, {
      profileId: 'camera_srgb', inputTransfer: 'srgb', neutralProtection: 55,
    });
    expect(anchors.low).toEqual([0, 0, 0]);
    expect(anchors.high[0]).toBeGreaterThan(1);
    expect(anchors.high[0]).toBeLessThan(1.7);
  });

  it('derives channel spans from a co-located neutral population', () => {
    const width = 48;
    const height = 36;
    const base: [number, number, number] = [235, 165, 105];
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x < 4 || x >= width - 4 || y < 3 || y >= height - 3;
        const scene = (x + y) / (width + height);
        const density = border ? [0, 0, 0] : [0.12 + scene * 1.2, 0.18 + scene * 1.05, 0.1 + scene * 0.92];
        const rgb = density.map((value, channel) => {
          const baseLinear = srgbToLinear(base[channel] / 255);
          return Math.round(linearToSrgb(baseLinear * 10 ** -value) * 255);
        });
        data.set(rgb, (y * width + x) * 3);
      }
    }
    const anchors = estimateDensityAnchors(data, width, height, 3, base, {
      profileId: 'camera_srgb', inputTransfer: 'srgb', neutralProtection: 55,
    });
    // The response slopes differ, but every saved RGB anchor must still come
    // from the same neutral-pixel population rather than unrelated tails.
    const spans = anchors.high.map((value, channel) => value - anchors.low[channel]);
    expect(spans[0]).toBeGreaterThan(spans[1]);
    expect(spans[1]).toBeGreaterThan(spans[2]);
    expect(spans.every(Number.isFinite)).toBe(true);
    expect(anchors.confidence).toBeGreaterThan(0.45);
    expect(anchors.shadowCorrection.every(Number.isFinite)).toBe(true);
    expect(anchors.highlightCorrection.every(Number.isFinite)).toBe(true);
  });

  it('does not combine single-channel outliers into an impossible white anchor', () => {
    const width = 120;
    const height = 80;
    const base: [number, number, number] = [236, 164, 104];
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const tone = 0.08 + (x / (width - 1)) * 0.72;
        const density = [tone, tone * 1.45, tone * 1.9];
        // Sparse maxima deliberately occur at different pixel locations.
        if (y < 3 && x < 25) density[0] = 2.6;
        if (y >= 3 && y < 6 && x < 25) density[1] = 2.6;
        if (y >= 6 && y < 9 && x < 25) density[2] = 2.6;
        const rgb = density.map((value, channel) => {
          const baseLinear = srgbToLinear(base[channel] / 255);
          return Math.round(linearToSrgb(baseLinear * 10 ** -value) * 255);
        });
        data.set(rgb, (y * width + x) * 3);
      }
    }
    const anchors = estimateDensityAnchors(data, width, height, 3, base, {
      profileId: 'camera_srgb', inputTransfer: 'srgb', neutralProtection: 55,
    });
    expect(anchors.high[0]).toBeLessThan(1.2);
    expect(anchors.high[1]).toBeLessThan(1.6);
    expect(anchors.high[2]).toBeLessThan(2.1);
    expect(anchors.high[0]).toBeLessThan(anchors.high[1]);
    expect(anchors.high[1]).toBeLessThan(anchors.high[2]);
  });

  it('estimates different bounded colour corrections across the density range', () => {
    const width = 80;
    const height = 50;
    const base: [number, number, number] = [238, 168, 108];
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const tone = (x + y / height) / width;
        const density = 0.08 + tone * 1.35;
        const crossover = tone < .5 ? .045 : -.035;
        const densities = [density + crossover, density - crossover * .55, density - crossover * .35];
        const rgb = densities.map((value, channel) => {
          const baseLinear = srgbToLinear(base[channel] / 255);
          return Math.round(linearToSrgb(baseLinear * 10 ** -value) * 255);
        });
        data.set(rgb, (y * width + x) * 3);
      }
    }
    const anchors = estimateDensityAnchors(data, width, height, 3, base, {
      profileId: 'camera_srgb',
      filmProfileId: 'generic_color_negative',
      inputTransfer: 'srgb',
      neutralProtection: 100,
    });
    expect(anchors.shadowCorrection[0]).toBeGreaterThan(anchors.highlightCorrection[0]);
    expect(Math.max(...anchors.shadowCorrection.map(Math.abs))).toBeLessThan(0.15);
    expect(Math.max(...anchors.highlightCorrection.map(Math.abs))).toBeLessThan(0.15);
  });
});
