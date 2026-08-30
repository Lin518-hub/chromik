import { describe, expect, it } from 'vitest';
import { detectFilmRegion } from './density';

function syntheticCopy(width = 720, height = 480) {
  const data = new Uint8ClampedArray(width * height * 3).fill(248);
  const paint = (left: number, top: number, right: number, bottom: number, rgb: [number, number, number]) => {
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 3;
      data[index] = rgb[0]; data[index + 1] = rgb[1]; data[index + 2] = rgb[2];
    }
  };
  paint(72, 118, 665, 370, [224, 145, 79]);
  paint(100, 160, 290, 330, [130, 66, 38]);
  paint(310, 160, 510, 330, [165, 91, 50]);
  // Dark fingers/holder overlap the four outer corners and must be ignored.
  paint(0, 0, 95, 105, [10, 12, 15]);
  paint(630, 0, width, 115, [12, 13, 15]);
  paint(0, 365, 100, height, [13, 14, 16]);
  paint(640, 360, width, height, [9, 10, 12]);
  return { data, width, height };
}

describe('detectFilmRegion', () => {
  it('isolates a film strip from a bright light table and dark holders', () => {
    const source = syntheticCopy();
    const result = detectFilmRegion(source.data, source.width, source.height, 3);
    expect(result.confidence).toBeGreaterThan(.6);
    expect(result.crop.x).toBeGreaterThan(.05);
    expect(result.crop.x).toBeLessThan(.18);
    expect(result.crop.y).toBeGreaterThan(.15);
    expect(result.crop.y).toBeLessThan(.32);
    expect(result.crop.width).toBeGreaterThan(.7);
    expect(result.crop.height).toBeGreaterThan(.4);
    expect(result.crop.height).toBeLessThan(.7);
  });

  it('falls back safely when no carrier can be distinguished', () => {
    const data = new Uint8ClampedArray(120 * 80 * 3).fill(240);
    const result = detectFilmRegion(data, 120, 80, 3);
    expect(result.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(result.confidence).toBeLessThan(.4);
  });

  it('keeps all contact-sheet frames when bright sprocket columns split the carrier', () => {
    const source = syntheticCopy();
    for (const [left, right] of [[275, 302], [505, 532]]) {
      for (let y = 118; y < 370; y += 1) for (let x = left; x < right; x += 1) {
        const index = (y * source.width + x) * 3;
        source.data[index] = 248;
        source.data[index + 1] = 248;
        source.data[index + 2] = 248;
      }
    }
    const result = detectFilmRegion(source.data, source.width, source.height, 3);
    expect(result.crop.x).toBeLessThan(.18);
    expect(result.crop.x + result.crop.width).toBeGreaterThan(.85);
    expect(result.crop.width).toBeGreaterThan(.7);
  });
});
