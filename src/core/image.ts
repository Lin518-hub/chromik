import type { CropRect } from '../shared/types';

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeCrop(crop: CropRect): CropRect {
  const x = clamp(crop.x);
  const y = clamp(crop.y);
  const width = clamp(crop.width, 0.02, 1 - x);
  const height = clamp(crop.height, 0.02, 1 - y);
  return { x, y, width, height };
}

export function cropPixels(
  input: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  channels: number,
  crop: CropRect,
): { data: Uint8ClampedArray | Uint16Array; width: number; height: number; channels: number } {
  const rect = normalizeCrop(crop);
  const left = Math.max(0, Math.floor(rect.x * width));
  const top = Math.max(0, Math.floor(rect.y * height));
  const right = Math.min(width, Math.ceil((rect.x + rect.width) * width));
  const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height));
  const outWidth = Math.max(1, right - left);
  const outHeight = Math.max(1, bottom - top);
  const output = input instanceof Uint16Array
    ? new Uint16Array(outWidth * outHeight * channels)
    : new Uint8ClampedArray(outWidth * outHeight * channels);

  for (let y = 0; y < outHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * channels;
    const targetStart = y * outWidth * channels;
    output.set(input.subarray(sourceStart, sourceStart + outWidth * channels), targetStart);
  }

  return { data: output, width: outWidth, height: outHeight, channels };
}

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const safe = Math.max(0, value);
  return safe <= 0.0031308 ? safe * 12.92 : 1.055 * safe ** (1 / 2.4) - 0.055;
}
