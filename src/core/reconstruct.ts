import type { CurvePoints, EditRecipe, InputTransfer, ProcessablePixelSourceDescriptor, RGB } from '../shared/types';
import { applyBuiltinLook, applyDensitySeparation, compressHighlight, decodeInputSample } from './color';
import { applyCubeLut, type CubeLut } from './cube';
import { buildSpotMask, createPatchMatchInpainter } from './dust-inpaint';
import { getFilmStockProfile } from '../shared/film-stock-profiles';
import { getMeasuredHdLuts } from '../shared/measured-stock-profiles';
import { clamp, linearToSrgb } from './image';

function rawDensity(
  value: number,
  channel: number,
  recipe: EditRecipe,
  maxValue: number,
  lightScale: number,
  sourceTransfer: InputTransfer,
): number {
  const canonical = value / maxValue;
  const legacy = recipe.algorithmVersion === 'chromik-5';
  // The 0.9 editor always processed an sRGB preview. Canonical v6 proxies are
  // linear, so a legacy recipe first reconstructs that old encoded carrier and
  // then applies its saved inputTransfer exactly as chromik-5 did.
  const encoded = legacy && sourceTransfer === 'linear' ? linearToSrgb(canonical) : canonical;
  const decodeTransfer = legacy ? recipe.density.inputTransfer : sourceTransfer;
  const input = decodeInputSample(encoded, decodeTransfer) / lightScale;
  const baseEncoded = (recipe.baseRgb?.[channel] ?? 255) / 255;
  // Source and film-base were captured under the same light. Normalize both
  // sides of the density ratio; changing only the base invents a colour offset.
  const base = Math.max(1e-6, (legacy
    ? decodeInputSample(baseEncoded, recipe.density.inputTransfer)
    : recipe.baseRgbLinear?.[channel]
    // baseRgb is a UI/display value; it is never encoded in the source's
    // transfer function. Schema v6 stores baseRgbLinear and keeps this only as
    // a migration fallback.
    ?? decodeInputSample(baseEncoded, 'srgb')) / lightScale);
  return -Math.log10(Math.max(1e-6, input / base));
}

function tangent(points: CurvePoints, index: number): number {
  if (index === 0) return (points[1].y - points[0].y) / Math.max(1e-6, points[1].x - points[0].x);
  if (index === points.length - 1) {
    const previous = points[index - 1];
    return (points[index].y - previous.y) / Math.max(1e-6, points[index].x - previous.x);
  }
  const previous = points[index - 1];
  const current = points[index];
  const next = points[index + 1];
  const left = (current.y - previous.y) / Math.max(1e-6, current.x - previous.x);
  const right = (next.y - current.y) / Math.max(1e-6, next.x - current.x);
  if (left * right <= 0) return 0;
  return 2 * left * right / (left + right);
}

/** Monotone cubic interpolation keeps editable curves smooth without overshoot. */
export function evaluateCurve(points: CurvePoints, value: number): number {
  const input = clamp(value);
  if (points.length < 2) return input;
  let upperIndex = points.findIndex((point) => point.x >= input);
  if (upperIndex <= 0) return clamp(points[0].y);
  if (upperIndex < 0) upperIndex = points.length - 1;
  const lowerIndex = upperIndex - 1;
  const lower = points[lowerIndex];
  const upper = points[upperIndex];
  const span = Math.max(1e-6, upper.x - lower.x);
  const t = (input - lower.x) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return clamp(h00 * lower.y + h10 * span * tangent(points, lowerIndex)
    + h01 * upper.y + h11 * span * tangent(points, upperIndex));
}

function curveLut(points: CurvePoints, size = 4096): Float32Array {
  const output = new Float32Array(size);
  for (let index = 0; index < size; index += 1) output[index] = evaluateCurve(points, index / (size - 1));
  return output;
}

function fromCurveLut(lut: Float32Array, value: number): number {
  const position = clamp(value) * (lut.length - 1);
  const low = Math.floor(position);
  const high = Math.min(lut.length - 1, low + 1);
  const fraction = position - low;
  return lut[low] + (lut[high] - lut[low]) * fraction;
}

/**
 * Chromik's generic smooth shoulder/toe display curve. It is independently
 * authored, keeps the calibrated density endpoints fixed, and is not a
 * measured film/log profile.
 */
function filmicDensity(value: number): number {
  const x = Math.max(0, value);
  const A = 0.22;
  const B = 0.30;
  const C = 0.10;
  const D = 0.20;
  const E = 0.01;
  const F = 0.30;
  const curve = (input: number) => ((input * (A * input + C * B) + D * E) / (input * (A * input + B) + D * F)) - E / F;
  // Keep the calibrated density white point at white. The unnormalized curve
  // maps 1.0 to about 0.4 and made this mode unusably dark.
  return clamp(curve(x) / Math.max(1e-6, curve(1)));
}

