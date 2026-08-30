import { describe, expect, it } from 'vitest';
import { detectFrameGrid } from './frame-detect';

describe('traditional frame detector', () => {
  it('suggests separate frames from vertical separators in a strip', () => {
    const width = 180;
    const height = 56;
    const data = new Uint8Array(width * height * 3).fill(155);
    for (const x of [60, 120]) {
      for (let y = 0; y < height; y += 1) {
        const at = (y * width + x) * 3;
        data[at] = 20; data[at + 1] = 20; data[at + 2] = 20;
      }
    }
    const result = detectFrameGrid(data, width, height, 3, { kind: 'strip', maxFrames: 6 });
    expect(result.length).toBe(3);
    expect(result[0].corners[0].x).toBeLessThan(0.1);
    expect(result[1].corners[0].x).toBeGreaterThan(0.25);
  });

  it('returns no regions for an unusably small input', () => {
    expect(detectFrameGrid(new Uint8Array(12), 2, 2, 3)).toEqual([]);
  });
});
