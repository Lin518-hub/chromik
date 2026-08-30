import { describe, expect, it } from 'vitest';
import { FILM_STOCK_PROFILES, getFilmStockProfile, suggestFilmStockProfile } from './film-stock-profiles';

describe('film stock profiles', () => {
  it('suggests a profile from a roll film-stock string', () => {
    expect(suggestFilmStockProfile('KODAK PORTRA 400')?.id).toBe('kodak_portra_400');
    expect(suggestFilmStockProfile('Ilford HP5 Plus')?.id).toBe('ilford_hp5_plus');
    expect(suggestFilmStockProfile('Fujifilm Superia 400')?.id).toBe('fujifilm_superia_400');
    expect(suggestFilmStockProfile('Fuji C200')?.id).toBe('fujifilm_c200');
    expect(suggestFilmStockProfile('')).toBeUndefined();
    expect(suggestFilmStockProfile('Some Unknown Stock')).toBeUndefined();
  });

  it('keeps every profile honest: generic, unmeasured, valid knee range', () => {
    for (const profile of FILM_STOCK_PROFILES) {
      expect(profile.measured).toBe(false);
      expect(profile.version).toBe('generic-1');
      expect(profile.toeKnee).toBeLessThan(profile.shoulderKnee);
      expect(profile.separation).toBeGreaterThanOrEqual(0);
      expect(profile.separation).toBeLessThanOrEqual(100);
    }
  });

  it('looks up by id and rejects unknown ids', () => {
    expect(getFilmStockProfile('kodak_ektar_100')?.label).toContain('Ektar');
    expect(getFilmStockProfile('nope')).toBeUndefined();
  });
});
