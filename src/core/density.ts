import { getCaptureProfile } from '../shared/capture-profiles';
import { getFilmResponseProfile } from '../shared/film-response-profiles';
import { getFilmStockProfile } from '../shared/film-stock-profiles';
import type { CaptureProfileId, CropRect, FilmResponseProfileId, InputTransfer, Matrix9, RGB } from '../shared/types';
import { applyDensitySeparation, decodeInputSample } from './color';
import { clamp, linearToSrgb } from './image';

export type PixelSamples = Uint8Array | Uint8ClampedArray | Uint16Array;

function sourceToLinear(value: number, maxValue: number, transfer: InputTransfer): number {
  return decodeInputSample(value / Math.max(1, maxValue), transfer);
}

function linearToDisplayRgb(values: RGB): RGB {
  return values.map((value) => Math.round(clamp(linearToSrgb(value)) * 255)) as RGB;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.round(clamp(fraction) * (values.length - 1));
  return values[index] ?? 0;
}

function pixelIndex(x: number, y: number, width: number, channels: number): number {
  return (y * width + x) * channels;
}

export function estimateFilmBase(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  maxValue = 255,
  inputTransfer: InputTransfer = 'srgb',
): RGB {
  const samples: [number[], number[], number[]] = [[], [], []];
  const borderX = Math.max(2, Math.round(width * 0.07));
  const borderY = Math.max(2, Math.round(height * 0.07));
  const step = Math.max(1, Math.floor(Math.max(width, height) / 700));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (x > borderX && x < width - borderX && y > borderY && y < height - borderY) continue;
      const index = pixelIndex(x, y, width, channels);
      samples[0].push(data[index] ?? 0);
      samples[1].push(data[index + 1] ?? 0);
      samples[2].push(data[index + 2] ?? 0);
    }
  }

  // Legacy border-only fallback. Prefer the brighter side of the border so a
  // holder shadow does not pull the D-min reference downward.
  const raw = [
    Math.max(1, percentile(samples[0], 0.85)),
    Math.max(1, percentile(samples[1], 0.85)),
    Math.max(1, percentile(samples[2], 0.85)),
  ] as RGB;
  return linearToDisplayRgb(raw.map((value) => sourceToLinear(value, maxValue, inputTransfer)) as RGB);
}

export type FilmBaseStatus = 'ok' | 'fallback' | 'low_samples' | 'border_dominated';
export type AnchorStatus = 'ok' | 'fallback' | 'low_usable' | 'heavily_clipped' | 'low_neutral';

export interface FilmBaseEstimate {
  rgb: RGB;
  linearRgb: RGB;
  confidence: number;
  sampleCount: number;
  /** COL-07：异常原因，供 UI 展示"为什么置信度低"以及建议的下一步。 */
  status: FilmBaseStatus;
}

/**
 * Estimate one physical film-base colour from co-located RGB samples.
 *
 * Independent per-channel percentiles can combine red, green and blue from
 * three unrelated pixels, inventing a colour that never existed in the
 * capture. We instead find a dominant chromaticity, keep RGB triplets intact,
 * and take robust medians from its brighter portion. A sufficiently large
 * chromatic pool keeps neutral light tables and sprocket holes from winning;
 * monochrome material naturally falls back to the full candidate population.
 */
