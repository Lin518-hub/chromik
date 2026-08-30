import { describe, expect, it } from 'vitest';
import { applyCubeLut, parseCubeLut } from './cube';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';

describe('cube LUT', () => {
  it('parses and samples a 1D LUT', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 2\n0.0 0.0 0.0\n1.0 1.0 1.0\n');
    expect(lut.type).toBe('1d');
    expect(lut.size).toBe(2);
    expect(applyCubeLut(lut, 0, 0.5, 1)).toEqual([0, 0.5, 1]);
  });

  it('honours the LUT input domain', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 2\nDOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 1 1 1\n0 0 0\n1 1 1\n');
    expect(applyCubeLut(lut, 0, 0, 0)).toEqual([0.5, 0.5, 0.5]);
  });

  it('parses and samples a 3D identity LUT', () => {
    const lines = ['LUT_3D_SIZE 2'];
    for (let b = 0; b <= 1; b += 1) for (let g = 0; g <= 1; g += 1) for (let r = 0; r <= 1; r += 1) lines.push(`${r} ${g} ${b}`);
    const lut = parseCubeLut(lines.join('\n'));
    expect(lut.type).toBe('3d');
    expect(applyCubeLut(lut, 0.5, 0.5, 0.5)).toEqual([0.5, 0.5, 0.5]);
  });

  it('rejects a LUT with missing data', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 4\n0 0 0\n')).toThrow();
  });
});

describe('grade effects', () => {
  it('CMY cyan reduces red channel', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    recipe.grade.cmy = { cyan: 50, magenta: 0, yellow: 0, density: 0 };
    const input = new Uint8Array([200, 200, 200]);
    const output = processRgb8(input, 3, recipe);
    expect(output[0]).toBeLessThan(output[1]);
  });

  it('vignette darkens the corner more than the centre', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    recipe.grade.vignette = { strength: 80, midpoint: 20, roundness: 0 };
    const width = 5;
    const height = 5;
    const input = new Uint8Array(width * height * 3).fill(128);
    const output = processRgb8(input, 3, recipe, { width, height });
    const center = output[(2 * width + 2) * 3];
    const corner = output[0];
    expect(corner).toBeLessThan(center);
  });

  it('negative vignette strength corrects by lifting the corner', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    recipe.grade.vignette = { strength: -50, midpoint: 20, roundness: 0 };
    const input = new Uint8Array(5 * 5 * 3).fill(80);
    const output = processRgb8(input, 3, recipe, { width: 5, height: 5 });
    expect(output[0]).toBeGreaterThan(output[(2 * 5 + 2) * 3]);
  });

  it('cineon mode keeps a mid density in range', () => {
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.density.mode = 'cineon';
    recipe.baseRgb = [255, 255, 255];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1, 1, 1];
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const output = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    const white = processRgb8(new Uint8Array([0, 0, 0]), 3, recipe);
    expect(output[0]).toBeGreaterThan(0);
    expect(output[0]).toBeLessThan(white[0]);
    expect(white[0]).toBeGreaterThan(245);
  });

  it('light source normalization does not invent a negative density offset', () => {
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.baseRgb = [255, 255, 255];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1, 1, 1];
    recipe.density.lightSourceRgb = [255, 200, 200];
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const corrected = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    recipe.density.lightSourceRgb = undefined;
    const uncorrected = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    expect(corrected).toEqual(uncorrected);
  });

  it('positive CMYD density darkens rather than brightens', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    recipe.grade.cmy = { cyan: 0, magenta: 0, yellow: 0, density: 50 };
    const output = processRgb8(new Uint8Array([180, 180, 180]), 3, recipe);
    expect(output[0]).toBeLessThan(180);
  });
});
