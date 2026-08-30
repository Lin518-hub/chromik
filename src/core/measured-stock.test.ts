import { describe, expect, it } from 'vitest';
import { getMeasuredHdLuts } from '../shared/measured-stock-profiles';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';

function isMonotone(lut: Float32Array): boolean {
  for (let index = 1; index < lut.length; index += 1) {
    if (lut[index] < lut[index - 1]) return false;
  }
  return true;
}

describe('measured stock H-D curves', () => {
  it('builds monotone inverse LUTs from the Portra 400 datasheet curve', () => {
    const lut = getMeasuredHdLuts('kodak_portra_400');
    expect(lut).toBeDefined();
    expect(lut!.luts.length).toBe(3);
    for (const channel of lut!.luts) {
      expect(channel[0]).toBeCloseTo(0, 5);
      expect(channel[channel.length - 1]).toBeCloseTo(1, 5);
      expect(isMonotone(channel)).toBe(true);
      expect(channel.every(Number.isFinite)).toBe(true);
    }
  });

  it('maps the Fujifilm generic ids to the measured dataset ids', () => {
    expect(getMeasuredHdLuts('fujifilm_pro400h')).toBeDefined();
    expect(getMeasuredHdLuts('fujifilm_superia_400')).toBeDefined();
    expect(getMeasuredHdLuts('fujifilm_c200')).toBeDefined();
  });

  it('returns undefined for stocks with no measured data', () => {
    expect(getMeasuredHdLuts('ilford_hp5_plus')).toBeUndefined();
    expect(getMeasuredHdLuts('kodak_tmax_400')).toBeUndefined();
  });

  it('shapes the tone differently from the generic toe/shoulder fallback', () => {
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;
    recipe.baseRgb = [255, 255, 255];
    recipe.density.low = [0, 0, 0];
    recipe.density.high = [1, 1, 1];
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    recipe.density.filmStockProfileId = 'kodak_portra_400';
    const measured = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    recipe.density.filmStockProfileId = undefined;
    const generic = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    expect(measured).not.toEqual(generic);
  });
});