export function estimateFilmBaseRobust(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  profileId: CaptureProfileId = 'camera_srgb',
  maxValue = 255,
  inputTransfer: InputTransfer = 'srgb',
): FilmBaseEstimate {
  const profile = getCaptureProfile(profileId);
  const step = Math.max(1, Math.floor(Math.max(width, height) / 700));
  const scale = 255 / Math.max(1, maxValue);
  const samples: Array<{
    rgb: RGB;
    luma: number;
    redChromaticity: number;
    greenChromaticity: number;
    chromaRatio: number;
  }> = [];

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = pixelIndex(x, y, width, channels);
      const rgb: RGB = [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
      const minimum = Math.min(...rgb);
      const maximum = Math.max(...rgb);
      // Reject black surround and clipped neutral light-table/sprocket samples.
      if (maximum * scale < 12 || (minimum * scale >= 245 && (maximum - minimum) * scale <= 10)) continue;
      const total = Math.max(1, rgb[0] + rgb[1] + rgb[2]);
      samples.push({
        rgb,
        luma: rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722,
        redChromaticity: rgb[0] / total,
        greenChromaticity: rgb[1] / total,
        chromaRatio: (maximum - minimum) / total,
      });
    }
  }

  if (samples.length < 4) {
    const rgb = estimateFilmBase(data, width, height, channels, maxValue, inputTransfer);
    const linearRgb = rgb.map((value) => decodeInputSample(value / 255, 'srgb')) as RGB;
    return { rgb, linearRgb, confidence: 0.2, sampleCount: 0, status: 'fallback' };
  }

  const chromatic = samples.filter((sample) => sample.chromaRatio >= 0.055);
  const useChromaticPool = chromatic.length >= Math.max(12, samples.length * 0.08);
  const pool = useChromaticPool ? chromatic : samples;
  const bins = new Map<string, { count: number; lumas: number[] }>();
  for (const sample of pool) {
    const key = `${Math.round(sample.redChromaticity * 32)}:${Math.round(sample.greenChromaticity * 32)}`;
    const bin = bins.get(key) ?? { count: 0, lumas: [] };
    bin.count += 1;
    bin.lumas.push(sample.luma);
    bins.set(key, bin);
  }
  // A large scene area can share one chromaticity while sitting well below
  // D-min. Weight population by its robust bright end so repeated real film
  // base wins without letting a handful of hot pixels define the colour.
  const rankedBins = [...bins.entries()].map(([key, bin]) => ({
    key,
    bin,
    score: bin.count * percentile([...bin.lumas], 0.9),
  })).sort((left, right) => right.score - left.score);
  const { key: dominantKey, bin: dominantBin } = rankedBins[0];
  const [redBin, greenBin] = dominantKey.split(':').map(Number);
  let matching = pool.filter((sample) => Math.abs(Math.round(sample.redChromaticity * 32) - redBin) <= 1
    && Math.abs(Math.round(sample.greenChromaticity * 32) - greenBin) <= 1);
  if (matching.length < Math.max(8, pool.length * 0.015)) matching = pool;
  // Film base is the high-transmission end of the selected chromaticity, not
  // the most common scene tone that happens to share the orange-mask ratio.
  const lowerLuma = percentile(matching.map((sample) => sample.luma), Math.max(0.84, profile.basePercentile));
  const upperLuma = percentile(matching.map((sample) => sample.luma), 0.995);
  let selected = matching.filter((sample) => sample.luma >= lowerLuma && sample.luma <= upperLuma);
  if (selected.length < 4) selected = matching.filter((sample) => sample.luma >= lowerLuma);
  const sourceRgb = [0, 1, 2].map((channel) => Math.max(1, percentile(selected.map((sample) => sample.rgb[channel]), 0.5))) as RGB;
  const linearRgb = sourceRgb.map((value) => Math.max(1e-6, sourceToLinear(value, maxValue, inputTransfer))) as RGB;
  const rgb = linearToDisplayRgb(linearRgb);
  const dominance = dominantBin.count / Math.max(1, pool.length);
  const coverage = pool.length / Math.max(1, samples.length);
  const confidence = clamp(0.42 + Math.min(0.3, dominance * 1.25)
    + Math.min(0.13, selected.length / 4000) + (useChromaticPool ? Math.min(0.08, coverage * 0.12) : 0), 0.2, 0.95);
  const status: FilmBaseStatus = selected.length < 8 ? 'low_samples' : dominance < 0.12 ? 'border_dominated' : 'ok';
  return { rgb, linearRgb, confidence, sampleCount: selected.length, status };
}

export interface FilmBaseSample {
  rgb: RGB;
  linearRgb: RGB;
}

export function sampleFilmBaseAt(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  normalizedX: number,
  normalizedY: number,
  radius = 5,
  maxValue = 255,
  inputTransfer: InputTransfer = 'srgb',
): RGB {
  return sampleFilmBaseAtDetailed(data, width, height, channels, normalizedX, normalizedY, radius, maxValue, inputTransfer).rgb;
}

