import { describe, expect, it } from 'vitest';
import { detectDustSpots } from './dust-detect';

function flatImage(width: number, height: number, value = 128): Uint8Array {
  const data = new Uint8Array(width * height * 3).fill(value);
  const put = (x: number, y: number, rgb: [number, number, number]) => {
    const at = (y * width + x) * 3;
    data[at] = rgb[0]; data[at + 1] = rgb[1]; data[at + 2] = rgb[2];
  };
  put(18, 21, [12, 12, 12]);
  put(52, 38, [245, 245, 245]);
  return data;
}

describe('traditional dust detector', () => {
  it('finds isolated dark and bright defects while ignoring a flat image', () => {
    const width = 72;
    const height = 56;
    const candidates = detectDustSpots(flatImage(width, height), width, height, 3, 255, { minDistance: 6 });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((item) => item.kind === 'dark' && Math.abs(item.x - 18 / (width - 1)) < 0.04)).toBe(true);
    expect(candidates.some((item) => item.kind === 'bright' && Math.abs(item.y - 38 / (height - 1)) < 0.04)).toBe(true);
    expect(candidates.every((item) => item.score > 0 && item.r > 0)).toBe(true);
  });

  it('caps suggestions and rejects a strong straight edge', () => {
    const width = 80;
    const height = 60;
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = x < width / 2 ? 45 : 210;
        const at = (y * width + x) * 3;
        data[at] = value; data[at + 1] = value; data[at + 2] = value;
      }
    }
    const candidates = detectDustSpots(data, width, height, 3, 255, { maxSpots: 3 });
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates.every((item) => Math.abs(item.x - 0.5) > 0.05)).toBe(true);
  });
});
