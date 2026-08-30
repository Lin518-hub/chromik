import { describe, expect, it } from 'vitest';
import { calculateVirtualGridWindow } from './virtual-grid';

describe('virtual photo grid', () => {
  it('mounts only a bounded window from a 1000-card library', () => {
    const result = calculateVirtualGridWindow({
      itemCount: 1000,
      containerWidth: 1000,
      viewportHeight: 720,
      scrollTop: 12_000,
      minimumColumnWidth: 200,
      gap: 12,
      thumbnailHeightRatio: 2 / 3,
      metadataHeight: 41,
      listMode: false,
      listItemHeight: 84,
    });
    expect(result.columns).toBe(4);
    expect(result.endIndex - result.startIndex).toBeLessThan(40);
    expect(result.startIndex).toBeGreaterThan(0);
    expect(result.endIndex).toBeLessThan(1000);
    expect(result.totalHeight).toBeGreaterThan(30_000);
  });

  it('uses one column and preserves scroll height in list mode', () => {
    const result = calculateVirtualGridWindow({
      itemCount: 1000,
      containerWidth: 800,
      viewportHeight: 600,
      scrollTop: 20_000,
      minimumColumnWidth: 240,
      gap: 8,
      thumbnailHeightRatio: .625,
      metadataHeight: 45,
      listMode: true,
      listItemHeight: 88,
    });
    expect(result.columns).toBe(1);
    expect(result.endIndex - result.startIndex).toBeLessThan(15);
    expect(result.totalHeight).toBe(95_992);
  });
});
