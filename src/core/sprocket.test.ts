import { describe, expect, it } from 'vitest';
import { detectSprocketHoles } from './density';

describe('sprocket detection', () => {
  it('finds bright sprocket holes in the top border band', () => {
    const width = 120;
    const height = 80;
    const data = new Uint8Array(width * height * 3).fill(60); // dark border/scene
    // Two bright holes in the top band.
    for (const [x0, x1] of [[20, 34], [60, 74]] as Array<[number, number]>) {
      for (let y = 0; y < 7; y += 1) {
        for (let x = x0; x < x1; x += 1) data.set([255, 255, 255], (y * width + x) * 3);
      }
    }
    const holes = detectSprocketHoles(data, width, height, 3, 'top');
    expect(holes.length).toBe(2);
    expect(holes[0].x).toBe(20);
    expect(holes[1].x).toBe(60);
  });

  it('returns no holes when the border is uniform', () => {
    const width = 100;
    const height = 60;
    const data = new Uint8Array(width * height * 3).fill(120);
    expect(detectSprocketHoles(data, width, height, 3, 'top')).toEqual([]);
  });
});
