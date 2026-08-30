import { clamp } from './image';

// Ordered 8×8 threshold matrix. It is deterministic across CPU/GPU paths and
// avoids random grain changing export hashes while breaking up smooth 8-bit
// bands by less than one code value.
const BAYER_8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
] as const;

export function quantizeUint16To8(input: Uint16Array, width: number, channels: number, dither = true): Uint8ClampedArray {
  if (!Number.isInteger(width) || width < 1 || (channels !== 3 && channels !== 4) || input.length % channels !== 0) {
    throw new Error('8 位量化输入无效');
  }
  const output = new Uint8ClampedArray(input.length);
  for (let index = 0; index < input.length; index += channels) {
    const pixel = index / channels;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const threshold = dither ? (BAYER_8[(y % 8) * 8 + (x % 8)] + .5) / 64 : .5;
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
      output[index + channel] = Math.floor(clamp(input[index + channel] / 65535) * 255 + threshold);
    }
    if (channels === 4) output[index + 3] = Math.round(input[index + 3] / 257);
  }
  return output;
}
