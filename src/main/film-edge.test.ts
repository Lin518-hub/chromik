import { describe, expect, it } from 'vitest';
import { parseFilmEdgeText } from './film-edge';

describe('film edge parser', () => {
  it('recognizes common color-negative stock and ISO', () => {
    expect(parseFilmEdgeText('KODAK PORTRA 400  12A')).toEqual({
      filmType: 'color_negative', filmStock: 'Kodak Portra 400', iso: 400,
    });
  });

  it('recognizes black-and-white edge markings', () => {
    expect(parseFilmEdgeText('ILFORD HP5 PLUS')).toEqual({
      filmType: 'bw_negative', filmStock: 'Ilford HP5 Plus', iso: 400,
    });
  });
});