export function sampleFilmBaseAtDetailed(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  normalizedX: number,
  normalizedY: number,
  radius = 5,
  maxValue = 255,
  inputTransfer: InputTransfer = 'srgb',
): FilmBaseSample {
  const cx = Math.round(clamp(normalizedX) * (width - 1));
  const cy = Math.round(clamp(normalizedY) * (height - 1));
  const sums: RGB = [0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
      const index = pixelIndex(x, y, width, channels);
      sums[0] += data[index] ?? 0;
      sums[1] += data[index + 1] ?? 0;
      sums[2] += data[index + 2] ?? 0;
      count += 1;
    }
  }
  const sourceRgb = sums.map((value) => value / Math.max(1, count)) as RGB;
  const linearRgb = sourceRgb.map((value) => Math.max(1e-6, sourceToLinear(value, maxValue, inputTransfer))) as RGB;
  return { rgb: linearToDisplayRgb(linearRgb), linearRgb };
}

export function estimateDensityAnchors(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  baseRgb: RGB,
  options: {
    inputTransfer?: InputTransfer;
    separation?: number;
    separationMatrix?: Matrix9;
    profileId?: CaptureProfileId;
    filmProfileId?: FilmResponseProfileId;
    filmStockProfileId?: string;
    neutralProtection?: number;
    crossoverStrength?: number;
    maxValue?: number;
    baseRgbLinear?: RGB;
  } = {},
): { low: RGB; high: RGB; clippedRatio: number; shadowCorrection: RGB; midCorrection: RGB; highlightCorrection: RGB; confidence: number; status: AnchorStatus } {
  const values: [number[], number[], number[]] = [[], [], []];
  const insetX = Math.max(1, Math.round(width * 0.07));
  const insetY = Math.max(1, Math.round(height * 0.07));
  const step = Math.max(1, Math.floor(Math.max(width, height) / 600));
  let clipped = 0;
  let count = 0;
  const inputTransfer = options.inputTransfer ?? 'srgb';
  const maxValue = options.maxValue ?? 255;
  const separation = options.separation ?? 0;
  const separationMatrix = options.separationMatrix;
  const decode = (value: number) => decodeInputSample(value, inputTransfer);
  const linearBase = options.baseRgbLinear
    ? options.baseRgbLinear.map((value) => Math.max(1e-6, value)) as RGB
    // baseRgb is display sRGB for UI/backward compatibility; it must not be
    // decoded using the source transfer.
    : baseRgb.map((value) => Math.max(1e-6, decodeInputSample(value / 255, 'srgb'))) as RGB;
  let sampledPixels = 0;
  let usablePixels = 0;

  for (let y = insetY; y < height - insetY; y += step) {
    for (let x = insetX; x < width - insetX; x += step) {
      const index = pixelIndex(x, y, width, channels);
      let clippedLowChannels = 0;
      const rawDensity = [0, 1, 2].map((channel) => {
        const scan = decode((data[index + channel] ?? 0) / maxValue);
        const transmission = scan / linearBase[channel];
        if (transmission <= 0.005) clippedLowChannels += 1;
        if (transmission <= 0.005 || transmission >= 1.05) clipped += 1;
        // A finite density ceiling prevents near-zero/clipped carriers from
        // creating logarithmic spikes that dominate robust tail statistics.
        return Math.min(3.2, -Math.log10(Math.max(0.000001, transmission)));
      }) as RGB;
      sampledPixels += 1;

      // Film-base density is D=0. White sprocket holes and an exposed light
      // table are brighter than the sampled orange base in every channel and
      // therefore have a negative median density. They are not picture data;
      // including them made the automatic black anchor negative and lifted the
      // entire positive into a pale, low-contrast result. Pixels clipped in at
      // least two channels contain no reliable D-max information either.
      const orderedRawDensity = [...rawDensity].sort((left, right) => left - right);
      if (orderedRawDensity[1] < -0.025 || clippedLowChannels >= 2) continue;

      const separated = applyDensitySeparation(rawDensity, separation, separationMatrix);
      for (let channel = 0; channel < 3; channel += 1) values[channel].push(separated[channel]);
      usablePixels += 1;
    }
  }

  count = sampledPixels * 3;
  const clippedRatio = count ? clipped / count : 0;
  const filmProfile = getFilmResponseProfile(options.filmProfileId ?? 'generic_color_negative');
  const stockProfile = options.filmStockProfileId ? getFilmStockProfile(options.filmStockProfileId) : undefined;
  const highPercentile = stockProfile?.highPercentile ?? filmProfile.highPercentile;
  const minimumDensitySpan = stockProfile?.minimumDensitySpan ?? filmProfile.minimumDensitySpan;
  const crossoverCorrection = stockProfile ? stockProfile.crossoverCorrection : filmProfile.crossoverCorrection;
  const crossoverStrength = stockProfile?.crossoverStrength ?? options.crossoverStrength ?? 1;
  // The selected film base is the physical D-min reference, so its density is
  // exactly zero. Percentile-estimating D-min from a full strip lets borders,
  // holes and illumination gradients redefine black and is not stable.
  const low: RGB = [0, 0, 0];
  // First obtain provisional channel spans. They are used only to discover a
  // neutral high-density population; the saved anchors below come from the
  // same pixel indices in all three channels.
  const provisionalHigh = [0, 1, 2].map((channel) => Math.max(
    minimumDensitySpan,
    percentile(values[channel], highPercentile),
  )) as RGB;
  const provisionalLuminance = values[0].map((_, index) => {
    const normalized: RGB = [0, 1, 2].map((channel) => values[channel][index] / provisionalHigh[channel]) as RGB;
    return normalized[0] * 0.2126 + normalized[1] * 0.7152 + normalized[2] * 0.0722;
  });
  const provisionalChroma = values[0].map((_, index) => {
    const normalized = [0, 1, 2].map((channel) => values[channel][index] / provisionalHigh[channel]);
    return Math.max(...normalized) - Math.min(...normalized);
  });
  const anchorFloor = percentile([...provisionalLuminance], Math.max(0.82, highPercentile - 0.04));
  const anchorCeiling = percentile([...provisionalLuminance], Math.min(0.997, highPercentile + 0.005));
  const highBandIndices = provisionalLuminance.flatMap((luma, index) => (
    luma >= anchorFloor && luma <= anchorCeiling ? [index] : []
  ));
  const highBandChroma = percentile(highBandIndices.map((index) => provisionalChroma[index]), 0.35);
  const coLocatedHighIndices = highBandIndices.filter((index) => provisionalChroma[index] <= highBandChroma);
  const high: RGB = coLocatedHighIndices.length >= 8
    ? [0, 1, 2].map((channel) => Math.max(
      minimumDensitySpan,
      percentile(coLocatedHighIndices.map((index) => values[channel][index]), 0.5),
    )) as RGB
    : provisionalHigh;

  // Estimate neutral residuals after channel-span normalization. Doing this in
  // raw density space biases the result toward the channel with the widest
  // film response and can create the magenta/blue crossover seen on grey cloth.
  const normalizedValues = values[0].map((_, index) => [0, 1, 2].map((channel) => (
    values[channel][index] - low[channel]
  ) / Math.max(0.001, high[channel] - low[channel])) as RGB);
  const luminances = normalizedValues.map((normalized) => (
    normalized[0] * 0.2126 + normalized[1] * 0.7152 + normalized[2] * 0.0722
  ));
  const chroma = normalizedValues.map((normalized) => Math.max(...normalized) - Math.min(...normalized));
  const profile = getCaptureProfile(options.profileId ?? 'camera_srgb');
  const protection = clamp((options.neutralProtection ?? 55) / 100);
  const meanSpan = high.reduce((sum, value, channel) => sum + value - low[channel], 0) / 3;
  const maximumShift = meanSpan * profile.whiteBalanceLimit * protection;
  const correctionForBand = (minimum: number, maximum: number): { correction: RGB; count: number } => {
    const bandIndices = luminances.flatMap((luma, index) => luma >= minimum && luma <= maximum ? [index] : []);
    if (bandIndices.length < 8) return { correction: [0, 0, 0], count: 0 };
    const neutralThreshold = percentile(bandIndices.map((index) => chroma[index]), 0.35);
    const neutralIndices = bandIndices.filter((index) => chroma[index] <= neutralThreshold);
    if (neutralIndices.length < 4) return { correction: [0, 0, 0], count: 0 };
    const residual = [0, 1, 2].map((channel) => {
      const normalizedResidual = percentile(
        neutralIndices.map((index) => normalizedValues[index][channel] - luminances[index]),
        0.5,
      );
      return normalizedResidual * Math.max(0.001, high[channel] - low[channel]);
    }) as RGB;
    return {
      correction: residual.map((value) => clamp(value, -maximumShift, maximumShift)) as RGB,
      count: neutralIndices.length,
    };
  };
  const scaleBand = (band: { correction: RGB; count: number }, strength: number): { correction: RGB; count: number } => ({
    correction: band.correction.map((value) => clamp(value * strength, -maximumShift, maximumShift)) as RGB,
    count: band.count,
  });
  const zeroBand = { correction: [0, 0, 0] as RGB, count: 0 };
  // A single white-balance offset cannot correct density-dependent mask
  // crossover. Estimate bounded residuals in three tonal bands (shadows, mids,
  // highlights) and interpolate between them during reconstruction. This
  // remains a scene estimate, not a substitute for a measured spectral profile.
  const shadows = crossoverCorrection ? scaleBand(correctionForBand(0.08, 0.42), crossoverStrength) : zeroBand;
  const mids = crossoverCorrection ? scaleBand(correctionForBand(0.42, 0.58), crossoverStrength) : zeroBand;
  const highlights = crossoverCorrection ? scaleBand(correctionForBand(0.58, 0.92), crossoverStrength) : zeroBand;
  const neutralShare = (shadows.count + mids.count + highlights.count) / Math.max(1, luminances.length);
  const bandCoverage = crossoverCorrection
    ? Number(shadows.count > 0) + Number(mids.count > 0) + Number(highlights.count > 0)
    : 3;
  const usableShare = usablePixels / Math.max(1, sampledPixels);
  const coLocatedHighShare = coLocatedHighIndices.length / Math.max(1, highBandIndices.length);
  const confidence = clamp(0.4 + bandCoverage * 0.08 + Math.min(0.2, neutralShare * 2)
    + Math.min(0.08, coLocatedHighShare * 0.2)
    + Math.min(0.08, usableShare * 0.1) - clippedRatio * 1.4, 0.2, 0.94);
  const status: AnchorStatus = !luminances.length ? 'fallback'
    : clippedRatio > 0.5 ? 'heavily_clipped'
      : usableShare < 0.2 ? 'low_usable'
        : crossoverCorrection && neutralShare < 0.08 ? 'low_neutral' : 'ok';
  return {
    low,
    high,
    clippedRatio,
    shadowCorrection: shadows.correction,
    midCorrection: mids.correction,
    highlightCorrection: highlights.correction,
    confidence,
    status,
  };
}

