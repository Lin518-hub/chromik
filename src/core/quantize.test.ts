import { describe, expect, it } from 'vitest';
import { quantizeUint16To8 } from './quantize';

describe('deterministic 8-bit output quantization', () => {
  it('is deterministic and stays within one code of ordinary rounding', () => {
    const width = 64;
    const source = new Uint16Array(width * 8 * 3);
    for (let index = 0; index < source.length; index += 1) source[index] = index * 137 % 65536;
    const first = quantizeUint16To8(source, width, 3);
    const second = quantizeUint16To8(source, width, 3);
    expect([...first]).toEqual([...second]);
    for (let index = 0; index < source.length; index += 1) {
      expect(Math.abs(first[index] - Math.round(source[index] / 257))).toBeLessThanOrEqual(1);
    }
  });

  it('breaks a sub-code flat ramp into adjacent codes without clipping', () => {
    const width = 64;
    const source = new Uint16Array(width * 8 * 3).fill(32768);
    const output = quantizeUint16To8(source, width, 3);
    expect(new Set(output).size).toBe(2);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(127);
    expect(Math.max(...output)).toBeLessThanOrEqual(128);
  });
});
