import { describe, expect, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';

function densityRecipe(): ReturnType<typeof createDefaultRecipe> {
  const recipe = createDefaultRecipe();
  recipe.density.enabled = true;
  recipe.baseRgb = [255, 255, 255];
  recipe.density.low = [0, 0, 0];
  recipe.density.high = [1, 1, 1];
  recipe.grade.contrast = 0;
  recipe.grade.highlightRolloff = 0;
  return recipe;
}

describe('per-stock rendering effects', () => {
  it('custom separation matrix bleeds channels in density space', () => {
    const recipe = densityRecipe();
    recipe.density.separation = 100;
    // Strong green bleed into red.
    recipe.density.separationMatrix = [1, 0.5, 0, 0, 1, 0, 0, 0, 1];
    const bled = processRgb8(new Uint8Array([128, 64, 64]), 3, recipe);
    recipe.density.separationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const identity = processRgb8(new Uint8Array([128, 64, 64]), 3, recipe);
    expect(bled[0]).toBeGreaterThan(identity[0]);
  });

  it('toe compresses blacks and shoulder rolls off whites', () => {
    const recipe = densityRecipe();
    recipe.density.filmStockProfileId = 'kodak_portra_800'; // no measured data; toe 0.08, shoulder 0.84
    // A very low normalized density (bright scan / dark positive) sits in the toe.
    const dark = processRgb8(new Uint8Array([250, 250, 250]), 3, recipe);
    recipe.density.filmStockProfileId = undefined;
    const plainDark = processRgb8(new Uint8Array([250, 250, 250]), 3, recipe);
    expect(dark[0]).toBeLessThan(plainDark[0]);

    recipe.density.filmStockProfileId = 'kodak_portra_800';
    const bright = processRgb8(new Uint8Array([20, 20, 20]), 3, recipe);
    recipe.density.filmStockProfileId = undefined;
    const plainBright = processRgb8(new Uint8Array([20, 20, 20]), 3, recipe);
    expect(bright[0]).toBeLessThanOrEqual(plainBright[0]);
  });

  it('three-band crossover: a mid correction shifts the midtone, not the clamped white', () => {
    const recipe = densityRecipe();
    recipe.density.shadowCorrection = [0, 0, 0];
    recipe.density.midCorrection = [0.25, 0, 0];
    recipe.density.highlightCorrection = [0, 0, 0];
    const withMid = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    recipe.density.midCorrection = [0, 0, 0];
    const withoutMid = processRgb8(new Uint8Array([128, 128, 128]), 3, recipe);
    // A positive mid correction subtracts red density -> the red channel darkens.
    expect(withMid[0]).toBeLessThan(withoutMid[0]);
    expect(withMid[1]).toBe(withoutMid[1]);

    // A far-highlight scan is clamped to white either way.
    const withMidBright = processRgb8(new Uint8Array([10, 10, 10]), 3, recipe);
    recipe.density.midCorrection = [0, 0, 0];
    const withoutMidBright = processRgb8(new Uint8Array([10, 10, 10]), 3, recipe);
    expect(withMidBright[0]).toBe(withoutMidBright[0]);
  });
});
