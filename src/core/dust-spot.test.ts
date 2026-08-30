import { describe, expect, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';

describe('dust spot healing', () => {
  it('replaces a bright dust pixel with the surrounding mean', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const width = 20;
    const height = 20;
    const input = new Uint8Array(width * height * 3).fill(100);
    const centerIndex = (10 * width + 10) * 3;
    input[centerIndex] = 250;
    input[centerIndex + 1] = 250;
    input[centerIndex + 2] = 250;
    recipe.spots = [{ x: 10.5 / width, y: 10.5 / height, r: 2.5 / Math.min(width, height) }];
    const output = processRgb8(input, 3, recipe, { width, height });
    expect(output[centerIndex]).toBeLessThan(150);
    // A far pixel is untouched.
    const farIndex = (2 * width + 2) * 3;
    expect(output[farIndex]).toBeGreaterThanOrEqual(95);
  });

  it('is a no-op when there are no spots', () => {
    const recipe = createDefaultRecipe();
    recipe.grade.contrast = 0;
    recipe.grade.highlightRolloff = 0;
    const input = new Uint8Array(9).fill(128);
    const output = processRgb8(input, 3, recipe, { width: 1, height: 1 });
    expect([...output]).toEqual([...input]);
  });
});