export function detectContentRect(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  baseRgb = estimateFilmBase(data, width, height, channels),
  options: { maxValue?: number; inputTransfer?: InputTransfer; baseRgbLinear?: RGB } = {},
): { crop: CropRect; confidence: number } {
  const step = Math.max(1, Math.floor(Math.max(width, height) / 500));
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;
  let total = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = pixelIndex(x, y, width, channels);
      const maxValue = options.maxValue ?? 255;
      const transfer = options.inputTransfer ?? 'srgb';
      const density = [0, 1, 2].reduce((sum, channel) => {
        const scan = sourceToLinear(data[index + channel] ?? 1, maxValue, transfer);
        const base = options.baseRgbLinear?.[channel] ?? decodeInputSample(baseRgb[channel] / 255, 'srgb');
        const transmission = Math.max(0.001, scan / Math.max(1e-6, base));
        return sum + Math.abs(-Math.log10(transmission));
      }, 0) / 3;
      total += 1;
      if (density > 0.11) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        hits += 1;
      }
    }
  }

  if (hits < total * 0.08 || maxX <= minX || maxY <= minY) {
    return { crop: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.2 };
  }

  const paddingX = width * 0.008;
  const paddingY = height * 0.008;
  const left = clamp((minX - paddingX) / width);
  const top = clamp((minY - paddingY) / height);
  const right = clamp((maxX + paddingX) / width);
  const bottom = clamp((maxY + paddingY) / height);
  const crop = { x: left, y: top, width: Math.max(0.02, right - left), height: Math.max(0.02, bottom - top) };
  const area = crop.width * crop.height;
  const confidence = clamp(0.45 + hits / total * 0.7 - Math.abs(area - 0.82) * 0.25, 0.35, 0.96);
  return { crop, confidence };
}

