import { describe, expect, it } from 'vitest';
import { formatRawShutter } from './raw-import';

describe('RAW metadata formatting', () => {
  it('formats normal camera exposure times for the roll UI', () => {
    expect(formatRawShutter(.01)).toBe('1/100');
    expect(formatRawShutter(.5)).toBe('1/2');
    expect(formatRawShutter(1.25)).toBe('1.25 秒');
  });

  it('rejects missing and invalid exposure values', () => {
    expect(formatRawShutter(undefined)).toBeUndefined();
    expect(formatRawShutter(0)).toBeUndefined();
    expect(formatRawShutter(Number.NaN)).toBeUndefined();
  });
});
