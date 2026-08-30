import { describe, expect, it } from 'vitest';
import {
  applyGeometry,
  correctLensAndStraightenPixels,
  mapUnitSquareToQuad,
  orientNormalizedPoint,
  unorientNormalizedPoint,
} from './geometry';
import { createDefaultRecipe } from '../shared/defaults';
import type { Quad } from '../shared/types';

describe('geometry pipeline', () => {
  it('maps unit-square corners onto the selected quadrilateral', () => {
    const quad: Quad = [{ x: .1, y: .2 }, { x: .9, y: .1 }, { x: .8, y: .9 }, { x: .2, y: .8 }];
    expect(mapUnitSquareToQuad(0, 0, quad)).toEqual(quad[0]);
    expect(mapUnitSquareToQuad(1, 1, quad).x).toBeCloseTo(quad[2].x, 6);
  });

  it('rotates and flips a raster without changing its samples', () => {
    const recipe = createDefaultRecipe();
    recipe.geometry.rotation90 = 1;
    recipe.geometry.flipX = true;
    const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const result = applyGeometry(input, 2, 3, 1, recipe.geometry);
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect([...result.data].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps crop handle coordinates reversible through every orientation', () => {
    const point = { x: .17, y: .73 };
    for (const rotation90 of [0, 1, 2, 3] as const) {
      for (const flipX of [false, true]) {
        for (const flipY of [false, true]) {
          const geometry = { ...createDefaultRecipe().geometry, rotation90, flipX, flipY };
          const restored = unorientNormalizedPoint(orientNormalizedPoint(point, geometry), geometry);
          expect(restored.x).toBeCloseTo(point.x, 12);
          expect(restored.y).toBeCloseTo(point.y, 12);
        }
      }
    }
  });

  it('keeps the centre stable during straighten and lens correction', () => {
    const width = 9;
    const height = 9;
    const input = new Uint8Array(width * height);
    input[4 * width + 4] = 255;
    const result = correctLensAndStraightenPixels(input, width, height, 1, { straighten: 4, lensDistortion: 30 });
    expect(result.data[4 * width + 4]).toBeGreaterThan(200);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
  });
});
