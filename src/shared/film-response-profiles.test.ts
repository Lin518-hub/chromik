import { describe, expect, it } from 'vitest';
import { FILM_RESPONSE_PROFILES, filmResponseProfileForType } from './film-response-profiles';

describe('versioned film response profiles', () => {
  it('keeps generic profiles explicit and auditable', () => {
    expect(FILM_RESPONSE_PROFILES.generic_color_negative).toMatchObject({
      measured: false,
      version: 'generic-1',
      crossoverCorrection: true,
    });
    expect(FILM_RESPONSE_PROFILES.generic_bw_negative.crossoverCorrection).toBe(false);
  });

  it('selects the black-and-white response without a user-facing engine choice', () => {
    expect(filmResponseProfileForType('color_negative')).toBe('generic_color_negative');
    expect(filmResponseProfileForType('bw_negative')).toBe('generic_bw_negative');
  });
});
