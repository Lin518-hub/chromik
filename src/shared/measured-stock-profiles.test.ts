import { describe, expect, it } from 'vitest';
import { getMeasuredHdLuts } from './measured-stock-profiles';

const LUT_SIZE = 256;

/** Stocks with a full 3-channel `sensiometricCurve` in the measured dataset. */
const MAPPED_STOCKS = [
  'fujifilm_pro400h',
  'fujifilm_superia_400',
  'fujifilm_c200',
  'kodak_portra_160',
  'kodak_portra_400',
  'kodak_ektar_100',
  'kodak_gold_200',
  'kodak_ultramax_400',
];

/** Stocks that must NOT resolve to measured data (missing or incomplete in dataset). */
const UNMAPPED_STOCKS = ['kodak_portra_800', 'kodak_trix_400', 'ilford_hp5_plus'];

function expectValidLut(lut: Float32Array): void {
  expect(lut).toBeInstanceOf(Float32Array);
  expect(lut).toHaveLength(LUT_SIZE);
  for (let index = 0; index < lut.length; index += 1) {
    expect(lut[index]).toBeGreaterThanOrEqual(0);
    expect(lut[index]).toBeLessThanOrEqual(1);
    if (index > 0) {
      expect(lut[index]).toBeGreaterThanOrEqual(lut[index - 1]);
    }
  }
}

describe('measured stock profiles (H-D curves)', () => {
  it('returns a valid 256-entry monotonic [0,1] LUT per channel for every mapped stock', () => {
    for (const stockId of MAPPED_STOCKS) {
      const result = getMeasuredHdLuts(stockId);
      expect(result, `expected measured H-D luts for ${stockId}`).toBeDefined();
      expect(result!.luts).toHaveLength(3);
      for (const channel of result!.luts) {
        expectValidLut(channel);
      }
    }
  });

  it('returns undefined for stocks missing from the dataset or without 3 curves', () => {
    for (const stockId of UNMAPPED_STOCKS) {
      expect(getMeasuredHdLuts(stockId), `expected no measured H-D luts for ${stockId}`).toBeUndefined();
    }
  });
});
