import { describe, expect, it } from 'vitest';
import { classifyFilmPixels } from './film-type';

function syntheticImage(width: number, height: number, edge: [number, number, number], center: [number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x < width * .15 || x >= width * .85 || y < height * .15 || y >= height * .85;
      data.set(border ? edge : center, (y * width + x) * 3);
    }
  }
  return data;
}

describe('film type visual classifier', () => {
  it('recognizes a warm colour-negative base', () => {
    const estimate = classifyFilmPixels(syntheticImage(100, 80, [238, 165, 105], [70, 48, 35]), 100, 80, 3);
    expect(estimate.filmType).toBe('color_negative');
    expect(estimate.confidence).toBeGreaterThan(.7);
  });

  it('recognizes a black framed colour slide', () => {
    const estimate = classifyFilmPixels(syntheticImage(100, 80, [8, 8, 8], [90, 150, 210]), 100, 80, 3);
    expect(estimate.filmType).toBe('color_slide');
  });
});
