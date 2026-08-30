import { describe, expect, it } from 'vitest';
import { calculateVirtualStripWindow } from './virtual-strip';

describe('horizontal filmstrip virtualization', () => {
  it('mounts a bounded window for 1000 frames', () => {
    const result = calculateVirtualStripWindow({ itemCount: 1000, itemStep: 99, viewportWidth: 990, scrollLeft: 49_500 });
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(17);
    expect(result.totalWidth).toBe(99_000);
    expect(result.startIndex).toBeGreaterThan(490);
  });
});
