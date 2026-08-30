import { describe, expect, it } from 'vitest';
import { calculateHistogram, calculateWaveform } from './histogram';

describe('high-precision analysis charts', () => {
  it('maps 16-bit processed pixels into the same 64-bin histogram domain', () => {
    const pixels = new Uint16Array([0, 32768, 65535, 16384, 49152, 8192]);
    const bins = calculateHistogram(pixels, 3, 65535);
    expect(bins[0][0]).toBe(1);
    expect(bins[0][16]).toBe(1);
    expect(bins[1][32]).toBe(1);
    expect(bins[1][48]).toBe(1);
    expect(bins[2][8]).toBe(1);
    expect(bins[2][63]).toBe(1);
  });

  it('builds a finite 16-bit waveform without blocking on every pixel', () => {
    const width = 12;
    const height = 8;
    const pixels = new Uint16Array(width * height * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index * 977 % 65536;
    const waveform = calculateWaveform(pixels, width, height, 3, 6, 8, 65535);
    expect(waveform).toMatchObject({ columns: 6, levels: 8 });
    expect(waveform.bins.every((channel) => channel.length === 48 && channel.every(Number.isFinite))).toBe(true);
    expect(waveform.bins.flat().reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
  });
});
