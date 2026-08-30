import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { encodePng16 } from './png16';

describe('16-bit PNG encoder', () => {
  it('writes RGB samples as a 16-bit PNG', async () => {
    const pixels = new Uint16Array([
      1, 32768, 65535,
      12345, 23456, 34567,
    ]);
    const encoded = encodePng16(2, 1, pixels);
    const metadata = await sharp(encoded).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.bitsPerSample).toBe(16);
    expect(metadata.width).toBe(2);
  });
});
