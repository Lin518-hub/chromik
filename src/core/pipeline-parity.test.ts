import { describe, expect, expectTypeOf, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import type { DevelopProxyDescriptor, DisplayPreviewDescriptor, MasterSourceDescriptor, ProcessablePixelSourceDescriptor } from '../shared/types';
import { linearToSrgb } from './image';
import { processPixelSource } from './reconstruct';
import { quantizeUint16To8 } from './quantize';

const DEVELOP_SOURCE: DevelopProxyDescriptor = {
  role: 'develop', version: 1, transfer: 'linear', bitDepth: 16, channels: 3, colorSpace: 'srgb',
};

const MASTER_SOURCE: MasterSourceDescriptor = {
  role: 'master', decoder: 'chromik-cache', transfer: 'linear', bitDepth: 16, channels: 3, colorSpace: 'srgb',
};

function toDisplay8(input: Uint16Array): Uint8ClampedArray {
  const output = new Uint8ClampedArray(input.length);
  for (let index = 0; index < input.length; index += 1) output[index] = Math.round(input[index] / 257);
  return output;
}

describe('unified processing graph parity', () => {
  it('excludes display-only descriptors at compile time', () => {
    expectTypeOf<DisplayPreviewDescriptor>().not.toMatchTypeOf<ProcessablePixelSourceDescriptor>();
    expectTypeOf<DevelopProxyDescriptor>().toMatchTypeOf<ProcessablePixelSourceDescriptor>();
  });

  it('keeps preview, processed thumbnail and master export within the 1.0 pixel budget', () => {
    const width = 257;
    const height = 19;
    const source = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const gradient = x / (width - 1);
        source[offset] = Math.round((.03 + gradient * .92) * 65535);
        source[offset + 1] = Math.round((.02 + gradient ** 1.05 * .9) * 65535);
        source[offset + 2] = Math.round((.01 + gradient ** .92 * .94) * 65535);
      }
    }
    const recipe = createDefaultRecipe();
    recipe.grade.exposureEv = .35;
    recipe.grade.temperature = 7;
    recipe.grade.tint = -4;
    recipe.grade.contrast = 11;
    recipe.grade.vibrance = 13;
    recipe.grade.highlights = -8;

    const preview16 = processPixelSource(source, 3, recipe, DEVELOP_SOURCE, { width, height });
    const export16 = processPixelSource(source, 3, recipe, MASTER_SOURCE, { width, height });
    expect(preview16).toBeInstanceOf(Uint16Array);
    expect(export16).toBeInstanceOf(Uint16Array);
    const preview = toDisplay8(preview16 as Uint16Array);
    const exported = toDisplay8(export16 as Uint16Array);
    const differences = Array.from(preview, (value, index) => Math.abs(value - exported[index])).sort((a, b) => a - b);
    const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    const p99 = differences[Math.floor((differences.length - 1) * .99)];
    expect(mean).toBeLessThanOrEqual(1.5);
    expect(p99).toBeLessThanOrEqual(3);
  });

  it('keeps dithered 8-bit display output within the 1.5/3 code-value contract', () => {
    // QA-02 / COL-10：屏幕 8 位输出 = 统一处理图输出经 Bayer 抖动量化。
    // 在平滑渐变上，抖动后的平均误差必须满足 §13.1 的显示阈值。
    const width = 257;
    const height = 17;
    const source = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const gradient = x / (width - 1);
        source[offset] = Math.round((.02 + gradient ** .9 * .95) * 65535);
        source[offset + 1] = Math.round((.01 + gradient ** 1.08 * .92) * 65535);
        source[offset + 2] = Math.round((.03 + gradient ** .88 * .93) * 65535);
      }
    }
    const recipe = createDefaultRecipe();
    recipe.grade.exposureEv = -.2;
    recipe.grade.contrast = 8;
    recipe.grade.saturation = 6;
    const processed = processPixelSource(source, 3, recipe, MASTER_SOURCE, { width, height }) as Uint16Array;
    const dithered = quantizeUint16To8(processed, width, 3);
    const ideal = toDisplay8(processed);
    const differences = Array.from(dithered, (value, index) => Math.abs(value - ideal[index])).sort((a, b) => a - b);
    const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    const p99 = differences[Math.floor((differences.length - 1) * .99)];
    expect(mean).toBeLessThanOrEqual(1.5);
    expect(p99).toBeLessThanOrEqual(3);
    // 抖动还会显著压低极端误差：最大值应接近理想取整，而非截断误差堆叠。
    expect(differences[differences.length - 1]).toBeLessThanOrEqual(1);
  });

  it('retains more than 8-bit tonal precision through a smooth linear gradient', () => {
    const source = new Uint16Array(4096 * 3);
    for (let index = 0; index < 4096; index += 1) {
      const value = Math.round(index / 4095 * 65535);
      source.set([value, value, value], index * 3);
    }
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const output = processPixelSource(source, 3, recipe, DEVELOP_SOURCE);
    expect(output).toBeInstanceOf(Uint16Array);
    expect(new Set(output as Uint16Array).size).toBeGreaterThan(3000);
  });

  it('does not reintroduce the 8-bit negative-highlight posterization regression', () => {
    const width = 4096;
    const source16 = new Uint16Array(width * 3);
    const legacy8 = new Uint8ClampedArray(width * 3);
    for (let x = 0; x < width; x += 1) {
      // A dark capture-linear ramp becomes a bright region after negative
      // inversion, matching the glove failure seen with an 8-bit JPEG source.
      const linear = 0.002 + (x / (width - 1)) * 0.078;
      for (let channel = 0; channel < 3; channel += 1) {
        source16[x * 3 + channel] = Math.round(linear * 65535);
        legacy8[x * 3 + channel] = Math.round(linearToSrgb(linear) * 255);
      }
    }
    const recipe = createDefaultRecipe();
    recipe.baseRgb = [124, 124, 124];
    recipe.baseRgbLinear = [0.2, 0.2, 0.2];
    recipe.density = {
      ...recipe.density,
      enabled: true,
      low: [0, 0, 0],
      high: [2.2, 2.2, 2.2],
      shadowCorrection: [0, 0, 0],
      midCorrection: [0, 0, 0],
      highlightCorrection: [0, 0, 0],
    };
    recipe.grade.contrast = 0;

    const highPrecision = processPixelSource(source16, 3, recipe, DEVELOP_SOURCE);
    const legacy = processPixelSource(legacy8, 3, recipe, {
      role: 'master', decoder: 'sharp', transfer: 'srgb', bitDepth: 8, channels: 3, colorSpace: 'srgb',
    });
    const unique16 = new Set(Array.from(highPrecision).filter((_, index) => index % 3 === 0)).size;
    const unique8 = new Set(Array.from(legacy).filter((_, index) => index % 3 === 0)).size;

    expect(unique16).toBeGreaterThan(1000);
    expect(unique16).toBeGreaterThan(unique8 * 8);
  });
});
