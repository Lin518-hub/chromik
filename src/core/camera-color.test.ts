import { describe, expect, it } from 'vitest';
import { cameraRgb16ToLinearSrgb16, cameraRgb16ToLinearSrgb16InPlace, cameraRgb16ToLinearSrgb16InPlaceRange, parseCameraToSrgbMatrix, type Matrix3x3 } from './camera-color';

const IDENTITY: Matrix3x3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe('signed camera RGB conversion', () => {
  it('preserves in-gamut samples through an identity matrix', () => {
    const source = new Uint16Array([0, 1, 65_535, 1_234, 32_768, 60_000]);
    expect(cameraRgb16ToLinearSrgb16(source, IDENTITY)).toEqual(source);
  });

  it('can convert in place without allocating a second full-resolution carrier', () => {
    const source = new Uint16Array([10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
    const expected = cameraRgb16ToLinearSrgb16(source, IDENTITY);
    const result = cameraRgb16ToLinearSrgb16InPlace(source, IDENTITY);
    expect(result).toBe(source);
    expect(result).toEqual(expected);
  });

  it('compresses a negative matrix result around the neutral axis instead of clipping one channel', () => {
    const matrix: Matrix3x3 = [
      [1.4, -0.7, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const converted = cameraRgb16ToLinearSrgb16(new Uint16Array([8_000, 30_000, 20_000]), matrix);
    expect(converted[0]).toBe(0);
    expect(converted[1]).toBeGreaterThan(0);
    expect(converted[2]).toBeGreaterThan(0);
    const inputSigned = [1.4 * 8_000 / 65_535 - 0.7 * 30_000 / 65_535, 30_000 / 65_535, 20_000 / 65_535];
    const beforeLuma = 0.2126 * inputSigned[0] + 0.7152 * inputSigned[1] + 0.0722 * inputSigned[2];
    const afterLuma = (0.2126 * converted[0] + 0.7152 * converted[1] + 0.0722 * converted[2]) / 65_535;
    expect(Math.abs(afterLuma - beforeLuma)).toBeLessThan(2 / 65_535);
  });

  it('scales super-white RGB as a triplet and validates metadata matrices', () => {
    const matrix: Matrix3x3 = [
      [2, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
    ];
    const converted = cameraRgb16ToLinearSrgb16(new Uint16Array([40_000, 20_000, 10_000]), matrix);
    expect(converted[0]).toBe(65_535);
    expect(converted[1]).toBeCloseTo(32_768, -1);
    expect(converted[2]).toBeCloseTo(16_384, -1);
    expect(parseCameraToSrgbMatrix([[1, 0, 0, 9], [0, 1, 0, 9], [0, 0, 1, 9]])).toEqual(IDENTITY);
    expect(parseCameraToSrgbMatrix([[1, 0], [0, 1], [0, 0]])).toBeUndefined();
  });
});

describe('camera color ranged transform', () => {
  it('matches the whole-array transform when applied in chunks', () => {
    const matrix: Matrix3x3 = [
      [1.2, -0.1, 0.0],
      [-0.05, 1.1, -0.02],
      [0.0, -0.08, 1.05],
    ];
    const whole = new Uint16Array(300).map((_, index) => (index * 9973) % 65536);
    const expected = cameraRgb16ToLinearSrgb16InPlace(whole.slice(), matrix);
    const chunked = whole.slice();
    for (let start = 0; start < chunked.length; start += 99) {
      cameraRgb16ToLinearSrgb16InPlaceRange(chunked, matrix, start, start + 99);
    }
    expect([...chunked]).toEqual([...expected]);
  });
});