/**
 * Per-stock filmic toe/shoulder. `toe` ∈ [0,1] is the dark range that gets
 * compressed toward 0; `shoulder` ∈ [0,1] is where highlight roll-off begins
 * (lower = stronger). The mid stays linear and both joins are C1-continuous
 * (slope matches the linear segment), so there is no visible knee. Defaults
 * (toe=0, shoulder=1) are identity.
 */
function toeShoulderCurve(value: number, toe: number, shoulder: number): number {
  const t = Math.max(0, Math.min(1, value));
  const toeAmount = Math.max(0, Math.min(0.5, toe));
  const shoulderAmount = Math.max(0.5, Math.min(1, shoulder));
  if (toeAmount >= shoulderAmount) return t;
  let out = t;
  if (toeAmount > 0 && t < toeAmount) {
    const u = t / toeAmount;
    // Cubic Hermite: flat at black, slope 1 at the toe join.
    out = toeAmount * (2 * u * u - u * u * u);
  }
  if (shoulderAmount < 1 && t > shoulderAmount) {
    const v = (t - shoulderAmount) / (1 - shoulderAmount);
    // Cubic Hermite: slope 1 at the join, flat at white.
    out = (1 - shoulderAmount) * (-v * v * v + v * v + v) + shoulderAmount;
  }
  return out;
}

/**
 * Subtractive CMY(D) colour correction in display space. Cyan reduces red,
 * magenta reduces green, yellow reduces blue; density acts as a global gain.
 */
function applyCmy(rgb: RGB, cmy: EditRecipe['grade']['cmy']): RGB {
  const densityGain = 2 ** (-cmy.density / 100);
  return [
    clamp(rgb[0] * (1 - cmy.cyan / 100) * densityGain),
    clamp(rgb[1] * (1 - cmy.magenta / 100) * densityGain),
    clamp(rgb[2] * (1 - cmy.yellow / 100) * densityGain),
  ];
}

/**
 * Dust-spot healing: detection and repair are decoupled (see
 * dust-inpaint.ts). The spot list is first rasterized into a per-pixel repair
 * mask (`buildSpotMask`), then handed to a PatchMatch-style sample-based
 * inpainter which copies surrounding texture — including film grain — instead
 * of flattening the spot with a ring mean. The repair side only ever consumes
 * a mask, so a future AI detector (e.g. a small ONNX U-Net) can feed the same
 * `DustInpainter` interface with an arbitrary-shape mask and this function
 * stays unchanged.
 */
function applySpotHealing(output: Float32Array, width: number, height: number, channels: number, spots: EditRecipe['spots']): void {
  if (!spots?.length) return;
  const mask = buildSpotMask(width, height, spots);
  createPatchMatchInpainter().heal(output, width, height, channels, mask);
}

function vignetteFactor(x: number, y: number, width: number, height: number, vignette: EditRecipe['grade']['vignette']): number {
  if (vignette.strength === 0) return 1;
  const nx = ((x + 0.5) / Math.max(1, width) - 0.5) * 2;
  const ny = ((y + 0.5) / Math.max(1, height) - 0.5) * 2;
  const roundness = vignette.roundness / 100;
  const exponent = roundness < 0 ? 2 + roundness : 2 + roundness * 6;
  const distance = clamp(((Math.abs(nx) ** exponent + Math.abs(ny) ** exponent) / 2) ** (1 / exponent));
  const midpoint = clamp(vignette.midpoint / 100, 0, 0.999);
  if (distance <= midpoint) return 1;
  const falloff = Math.min(1, (distance - midpoint) / (1 - midpoint));
  return 1 - (vignette.strength / 100) * falloff;
}

function normalizeDensity(density: RGB, recipe: EditRecipe): RGB {
  return normalizeDensityWithContext(density, recipe, createDensityContext(recipe));
}

interface DensityContext {
  stockProfile?: ReturnType<typeof getFilmStockProfile>;
  measuredLuts?: ReturnType<typeof getMeasuredHdLuts>;
}

function createDensityContext(recipe: EditRecipe): DensityContext {
  const id = recipe.density.filmStockProfileId;
  return {
    stockProfile: id ? getFilmStockProfile(id) : undefined,
    measuredLuts: id ? getMeasuredHdLuts(id) : undefined,
  };
}

