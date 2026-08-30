import { describe, expect, it } from 'vitest';
import { calculateFitZoom, clampPreviewZoom, zoomAroundPoint } from './viewport';

describe('preview viewport', () => {
  it('fits large images without enlarging small ones', () => {
    expect(calculateFitZoom(1000, 700, 2000, 1000)).toBeCloseTo(0.484);
    expect(calculateFitZoom(1000, 700, 400, 300)).toBe(1);
  });

  it('keeps the image point under the cursor while zooming', () => {
    const current = { zoom: 0.5, x: 30, y: -20 };
    const viewport = { width: 1000, height: 700 };
    const point = { x: 720, y: 210 };
    const before = {
      x: (point.x - viewport.width / 2 - current.x) / current.zoom,
      y: (point.y - viewport.height / 2 - current.y) / current.zoom,
    };
    const next = zoomAroundPoint(current, 1.25, point, viewport);
    expect((point.x - viewport.width / 2 - next.x) / next.zoom).toBeCloseTo(before.x);
    expect((point.y - viewport.height / 2 - next.y) / next.zoom).toBeCloseTo(before.y);
  });

  it('clamps extreme zoom values', () => {
    expect(clampPreviewZoom(0)).toBe(0.05);
    expect(clampPreviewZoom(99)).toBe(8);
  });
});
