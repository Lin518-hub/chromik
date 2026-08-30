import { describe, expect, it } from 'vitest';
import { packDisplayRgba } from './display-buffer';

describe('packDisplayRgba', () => {
  it('adds opaque alpha without changing RGB values', () => {
    expect([...packDisplayRgba(new Uint8ClampedArray([1, 2, 3, 4, 5, 6]), 3)])
      .toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('copies RGBA and rejects malformed input', () => {
    expect([...packDisplayRgba(new Uint8Array([1, 2, 3, 4]), 4)]).toEqual([1, 2, 3, 4]);
    expect(() => packDisplayRgba(new Uint8Array([1, 2]), 3)).toThrow('长度');
  });
});