function normalizeDensityWithContext(density: RGB, recipe: EditRecipe, context: DensityContext): RGB {
  const stockProfile = context.stockProfile;
  const separated = applyDensitySeparation(density, recipe.density.separation, recipe.density.separationMatrix);
  const luma = separated[0] * 0.2126 + separated[1] * 0.7152 + separated[2] * 0.0722;
  const sharedLow = recipe.density.low.reduce((sum, value) => sum + value, 0) / 3;
  const sharedHigh = recipe.density.high.reduce((sum, value) => sum + value, 0) / 3;
  const tonalPosition = clamp((luma - sharedLow) / Math.max(0.001, sharedHigh - sharedLow));
  // Three-band crossover interpolation: shadow anchor below 50%, mid anchor at
  // 50%, highlight anchor above. Each anchor is a per-channel density offset.
  const correctionFor = (channel: number): number => {
    const shadow = recipe.density.shadowCorrection[channel];
    const mid = recipe.density.midCorrection[channel];
    const highlight = recipe.density.highlightCorrection[channel];
    return tonalPosition < 0.5
      ? shadow + (mid - shadow) * (tonalPosition / 0.5)
      : mid + (highlight - mid) * ((tonalPosition - 0.5) / 0.5);
  };
  const normalized = separated.map((value, channel) => {
    const low = recipe.density.low[channel];
    const high = Math.max(low + 0.001, recipe.density.high[channel]);
    return Math.max(0, (value - correctionFor(channel) - low) / (high - low));
  }) as RGB;
  if (recipe.density.mode === 'cineon') return normalized.map((value) => filmicDensity(value)) as RGB;
  // When a stock has a digitized datasheet H-D curve, use its real per-channel
  // shape instead of the generic toe/shoulder. This is a shape-preserving
  // approximation (see measured-stock-profiles.ts), not a full Status-M
  // inversion.
  const measuredLuts = context.measuredLuts;
  if (measuredLuts) {
    return normalized.map((value, channel) => {
      const lut = measuredLuts.luts[channel];
      const position = clamp(value) * (lut.length - 1);
      const lowIndex = Math.floor(position);
      const highIndex = Math.min(lut.length - 1, lowIndex + 1);
      const fraction = position - lowIndex;
      return lut[lowIndex] + (lut[highIndex] - lut[lowIndex]) * fraction;
    }) as RGB;
  }
  const toe = stockProfile?.toeKnee ?? 0;
  const shoulder = stockProfile?.shoulderKnee ?? 1;
  if (toe > 0 || shoulder < 1) return normalized.map((value) => toeShoulderCurve(value, toe, shoulder)) as RGB;
  return normalized;
}

export interface ProcessOptions {
  width?: number;
  height?: number;
  lut?: CubeLut;
  /** The source owns its transfer function; recipe.density.inputTransfer is legacy fallback only. */
  inputTransfer?: InputTransfer;
}

const rawLutCache = new Map<string, [Float32Array, Float32Array, Float32Array]>();
const curveLutCache = new Map<string, { rgb: Float32Array; red: Float32Array; green: Float32Array; blue: Float32Array }>();
const PROCESS_SETUP_CACHE_LIMIT = 6;

function rememberLru<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > PROCESS_SETUP_CACHE_LIMIT) cache.delete(cache.keys().next().value as K);
  return value;
}

function cachedCurveLuts(curves: EditRecipe['grade']['curves']) {
  const key = JSON.stringify(curves);
  const cached = curveLutCache.get(key);
  if (cached) return rememberLru(curveLutCache, key, cached);
  return rememberLru(curveLutCache, key, {
    rgb: curveLut(curves.rgb),
    red: curveLut(curves.red),
    green: curveLut(curves.green),
    blue: curveLut(curves.blue),
  });
}

function cachedRawLuts(recipe: EditRecipe, maxValue: number, sourceTransfer: InputTransfer, lightScales: RGB) {
  const key = JSON.stringify({
    maxValue,
    sourceTransfer,
    algorithmVersion: recipe.algorithmVersion,
    legacyInputTransfer: recipe.density.inputTransfer,
    enabled: recipe.density.enabled,
    baseRgb: recipe.baseRgb,
    baseRgbLinear: recipe.baseRgbLinear,
    lightScales,
  });
  const cached = rawLutCache.get(key);
  if (cached) return rememberLru(rawLutCache, key, cached);
  const output: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(maxValue + 1), new Float32Array(maxValue + 1), new Float32Array(maxValue + 1),
  ];
  for (let channel = 0; channel < 3; channel += 1) {
    for (let sample = 0; sample <= maxValue; sample += 1) {
      output[channel][sample] = recipe.density.enabled
        ? rawDensity(sample, channel, recipe, maxValue, lightScales[channel], sourceTransfer)
        : (() => {
          const canonical = sample / maxValue;
          const legacy = recipe.algorithmVersion === 'chromik-5';
          const encoded = legacy && sourceTransfer === 'linear' ? linearToSrgb(canonical) : canonical;
          return decodeInputSample(encoded, legacy ? recipe.density.inputTransfer : sourceTransfer) / lightScales[channel];
        })();
    }
  }
  return rememberLru(rawLutCache, key, output);
}

