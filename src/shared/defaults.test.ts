import { describe, expect, it } from 'vitest';
import { createRecipeForFilmType, migrateRecipe } from './defaults';

describe('film-type defaults', () => {
  it('uses the soft density rendering intent only for negatives', () => {
    const colourNegative = createRecipeForFilmType('color_negative');
    expect(colourNegative.density.mode).toBe('cineon');
    expect(colourNegative.grade.contrast).toBe(0);
    expect(colourNegative.grade.temperature).toBeGreaterThan(0);

    const blackAndWhiteNegative = createRecipeForFilmType('bw_negative');
    expect(blackAndWhiteNegative.density.mode).toBe('cineon');
    expect(blackAndWhiteNegative.grade.temperature).toBe(0);
    expect(blackAndWhiteNegative.grade.blackAndWhite).toBe(true);

    const slide = createRecipeForFilmType('color_slide');
    expect(slide.density.mode).toBe('display_reference');
    expect(slide.grade.contrast).toBe(8);
    expect(slide.grade.temperature).toBe(0);
  });
});

describe('recipe migration', () => {
  it('upgrades a demo-1 recipe without losing its grade or crop', () => {
    const migrated = migrateRecipe({
      schemaVersion: 1,
      algorithmVersion: 'demo-1',
      crop: { x: .1, y: .2, width: .7, height: .6 },
      density: { enabled: true, low: [.1, .2, .3], high: [1, 1.1, 1.2], mode: 'approximate' },
      grade: { exposureEv: .5, temperature: 4, tint: 0, contrast: 12, gamma: 1, saturation: 3, highlights: 0, shadows: 0 },
      updatedAt: 123,
    });
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.algorithmVersion).toBe('chromik-5');
    expect(migrated.density.mode).toBe('display_reference');
    expect(migrated.density.profileId).toBe('camera_srgb');
    expect(migrated.density.inputTransfer).toBe('srgb');
    expect(migrated.density.shadowCorrection).toEqual([0, 0, 0]);
    expect(migrated.grade.exposureEv).toBe(.5);
    expect(migrated.geometry.corners[0]).toEqual({ x: .1, y: .2 });
    expect(migrated.grade.curves.rgb).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('preserves a saved chromik-5 algorithm until an explicit upgrade', async () => {
    const { upgradeRecipeToCurrent } = await import('./defaults');
    const legacy = migrateRecipe({ schemaVersion: 5, algorithmVersion: 'chromik-5', baseRgb: [200, 150, 100], grade: { exposureEv: .4 } });
    expect(legacy.algorithmVersion).toBe('chromik-5');
    expect(legacy.baseRgbLinear).toBeUndefined();
    const upgraded = upgradeRecipeToCurrent(legacy);
    expect(upgraded).toMatchObject({ schemaVersion: 6, algorithmVersion: 'chromik-6' });
    expect(upgraded.baseRgbLinear?.[0]).toBeCloseTo(.578, 2);
    expect(legacy.algorithmVersion).toBe('chromik-5');
  });

  it('migrates fixed five-point curves to editable anchors', () => {
    const migrated = migrateRecipe({ grade: { curves: { rgb: [0, .2, .55, .8, 1] } } });
    expect(migrated.grade.curves.rgb[2]).toEqual({ x: .5, y: .55 });
  });

  it('removes legacy control points that do not change a straight curve', () => {
    const migrated = migrateRecipe({ grade: { curves: { rgb: [0, .25, .5, .75, 1] } } });
    expect(migrated.grade.curves.rgb).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('removes the unmeasured version 3 default separation while preserving explicit choices', () => {
    expect(migrateRecipe({ schemaVersion: 3, density: { separation: 35 } }).density.separation).toBe(0);
    expect(migrateRecipe({ schemaVersion: 3, density: { separation: 12 } }).density.separation).toBe(12);
    expect(migrateRecipe({ schemaVersion: 4, density: { engine: 'adaptive', separation: 35 } }).density.separation).toBe(35);
  });

  it('converts explicit legacy encoded-density anchors into the new linear model', () => {
    const migrated = migrateRecipe({
      schemaVersion: 4,
      baseRgb: [255, 200, 140],
      density: { engine: 'classic', low: [0, 0, 0], high: [1, 1, 1] },
    });
    expect(migrated.density.high[0]).toBeGreaterThan(1.8);
    expect('engine' in migrated.density).toBe(false);
  });
});
