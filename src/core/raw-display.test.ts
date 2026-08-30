import { describe, expect, it } from 'vitest';
import {
  liftLinearRawDisplayProxy16,
  liftLinearRawDisplayProxy16To16,
  liftRawDisplayProxy,
  liftRawDisplayProxy16,
  linear16ToSrgb8,
  linear16ToSrgb16,
  preparePositiveRawLinear16,
  RAW_DISPLAY_EXPOSURE_SHIFT,
  srgb16ToLinear16,
  srgb8ToLinear16,
} from './raw-display';

describe('RAW display proxy', () => {
  it('brightens the view without mutating the processing-neutral source', () => {
    const source = new Uint8ClampedArray([45, 45, 45, 120, 170, 240]);
    const display = liftRawDisplayProxy(source);
    expect([...source]).toEqual([45, 45, 45, 120, 170, 240]);
    expect(display[0]).toBeGreaterThan(80);
    expect(display[1]).toBe(display[0]);
    expect(display[2]).toBe(display[0]);
    expect(display[3]).toBeGreaterThan(source[3]);
    expect(display[3]).toBeLessThan(display[4]);
    expect(display[4]).toBeLessThan(display[5]);
  });

  it('uses a soft highlight shoulder instead of clipping adjacent 16-bit tones', () => {
    const source = new Uint16Array([
      18_000, 18_000, 18_000,
      19_000, 19_000, 19_000,
      20_000, 20_000, 20_000,
      21_000, 21_000, 21_000,
      22_000, 22_000, 22_000,
    ]);
    const display = liftRawDisplayProxy16(source);
    const gradient = [display[0], display[3], display[6], display[9], display[12]];
    expect(gradient).toEqual([...gradient].sort((a, b) => a - b));
    expect(new Set(display).size).toBeGreaterThanOrEqual(4);
    expect(display[display.length - 1]).toBeLessThan(255);
  });

  it('round-trips sRGB through the canonical linear representation', () => {
    const source = new Uint8ClampedArray([0, 32, 64, 128, 192, 255]);
    const display = linear16ToSrgb8(srgb8ToLinear16(source));
    expect([...display]).toEqual([...source]);
    const source16 = new Uint16Array([0, 4096, 32768, 65535]);
    const linear = srgb16ToLinear16(source16);
    expect(linear[0]).toBe(0);
    expect(linear[3]).toBe(65535);
    expect(linear[2]).toBeLessThan(source16[2]);
  });

  it('lifts canonical linear RAW without decoding it as sRGB twice', () => {
    const source = new Uint16Array([1000, 2000, 3000, 8000, 12000, 16000]);
    const display = liftLinearRawDisplayProxy16(source);
    expect(display[0]).toBeLessThan(display[1]);
    expect(display[1]).toBeLessThan(display[2]);
    expect(display[3]).toBeLessThan(display[4]);
    expect(display[4]).toBeLessThan(display[5]);
  });

  it('retains sub-8-bit gradation in 16-bit display transforms', () => {
    const source = new Uint16Array([10_000, 10_001, 10_002, 20_000, 20_001, 20_002]);
    const neutral = linear16ToSrgb16(source);
    const legacy = liftLinearRawDisplayProxy16To16(source);
    expect(neutral.some((value) => value % 257 !== 0)).toBe(true);
    expect(legacy.some((value) => value % 257 !== 0)).toBe(true);
    expect([...linear16ToSrgb8(source)]).toEqual([...neutral].map((value) => Math.round(value / 257)));
  });

  it('uses a fixed +2 EV view transform instead of hiding capture-to-capture exposure differences', () => {
    expect(RAW_DISPLAY_EXPOSURE_SHIFT).toBe(4);
    const darker = liftLinearRawDisplayProxy16(new Uint16Array([2_000, 2_000, 2_000]));
    const brighter = liftLinearRawDisplayProxy16(new Uint16Array([4_000, 4_000, 4_000]));
    const together = liftLinearRawDisplayProxy16(new Uint16Array([
      2_000, 2_000, 2_000,
      4_000, 4_000, 4_000,
    ]));
    expect([...together.slice(0, 3)]).toEqual([...darker]);
    expect([...together.slice(3, 6)]).toEqual([...brighter]);
    expect(brighter[0]).toBeGreaterThan(darker[0]);
  });

  it('prepares legacy RAW in linear space so the shared grade graph can still run', () => {
    const source = new Uint16Array([4_000, 8_000, 12_000]);
    const neutral = preparePositiveRawLinear16(source, 'linear', 'camera-raw-neutral');
    const legacy = preparePositiveRawLinear16(source, 'linear', 'camera-raw-legacy-lift');
    expect(neutral).toBe(source);
    expect(legacy[0]).toBeGreaterThan(source[0]);
    expect(legacy[1]).toBeGreaterThan(source[1]);
    expect(legacy[2]).toBeGreaterThan(source[2]);
  });

  it('decodes legacy sRGB carriers before entering the linear graph', () => {
    const encoded = new Uint16Array([32_768, 32_768, 32_768]);
    const prepared = preparePositiveRawLinear16(encoded, 'srgb', 'camera-raw-neutral');
    expect(prepared[0]).toBeGreaterThan(13_000);
    expect(prepared[0]).toBeLessThan(15_000);
  });
});