export function processRgbNormalized(
  input: ArrayLike<number>,
  channels: number,
  recipe: EditRecipe,
  maxValue: number,
  options: ProcessOptions = {},
): Float32Array {
  const output = new Float32Array(input.length);
  const grade = recipe.grade;
  const exposure = 2 ** grade.exposureEv;
  const warmth = grade.temperature / 100;
  const magenta = grade.tint / 100;
  const gains: RGB = [
    2 ** (warmth * 0.38 + magenta * 0.08 + grade.printerLights[0] / 12),
    2 ** (-magenta * 0.2 + grade.printerLights[1] / 12),
    2 ** (-warmth * 0.38 + magenta * 0.08 + grade.printerLights[2] / 12),
  ];
  const contrast = Math.max(0.05, 1 + grade.contrast / 100);
  const saturation = Math.max(0, 1 + grade.saturation / 100);
  const vibrance = grade.vibrance / 100;
  const invGamma = 1 / Math.max(0.2, grade.gamma);
  const shadow = grade.shadows / 100 * 0.24;
  const highlight = grade.highlights / 100 * 0.2;
  const fade = grade.fade / 100 * 0.18;
  const applyCmyCorrection = grade.cmy.cyan !== 0 || grade.cmy.magenta !== 0 || grade.cmy.yellow !== 0 || grade.cmy.density !== 0;
  const useVignette = grade.vignette.strength !== 0 && options.width !== undefined && options.height !== undefined;
  const width = options.width ?? 0;
  const height = options.height ?? 0;
  const inputTransfer = options.inputTransfer ?? recipe.density.inputTransfer;
  const lightTransfer = recipe.algorithmVersion === 'chromik-5' ? recipe.density.inputTransfer : 'srgb';
  const lightValues = recipe.density.lightSourceRgb?.map((value) => Math.max(1e-6, decodeInputSample(value / 255, lightTransfer))) as RGB | undefined;
  const lightLuma = lightValues ? lightValues[0] * .2126 + lightValues[1] * .7152 + lightValues[2] * .0722 : 1;
  const lightScales = lightValues?.map((value) => Math.max(1e-6, value / lightLuma)) as RGB | undefined ?? [1, 1, 1];
  const curves = cachedCurveLuts(grade.curves);
  const rawLuts = cachedRawLuts(recipe, maxValue, inputTransfer, lightScales);
  const densityContext = createDensityContext(recipe);

  // BUG-019：查表索引必须落在 [0, maxValue]；越界/NaN/负数输入此前会让
  // Float32Array 返回 undefined，参与后续运算后把 NaN 写进输出帧。
  const lutIndex = (value: number) => {
    if (!(value > 0)) return 0;
    if (value >= maxValue) return maxValue;
    return Math.trunc(value);
  };

  for (let index = 0; index < input.length; index += channels) {
    const samples: RGB = [
      rawLuts[0][lutIndex(input[index] ?? 0)],
      rawLuts[1][lutIndex(input[index + 1] ?? 0)],
      rawLuts[2][lutIndex(input[index + 2] ?? 0)],
    ];
    const scene = recipe.density.enabled ? normalizeDensityWithContext(samples, recipe, densityContext) : samples;
    const toDisplay = (value: number) => recipe.density.enabled
      // Normalized optical density is already a display-reference tone value;
      // applying an sRGB OETF a second time lifts 50% density to ~74% and is the
      // main cause of the washed-out automatic conversion regression.
      ? clamp(compressHighlight(Math.max(0, value), grade.highlightRolloff))
      : linearToSrgb(compressHighlight(Math.max(0, value), grade.highlightRolloff));
    // Exposure and colour gains act after raw density has been converted into
    // a normalized positive display reference. They never multiply optical
    // density itself.
    let red = toDisplay(scene[0] * exposure * gains[0]);
    let green = toDisplay(scene[1] * exposure * gains[1]);
    let blue = toDisplay(scene[2] * exposure * gains[2]);

    red = Math.max(0, (red - 0.5) * contrast + 0.5) ** invGamma;
    green = Math.max(0, (green - 0.5) * contrast + 0.5) ** invGamma;
    blue = Math.max(0, (blue - 0.5) * contrast + 0.5) ** invGamma;
    red = clamp(red + shadow * (1 - clamp(red)) ** 2 + highlight * clamp(red) ** 2 + fade * (1 - red));
    green = clamp(green + shadow * (1 - clamp(green)) ** 2 + highlight * clamp(green) ** 2 + fade * (1 - green));
    blue = clamp(blue + shadow * (1 - clamp(blue)) ** 2 + highlight * clamp(blue) ** 2 + fade * (1 - blue));

    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    if (grade.blackAndWhite) {
      red = luma;
      green = luma;
      blue = luma;
    } else {
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const adaptiveSaturation = saturation * (1 + vibrance * (1 - clamp(chroma * 1.6)));
      red = clamp(luma + (red - luma) * adaptiveSaturation);
      green = clamp(luma + (green - luma) * adaptiveSaturation);
      blue = clamp(luma + (blue - luma) * adaptiveSaturation);
    }

    [red, green, blue] = applyBuiltinLook([red, green, blue], grade.look, grade.lookStrength)
      .map((value) => clamp(value)) as RGB;
    if (applyCmyCorrection) [red, green, blue] = applyCmy([red, green, blue], grade.cmy);
    if (options.lut) [red, green, blue] = applyCubeLut(options.lut, red, green, blue).map((value) => clamp(value)) as RGB;

    let outRed = fromCurveLut(curves.red, fromCurveLut(curves.rgb, red));
    let outGreen = fromCurveLut(curves.green, fromCurveLut(curves.rgb, green));
    let outBlue = fromCurveLut(curves.blue, fromCurveLut(curves.rgb, blue));
    if (useVignette) {
      const pixel = index / channels;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const factor = vignetteFactor(x, y, width, height, grade.vignette);
      outRed *= factor;
      outGreen *= factor;
      outBlue *= factor;
    }
    output[index] = outRed;
    output[index + 1] = outGreen;
    output[index + 2] = outBlue;
    if (channels === 4) output[index + 3] = (input[index + 3] ?? maxValue) / maxValue;
  }
  if (recipe.spots?.length && width > 0 && height > 0) {
    applySpotHealing(output, width, height, channels, recipe.spots);
  }
  return output;
}

