import { linearToSrgb, srgbToLinear } from './image';

/**
 * Legacy-only +2 EV view lift for RAW caches created before the signed float
 * camera-matrix path. New matrix-aware caches already carry the intended
 * scene-linear exposure and use linear16ToSrgb8 without this compatibility
 * transform.
 */
export const RAW_DISPLAY_EXPOSURE_SHIFT = 4;
export const RAW_DISPLAY_VERSION = 7;

const HIGHLIGHT_KNEE = 0.78;
const HIGHLIGHT_SHOULDER = (1 - HIGHLIGHT_KNEE) * 2.5;

/**
 * Preserve the exposure lift through the midtones, then approach display white
 * continuously instead of clipping. This is deliberately a view transform:
 * calibration, frame extraction and export keep using the neutral RAW cache.
 */
function toneLinear(exposed: number): number {
  return exposed <= HIGHLIGHT_KNEE
    ? exposed
    : HIGHLIGHT_KNEE + (1 - HIGHLIGHT_KNEE)
      * (1 - Math.exp(-(exposed - HIGHLIGHT_KNEE) / HIGHLIGHT_SHOULDER));
}

export function liftRawDisplayProxy(source: Uint8ClampedArray): Uint8ClampedArray {
  const display = new Uint8ClampedArray(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const linear = [0, 1, 2].map((channel) => srgbToLinear(source[index + channel] / 255) * RAW_DISPLAY_EXPOSURE_SHIFT);
    const peak = Math.max(...linear);
    const scale = peak > 0 ? toneLinear(peak) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      display[index + channel] = Math.round(linearToSrgb(Math.min(1, linear[channel] * scale)) * 255);
    }
  }
  return display;
}

/** Generate the 8-bit display proxy directly from 16-bit samples. */
export function liftRawDisplayProxy16(source: Uint16Array): Uint8ClampedArray {
  const display = new Uint8ClampedArray(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const linear = [0, 1, 2].map((channel) => srgbToLinear(source[index + channel] / 65535) * RAW_DISPLAY_EXPOSURE_SHIFT);
    const peak = Math.max(...linear);
    const scale = peak > 0 ? toneLinear(peak) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      display[index + channel] = Math.round(linearToSrgb(Math.min(1, linear[channel] * scale)) * 255);
    }
  }
  return display;
}

/** Generate a neutral sRGB view from canonical linear 16-bit samples. */
export function linear16ToSrgb8(source: Uint16Array): Uint8ClampedArray {
  const display = new Uint8ClampedArray(source.length);
  for (let index = 0; index < source.length; index += 1) {
    display[index] = Math.round(linearToSrgb(Math.min(1, source[index] / 65535)) * 255);
  }
  return display;
}

/** High-bit-depth sRGB view encoding for TIFF/PNG delivery. */
export function linear16ToSrgb16(source: Uint16Array): Uint16Array {
  const display = new Uint16Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    display[index] = Math.round(linearToSrgb(Math.min(1, source[index] / 65535)) * 65535);
  }
  return display;
}

/** Convert an sRGB 8-bit decode into the canonical linear 16-bit proxy. */
export function srgb8ToLinear16(source: Uint8Array | Uint8ClampedArray): Uint16Array {
  const linear = new Uint16Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    linear[index] = Math.round(Math.min(1, srgbToLinear(source[index] / 255)) * 65535);
  }
  return linear;
}

/** Convert an sRGB-encoded 16-bit image into the canonical linear proxy. */
export function srgb16ToLinear16(source: Uint16Array): Uint16Array {
  const linear = new Uint16Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    linear[index] = Math.round(Math.min(1, srgbToLinear(source[index] / 65535)) * 65535);
  }
  return linear;
}

/** View-only lift for a canonical linear 16-bit RAW proxy. */
export function liftLinearRawDisplayProxy16(source: Uint16Array): Uint8ClampedArray {
  const display = new Uint8ClampedArray(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const exposed = [0, 1, 2].map((channel) => source[index + channel] / 65535 * RAW_DISPLAY_EXPOSURE_SHIFT);
    const peak = Math.max(...exposed);
    const scale = peak > 0 ? toneLinear(peak) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      display[index + channel] = Math.round(linearToSrgb(Math.min(1, exposed[channel] * scale)) * 255);
    }
  }
  return display;
}

/** Legacy view lift retained at 16-bit precision for archival PNG/TIFF. */
export function liftLinearRawDisplayProxy16To16(source: Uint16Array): Uint16Array {
  const display = new Uint16Array(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const exposed = [0, 1, 2].map((channel) => source[index + channel] / 65535 * RAW_DISPLAY_EXPOSURE_SHIFT);
    const peak = Math.max(...exposed);
    const scale = peak > 0 ? toneLinear(peak) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      display[index + channel] = Math.round(linearToSrgb(Math.min(1, exposed[channel] * scale)) * 65535);
    }
  }
  return display;
}

/**
 * Return a linear 16-bit working source for positive camera-RAW development.
 *
 * Old caches stored an sRGB carrier and also relied on a +2 EV gallery view.
 * New caches are already neutral scene-linear. Keeping this compatibility
 * conversion before the shared processing graph means exposure, white balance,
 * curves and every later operation still run for both generations of cache.
 */
export function preparePositiveRawLinear16(
  source: Uint16Array,
  sourceTransfer: 'srgb' | 'linear',
  displayTransform: 'camera-raw-neutral' | 'camera-raw-legacy-lift',
): Uint16Array {
  const linear = sourceTransfer === 'linear' ? source : srgb16ToLinear16(source);
  if (displayTransform !== 'camera-raw-legacy-lift') return linear;
  const lifted = new Uint16Array(linear.length);
  for (let index = 0; index < linear.length; index += 3) {
    const exposed = [0, 1, 2].map((channel) => (linear[index + channel] ?? 0) / 65535 * RAW_DISPLAY_EXPOSURE_SHIFT);
    const peak = Math.max(...exposed);
    const scale = peak > 0 ? toneLinear(peak) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      lifted[index + channel] = Math.round(Math.min(1, exposed[channel] * scale) * 65535);
    }
  }
  return lifted;
}
