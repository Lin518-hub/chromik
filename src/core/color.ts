import type { BuiltinLook, InputTransfer, Matrix9, RGB } from '../shared/types';
import { clamp, srgbToLinear } from './image';

export function decodeInputSample(value: number, transfer: InputTransfer): number {
  const normalized = Math.max(0, value);
  return transfer === 'linear' ? normalized : srgbToLinear(normalized);
}

const DEFAULT_SEPARATION_MATRIX: Matrix9 = [
  1.055, -0.040, -0.015,
  -0.025, 1.050, -0.025,
  -0.010, -0.035, 1.045,
];

/**
 * A deliberately conservative, neutral-preserving separation transform.
 * It is a generic compatibility estimate rather than a Status-M calibration;
 * strength 0 is identity and a measured device profile can replace it later.
 * A custom row-major 3×3 `matrix` can be supplied (per-stock or user-edited);
 * it is blended from identity by `strength` exactly like the built-in matrix.
 */
export function applyDensitySeparation(density: RGB, strength: number, matrix?: Matrix9): RGB {
  const amount = clamp(strength / 100);
  if (amount <= 0) return [...density] as RGB;
  const [red, green, blue] = density;
  const source = matrix ?? DEFAULT_SEPARATION_MATRIX;
  const separated: RGB = [
    source[0] * red + source[1] * green + source[2] * blue,
    source[3] * red + source[4] * green + source[5] * blue,
    source[6] * red + source[7] * green + source[8] * blue,
  ];
  return separated.map((value, channel) => density[channel] + (value - density[channel]) * amount) as RGB;
}

export function applyBuiltinLook(rgb: RGB, look: BuiltinLook, strength: number): RGB {
  const amount = clamp(strength / 100);
  if (look === 'neutral' || amount <= 0) return rgb;
  const [red, green, blue] = rgb;
  let styled: RGB;
  if (look === 'warm_print') {
    styled = [red * 1.035 + green * 0.008, green * 1.005, blue * 0.955 + red * 0.006];
  } else if (look === 'classic_color') {
    styled = [red * 1.045 - blue * 0.012, green * 0.985 + red * 0.01, blue * 0.97 + green * 0.015];
  } else if (look === 'cool_slide') {
    styled = [red * 0.975, green * 1.008, blue * 1.035 + green * 0.008];
  } else {
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const silver = clamp((luma - 0.5) * 1.08 + 0.5);
    styled = [silver * 1.015, silver, silver * 0.985];
  }
  return styled.map((value, channel) => rgb[channel] + (value - rgb[channel]) * amount) as RGB;
}

export function compressHighlight(value: number, strength: number): number {
  const amount = clamp(strength / 100) * 1.6;
  if (value <= 1 || amount <= 0) return value;
  const excess = value - 1;
  return 1 + excess / (1 + amount * excess);
}