export function processRgb8(
  input: Uint8Array | Uint8ClampedArray,
  channels: number,
  recipe: EditRecipe,
  options: ProcessOptions = {},
): Uint8ClampedArray {
  const normalized = processRgbNormalized(input, channels, recipe, 255, options);
  const output = new Uint8ClampedArray(normalized.length);
  for (let index = 0; index < normalized.length; index += 1) output[index] = Math.round(clamp(normalized[index]) * 255);
  return output;
}

export function processRgb16(
  input: Uint16Array,
  channels: number,
  recipe: EditRecipe,
  options: ProcessOptions = {},
): Uint16Array {
  const normalized = processRgbNormalized(input, channels, recipe, 65535, options);
  const output = new Uint16Array(normalized.length);
  for (let index = 0; index < normalized.length; index += 1) output[index] = Math.round(clamp(normalized[index]) * 65535);
  return output;
}

/**
 * Role-aware public processing entry point. DisplayPreviewDescriptor is not
 * assignable here, so gallery-only pixels cannot reach colour processing by
 * accident. The low-level 8/16 adapters above remain the single mathematical
 * implementation used by tests and this dispatcher.
 */
export function processPixelSource(
  input: Uint8Array | Uint8ClampedArray | Uint16Array,
  channels: number,
  recipe: EditRecipe,
  source: ProcessablePixelSourceDescriptor,
  options: Omit<ProcessOptions, 'inputTransfer'> = {},
): Uint8ClampedArray | Uint16Array {
  if (source.channels !== channels) throw new Error('像素源通道数与描述不一致');
  if (source.role === 'develop' && (source.bitDepth !== 16 || source.transfer !== 'linear')) {
    throw new Error('开发代理必须是 16 位线性数据');
  }
  if (source.bitDepth === 16) {
    if (!(input instanceof Uint16Array)) throw new Error('16 位像素源必须使用 Uint16Array');
    return processRgb16(input, channels, recipe, { ...options, inputTransfer: source.transfer });
  }
  if (input instanceof Uint16Array) throw new Error('8 位像素源不能使用 Uint16Array');
  return processRgb8(input, channels, recipe, { ...options, inputTransfer: source.transfer });
}
