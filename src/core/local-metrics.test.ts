import { describe, expect, it } from 'vitest';
import { summarizeTimings } from './local-metrics';

describe('local timing summaries', () => {
  it('computes stable P50/P95 without retaining user data', () => {
    const summary = summarizeTimings(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(summary).toEqual({ count: 100, p50: 51, p95: 95 });
  });

  it('drops invalid samples and handles an empty window', () => {
    expect(summarizeTimings([Number.NaN, 8, Number.POSITIVE_INFINITY])).toEqual({ count: 1, p50: 8, p95: 8 });
    expect(summarizeTimings([])).toBeUndefined();
  });
});
