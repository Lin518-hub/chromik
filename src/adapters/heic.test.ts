import { describe, expect, it } from 'vitest';
import { isHeicPath } from './heic';

describe('isHeicPath', () => {
  it('recognises HEIC/HEIF/HIF containers case-insensitively', () => {
    expect(isHeicPath('/tmp/a.HEIC')).toBe(true);
    expect(isHeicPath('/tmp/b.heif')).toBe(true);
    expect(isHeicPath('/tmp/c.HIF')).toBe(true);
    expect(isHeicPath('/tmp/d.jpg')).toBe(false);
    expect(isHeicPath('/tmp/e.png')).toBe(false);
  });
});