/**
 * Finds the physical film carrier inside a camera copy that may also contain a
 * bright light table, holders or fingers.  This is intentionally different
 * from detectContentRect(): the returned rectangle includes frame borders and
 * unexposed film base so calibration can sample D-min, while excluding most of
 * the surrounding light source.  It is an axis-aligned analysis ROI only and
 * must never be written into photo geometry.
 */
export function detectFilmRegion(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  maxValue = 255,
): { crop: CropRect; confidence: number } {
  if (width < 8 || height < 8 || channels < 3) {
    return { crop: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.1 };
  }
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 420));
  const columns = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const luma = new Float32Array(columns * rows);
  const chroma = new Float32Array(columns * rows);
  const borderLuma: number[] = [];

  for (let gy = 0; gy < rows; gy += 1) {
    const y = Math.min(height - 1, gy * step);
    for (let gx = 0; gx < columns; gx += 1) {
      const x = Math.min(width - 1, gx * step);
      const index = pixelIndex(x, y, width, channels);
      const scale = 255 / Math.max(1, maxValue);
      const red = (data[index] ?? 0) * scale;
      const green = (data[index + 1] ?? 0) * scale;
      const blue = (data[index + 2] ?? 0) * scale;
      const at = gy * columns + gx;
      luma[at] = red * .2126 + green * .7152 + blue * .0722;
      chroma[at] = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (gx < columns * .08 || gx >= columns * .92 || gy < rows * .08 || gy >= rows * .92) {
        borderLuma.push(luma[at]);
      }
    }
  }

  // A high border percentile is a stable estimate of the light table even
  // when fingers or a holder cover two or three corners.
  const background = Math.max(32, percentile(borderLuma, .78));
  const minimumFilmLuma = Math.max(18, background * .12);
  const candidate = new Uint8Array(columns * rows);
  const rowScores = new Float32Array(rows);
  const columnScores = new Float32Array(columns);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < columns; gx += 1) {
      const at = gy * columns + gx;
      // Film is either darker than the light table or visibly chromatic. Very
      // dark holders/fingers are rejected so they cannot define the ROI.
      const isFilm = luma[at] >= minimumFilmLuma
        && (luma[at] <= background * .93 || chroma[at] >= 14);
      if (!isFilm) continue;
      candidate[at] = 1;
      rowScores[gy] += 1 / columns;
      columnScores[gx] += 1 / rows;
    }
  }

  const findBand = (scores: Float32Array, threshold: number): { start: number; end: number; mean: number } | undefined => {
    let best: { start: number; end: number; mean: number; weight: number } | undefined;
    let start = -1;
    let sum = 0;
    let gap = 0;
    const finish = (end: number) => {
      if (start < 0) return;
      const length = Math.max(1, end - start + 1);
      const mean = sum / length;
      const weight = length * Math.max(.01, mean - threshold * .55);
      if (!best || weight > best.weight) best = { start, end, mean, weight };
      start = -1;
      sum = 0;
      gap = 0;
    };
    for (let index = 0; index < scores.length; index += 1) {
      if (scores[index] >= threshold) {
        if (start < 0) start = index;
        sum += scores[index];
        gap = 0;
      } else if (start >= 0 && gap < 1) {
        sum += scores[index];
        gap += 1;
      } else if (start >= 0) {
        finish(index - gap - 1);
      }
    }
    if (start >= 0) finish(scores.length - gap - 1);
    return best;
  };

  const rowBand = findBand(rowScores, .24);
  const columnBand = findBand(columnScores, .24);
  if (!rowBand && !columnBand) {
    return { crop: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.18 };
  }

  // Prefer the strong carrier band on one axis, then measure occupancy inside
  // that band on the other. This keeps white sprocket holes inside the result.
  let top = rowBand?.start ?? 0;
  let bottom = rowBand?.end ?? rows - 1;
  let left = columnBand?.start ?? 0;
  let right = columnBand?.end ?? columns - 1;
  if (rowBand) {
    const bandHeight = Math.max(1, bottom - top + 1);
    const within = new Float32Array(columns);
    for (let gx = 0; gx < columns; gx += 1) {
      for (let gy = top; gy <= bottom; gy += 1) within[gx] += candidate[gy * columns + gx] / bandHeight;
    }
    // Contact sheets and long strips can be split by bright sprocket columns.
    // Taking only the strongest contiguous run silently analyzes one frame;
    // use the envelope of all occupied runs inside the strong carrier row.
    const occupied = [...within.keys()].filter((index) => within[index] >= .18);
    if (occupied.length) { left = occupied[0]; right = occupied[occupied.length - 1]; }
  } else if (columnBand) {
    const bandWidth = Math.max(1, right - left + 1);
    const within = new Float32Array(rows);
    for (let gy = 0; gy < rows; gy += 1) {
      for (let gx = left; gx <= right; gx += 1) within[gy] += candidate[gy * columns + gx] / bandWidth;
    }
    const occupied = [...within.keys()].filter((index) => within[index] >= .18);
    if (occupied.length) { top = occupied[0]; bottom = occupied[occupied.length - 1]; }
  }

  const paddingX = Math.max(1, Math.round(columns * .012));
  const paddingY = Math.max(1, Math.round(rows * .012));
  left = Math.max(0, left - paddingX);
  right = Math.min(columns - 1, right + paddingX);
  top = Math.max(0, top - paddingY);
  bottom = Math.min(rows - 1, bottom + paddingY);
  const crop: CropRect = {
    x: left / columns,
    y: top / rows,
    width: Math.max(.04, (right - left + 1) / columns),
    height: Math.max(.04, (bottom - top + 1) / rows),
  };
  const area = crop.width * crop.height;
  const bandStrength = Math.max(rowBand?.mean ?? 0, columnBand?.mean ?? 0);
  const hasUsefulInset = area < .94 && area > .08;
  const confidence = clamp(.34 + bandStrength * .55 + (rowBand && columnBand ? .1 : 0) + (hasUsefulInset ? .08 : 0), .18, .96);
  return { crop, confidence };
}

export interface SprocketRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Detects sprocket holes in a backlit scan as contiguous near-white columns in
 * the top or bottom border band. This is a cheap projection heuristic for the
 * common "light through the hole" case; reflective or very faded scans need a
 * real hole detector. It is not an ML edge model.
 */
export function detectSprocketHoles(
  data: PixelSamples,
  width: number,
  height: number,
  channels: number,
  side: 'top' | 'bottom' = 'top',
  maxValue = 255,
): SprocketRegion[] {
  const bandHeight = Math.max(4, Math.round(height * 0.09));
  const y0 = side === 'top' ? 0 : Math.max(0, height - bandHeight);
  const profile = new Float32Array(width);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = y0; y < Math.min(height, y0 + bandHeight); y += 1) {
      const index = (y * width + x) * channels;
      sum += ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3 * 255 / Math.max(1, maxValue);
    }
    profile[x] = sum / Math.max(1, Math.min(height, y0 + bandHeight) - y0);
  }
  const threshold = 200;
  const minimumHoleWidth = Math.max(4, Math.round(width * 0.02));
  const holes: SprocketRegion[] = [];
  let start = -1;
  for (let x = 0; x <= width; x += 1) {
    const bright = x < width && profile[x] >= threshold;
    if (bright && start < 0) start = x;
    if ((!bright || x === width) && start >= 0) {
      if (x - start >= minimumHoleWidth) holes.push({ x: start, y: y0, width: x - start, height: bandHeight });
      start = -1;
    }
  }
  return holes;
}
