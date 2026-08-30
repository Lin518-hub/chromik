import { applyGeometry, correctLensAndStraightenPixels, orientPixels, type PixelArray } from '../../core/geometry';
import {
  detectContentRect,
  detectFilmRegion,
  estimateDensityAnchors,
  estimateFilmBase,
  estimateFilmBaseRobust,
  sampleFilmBaseAtDetailed,
  type FilmBaseSample,
} from '../../core/density';
import { detectDustSpots, type DustCandidate } from '../../core/dust-detect';
import { calculateHistogram, calculateWaveform, type WaveformData } from '../../core/histogram';
import { cropPixels } from '../../core/image';
import { deserializeCubeLut, serializeCubeLut, type CubeLut, type SerializedCubeLut } from '../../core/cube';
import { processPixelSource } from '../../core/reconstruct';
import { quantizeUint16To8 } from '../../core/quantize';
import { packDisplayRgba } from '../../core/display-buffer';
import { liftLinearRawDisplayProxy16, preparePositiveRawLinear16 } from '../../core/raw-display';
import { GpuPreviewRenderer } from '../gpu-preview';
import type { CropRect, DevelopProxyDescriptor, EditRecipe, RGB } from '../../shared/types';

interface SourceMessage {
  type: 'source';
  sourceVersion: number;
  width: number;
  height: number;
  descriptor: DevelopProxyDescriptor;
  pixels: ArrayBuffer;
  /** PERF-01：交互代理长边（1080p 档；慢设备由渲染端自适应降回 720）。 */
  interactiveEdge?: number;
}

interface RenderMessage {
  type: 'render';
  requestId: number;
  sourceVersion: number;
  recipe: EditRecipe;
  compare: boolean;
  geometryEditing: boolean;
  showFullSource: boolean;
  rawSource: boolean;
  cameraRaw: boolean;
  rawDisplayTransform: 'camera-raw-neutral' | 'camera-raw-legacy-lift';
  interactive: boolean;
  /** 反馈③：空闲升级档位（约 1600px 长边），替代全分辨率渲染。 */
  idle?: boolean;
  splitCompare?: boolean;
  lut?: ReturnType<typeof serializeCubeLut>;
  validateGpu?: boolean;
}

interface AnalyzeMessage {
  type: 'analyze';
  requestId: number;
  sourceVersion: number;
  kind: 'invert' | 'crop' | 'film-region' | 'sample' | 'dust';
  recipe: EditRecipe;
  reestimateBase?: boolean;
  baseRgbOverride?: RGB;
  baseRgbLinearOverride?: RGB;
  analysisRegion?: CropRect;
  normalizedX?: number;
  normalizedY?: number;
}

type PreviewMessage = SourceMessage | RenderMessage | AnalyzeMessage;

type AnalysisResult =
  | { kind: 'invert'; baseRgb: RGB; baseRgbLinear: RGB; low: RGB; high: RGB; clippedRatio: number; shadowCorrection: RGB; midCorrection: RGB; highlightCorrection: RGB; confidence: number; baseConfidence: number; baseStatus: string; anchorStatus: string }
  | { kind: 'crop'; crop: CropRect; confidence: number }
  | { kind: 'film-region'; crop: CropRect; confidence: number }
  | ({ kind: 'sample' } & FilmBaseSample)
  | { kind: 'dust'; candidates: DustCandidate[] };

interface PreviewResponse {
  type: 'rendered' | 'analysis' | 'error';
  requestId: number;
  sourceVersion: number;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  pixels?: ArrayBuffer;
  histogram?: [number[], number[], number[]];
  waveform?: WaveformData;
  analysis?: AnalysisResult;
  message?: string;
  backend?: 'gpu-webgl2' | 'cpu-reference';
  durationMs?: number;
  gpuValidation?: { average: number; p99: number; maximum: number; passed: boolean };
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewMessage>) => void) | null;
  postMessage(message: PreviewResponse, transfer?: Transferable[]): void;
};

interface PixelSource {
  width: number;
  height: number;
  channels: 3 | 4;
  descriptor: DevelopProxyDescriptor;
  data: PixelArray;
}

let source: { version: number; full: PixelSource; interactive: PixelSource; idle: PixelSource } | undefined;
let gpuRenderer: GpuPreviewRenderer | null | undefined;
const geometryCache = new Map<string, ReturnType<typeof applyGeometry>>();
const lutCache = new Map<SerializedCubeLut, CubeLut>();

function maxValueOf(pixelSource: PixelSource): 255 | 65535 {
  return pixelSource.descriptor.bitDepth === 16 ? 65535 : 255;
}

function cachedGeometry(message: RenderMessage, renderSource: PixelSource): ReturnType<typeof applyGeometry> {
  const tier = message.idle ? 'idle' : message.interactive ? 'interactive' : 'full';
  if (message.showFullSource) {
    if (message.geometryEditing) {
      const key = `${message.sourceVersion}:${tier}:full-geometry:${JSON.stringify({
        straighten: message.recipe.geometry.straighten,
        lensDistortion: message.recipe.geometry.lensDistortion,
        rotation90: message.recipe.geometry.rotation90,
        flipX: message.recipe.geometry.flipX,
        flipY: message.recipe.geometry.flipY,
      })}`;
      const cached = geometryCache.get(key);
      if (cached) return cached;
      // Crop editing must retain the complete source so its handles remain
      // available, but direction and lens controls still need a live result.
      const corrected = correctLensAndStraightenPixels(
        renderSource.data,
        renderSource.width,
        renderSource.height,
        renderSource.channels,
        message.recipe.geometry,
      );
      const transformed = orientPixels(corrected.data, corrected.width, corrected.height, corrected.channels, message.recipe.geometry);
      geometryCache.set(key, transformed);
      while (geometryCache.size > 6) geometryCache.delete(geometryCache.keys().next().value as string);
      return transformed;
    }
    return { data: renderSource.data, width: renderSource.width, height: renderSource.height, channels: renderSource.channels };
  }
  const key = `${message.sourceVersion}:${tier}:${JSON.stringify(message.recipe.geometry)}`;
  const cached = geometryCache.get(key);
  if (cached) {
    geometryCache.delete(key);
    geometryCache.set(key, cached);
    return cached;
  }
  const transformed = applyGeometry(renderSource.data, renderSource.width, renderSource.height, renderSource.channels, message.recipe.geometry);
  geometryCache.set(key, transformed);
  while (geometryCache.size > 6) geometryCache.delete(geometryCache.keys().next().value as string);
  return transformed;
}

function cachedCubeLut(lut: SerializedCubeLut): CubeLut {
  const cached = lutCache.get(lut);
  if (cached) return cached;
  const deserialized = deserializeCubeLut(lut);
  lutCache.set(lut, deserialized);
  while (lutCache.size > 10) lutCache.delete(lutCache.keys().next().value as SerializedCubeLut);
  return deserialized;
}

function createLike(sourceData: PixelArray, length: number): PixelArray {
  return sourceData instanceof Uint16Array ? new Uint16Array(length) : new Uint8ClampedArray(length);
}

function createInteractiveSource(full: PixelSource, maxEdge = 720): PixelSource {
  const scale = Math.min(1, maxEdge / Math.max(full.width, full.height));
  if (scale === 1) return full;
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const data = createLike(full.data, width * height * full.channels);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(full.height - 1, Math.floor((y + .5) / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(full.width - 1, Math.floor((x + .5) / scale));
      const from = (sourceY * full.width + sourceX) * full.channels;
      const to = (y * width + x) * full.channels;
      for (let channel = 0; channel < full.channels; channel += 1) data[to + channel] = full.data[from + channel] ?? 0;
    }
  }
  return { ...full, width, height, data };
}

function linearToSrgb(value: number): number {
  const safe = Math.max(0, Math.min(1, value));
  return safe <= 0.0031308 ? safe * 12.92 : 1.055 * safe ** (1 / 2.4) - 0.055;
}

function srgbToLinear(value: number): number {
  const safe = Math.max(0, Math.min(1, value));
  return safe <= 0.04045 ? safe / 12.92 : ((safe + 0.055) / 1.055) ** 2.4;
}

function sourceToDisplay8(
  data: PixelArray,
  channels: number,
  bitDepth: 8 | 16,
  transfer: 'srgb' | 'linear',
  cameraRaw: boolean,
  rawDisplayTransform: 'camera-raw-neutral' | 'camera-raw-legacy-lift',
): Uint8ClampedArray {
  if (cameraRaw && rawDisplayTransform === 'camera-raw-legacy-lift'
    && channels === 3 && bitDepth === 16 && transfer === 'linear' && data instanceof Uint16Array) {
    return liftLinearRawDisplayProxy16(data);
  }
  const maxValue = bitDepth === 16 ? 65535 : 255;
  const output = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += channels) {
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
      const normalized = (data[index + channel] ?? 0) / maxValue;
      output[index + channel] = Math.round((transfer === 'linear' ? linearToSrgb(normalized) : normalized) * 255);
    }
    if (channels === 4) output[index + 3] = Math.round((data[index + 3] ?? maxValue) / maxValue * 255);
  }
  return output;
}

function processedToDisplay8(data: Uint8ClampedArray | Uint16Array, bitDepth: 8 | 16, width: number, channels: number): Uint8ClampedArray {
  if (bitDepth === 8) return data as Uint8ClampedArray;
  return quantizeUint16To8(data as Uint16Array, width, channels);
}

function compositeSplit(original: Uint8ClampedArray, processed: Uint8ClampedArray, width: number, height: number, channels: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(original.length);
  const midX = Math.floor(width / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      const selected = x > midX ? processed : original;
      for (let channel = 0; channel < channels; channel += 1) output[index + channel] = selected[index + channel];
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = midX - 1; x <= midX + 1; x += 1) {
      if (x < 0 || x >= width) continue;
      const index = (y * width + x) * channels;
      output[index] = 255;
      output[index + 1] = 255;
      output[index + 2] = 255;
      if (channels === 4) output[index + 3] = 255;
    }
  }
  return output;
}

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'source') {
    geometryCache.clear();
    const data = new Uint16Array(message.pixels);
    const full: PixelSource = {
      width: message.width,
      height: message.height,
      channels: message.descriptor.channels,
      descriptor: message.descriptor,
      data,
    };
    source = {
      version: message.sourceVersion,
      full,
      interactive: createInteractiveSource(full, message.interactiveEdge ?? 720),
      // 反馈③：空闲升级档位约 1600px 长边——比全分辨率（3072/4096）快
      // 数倍，视觉上在画布缩放范围内几乎无差。
      idle: createInteractiveSource(full, 1600),
    };
    return;
  }

  try {
    const startedAt = performance.now();
    if (!source || source.version !== message.sourceVersion) {
      // A frame switch may queue a render before the new proxy is processed.
      // Drain stale requests silently so the user only sees the newest paint.
      if (!source) {
        workerScope.postMessage({ type: 'error', requestId: message.requestId, sourceVersion: message.sourceVersion ?? 0, message: '预览源尚未就绪' });
        return;
      }
      throw new Error('预览源已更新');
    }
    if (message.type === 'analyze') {
      const full = source.full;
      const maxValue = maxValueOf(full);
      if (message.kind === 'crop') {
        const result = detectContentRect(full.data, full.width, full.height, full.channels, message.recipe.baseRgb, {
          maxValue,
          inputTransfer: full.descriptor.transfer,
          baseRgbLinear: message.recipe.baseRgbLinear,
        });
        workerScope.postMessage({ type: 'analysis', requestId: message.requestId, sourceVersion: message.sourceVersion, analysis: { kind: 'crop', ...result } });
      } else if (message.kind === 'film-region') {
        const result = detectFilmRegion(full.data, full.width, full.height, full.channels, maxValue);
        workerScope.postMessage({ type: 'analysis', requestId: message.requestId, sourceVersion: message.sourceVersion, analysis: { kind: 'film-region', ...result } });
      } else if (message.kind === 'sample') {
        const result = sampleFilmBaseAtDetailed(full.data, full.width, full.height, full.descriptor.channels, message.normalizedX ?? .5, message.normalizedY ?? .5, 5, maxValue, full.descriptor.transfer);
        workerScope.postMessage({ type: 'analysis', requestId: message.requestId, sourceVersion: message.sourceVersion, analysis: { kind: 'sample', ...result } });
      } else if (message.kind === 'dust') {
        const candidates = detectDustSpots(full.data, full.width, full.height, full.descriptor.channels, maxValue, { maxSpots: 80 });
        workerScope.postMessage({ type: 'analysis', requestId: message.requestId, sourceVersion: message.sourceVersion, analysis: { kind: 'dust', candidates } });
      } else {
        const region = message.analysisRegion ?? message.recipe.crop;
        const cropped = cropPixels(full.data, full.width, full.height, full.descriptor.channels, region);
        const shouldEstimateBase = !message.baseRgbOverride && !message.baseRgbLinearOverride
          && (message.reestimateBase || (!message.recipe.baseRgb && !message.recipe.baseRgbLinear));
        const robustBase = shouldEstimateBase
          ? estimateFilmBaseRobust(cropped.data, cropped.width, cropped.height, full.descriptor.channels, message.recipe.density.profileId, maxValue, full.descriptor.transfer)
          : undefined;
        const baseRgb = message.baseRgbOverride ?? (shouldEstimateBase
          ? robustBase?.rgb ?? estimateFilmBase(cropped.data, cropped.width, cropped.height, full.descriptor.channels, maxValue, full.descriptor.transfer)
          : message.recipe.baseRgb!);
        const baseRgbLinear = message.baseRgbLinearOverride ?? robustBase?.linearRgb ?? message.recipe.baseRgbLinear;
        const anchors = estimateDensityAnchors(cropped.data, cropped.width, cropped.height, full.descriptor.channels, baseRgb, {
          inputTransfer: full.descriptor.transfer,
          maxValue,
          baseRgbLinear,
          separation: message.recipe.density.separation,
          separationMatrix: message.recipe.density.separationMatrix,
          profileId: message.recipe.density.profileId,
          filmProfileId: message.recipe.density.filmProfileId,
          filmStockProfileId: message.recipe.density.filmStockProfileId,
          neutralProtection: message.recipe.density.neutralProtection,
          crossoverStrength: message.recipe.density.crossoverStrength,
        });
        const { status: anchorStatus, ...anchorResult } = anchors;
        // The estimator derives bounded tonal neutral-axis residuals from the
        // same co-located RGB population used for the anchors. Keep those
        // results in both automatic and manual-base workflows so grey subjects
        // do not retain a density-dependent magenta/blue cast.
        workerScope.postMessage({
          type: 'analysis',
          requestId: message.requestId,
          sourceVersion: message.sourceVersion,
          analysis: {
            kind: 'invert',
            baseRgb,
            baseRgbLinear: baseRgbLinear ?? baseRgb.map((value) => srgbToLinear(value / 255)) as RGB,
            baseConfidence: robustBase?.confidence ?? (shouldEstimateBase ? 0.65 : 1),
            baseStatus: robustBase?.status ?? (shouldEstimateBase ? 'fallback' : 'ok'),
            anchorStatus,
            ...anchorResult,
            shadowCorrection: anchorResult.shadowCorrection,
            midCorrection: anchorResult.midCorrection,
            highlightCorrection: anchorResult.highlightCorrection,
          },
        });
      }
      return;
    }

    const renderSource = message.idle ? source.idle : message.interactive ? source.interactive : source.full;
    const transformed = cachedGeometry(message, renderSource);
    const renderOptions = {
      width: transformed.width,
      height: transformed.height,
      lut: message.lut ? cachedCubeLut(message.lut) : undefined,
    };
    const original = sourceToDisplay8(
      transformed.data,
      transformed.channels,
      renderSource.descriptor.bitDepth,
      renderSource.descriptor.transfer,
      message.cameraRaw,
      message.rawDisplayTransform,
    );
    let rendered: Uint8ClampedArray;
    let renderedChannels = transformed.channels;
    let backend: PreviewResponse['backend'] = 'cpu-reference';
    let gpuValidation: PreviewResponse['gpuValidation'];
    const positiveRaw = message.cameraRaw && !message.recipe.density.enabled && transformed.data instanceof Uint16Array;
    const processingData = positiveRaw
      ? preparePositiveRawLinear16(transformed.data as Uint16Array, renderSource.descriptor.transfer, message.rawDisplayTransform)
      : transformed.data;
    const processingDescriptor = positiveRaw
      ? { ...renderSource.descriptor, transfer: 'linear' as const }
      : renderSource.descriptor;
    if (message.compare || message.rawSource) {
      rendered = original;
    } else if ((message.interactive || message.idle) && processingData instanceof Uint16Array) {
      if (gpuRenderer === undefined) {
        try { gpuRenderer = new GpuPreviewRenderer(); } catch { gpuRenderer = null; }
      }
      if (gpuRenderer?.supports(message.recipe, transformed.channels, Boolean(message.lut))) {
        let gpuSucceeded = false;
        try {
          rendered = gpuRenderer.render(processingData, transformed.width, transformed.height, message.recipe, message.splitCompare);
          renderedChannels = 4;
          backend = 'gpu-webgl2';
          gpuSucceeded = true;
        } catch (gpuError) {
          // One bad uniform or readPixels failure shouldn't kill the whole
          // preview. Disable the GPU path for this worker and fall back to
          // the CPU pipeline so interactive adjustment still responds.
          try { gpuRenderer?.dispose?.(); } catch { /* already lost */ }
          gpuRenderer = null;
          console.warn('FilmLab: GPU preview failed, falling back to CPU', gpuError);
          const processed = processPixelSource(processingData, transformed.channels, message.recipe, processingDescriptor, renderOptions);
          const processedDisplay = processedToDisplay8(processed, processingDescriptor.bitDepth, transformed.width, transformed.channels);
          rendered = message.splitCompare ? compositeSplit(original, processedDisplay, transformed.width, transformed.height, transformed.channels) : processedDisplay;
        }
        if (gpuSucceeded && message.validateGpu) {
          const cpu16 = processPixelSource(processingData, transformed.channels, message.recipe, processingDescriptor, renderOptions);
          const cpu8 = processedToDisplay8(cpu16, processingDescriptor.bitDepth, transformed.width, transformed.channels);
          const cpuDisplay = packDisplayRgba(message.splitCompare
            ? compositeSplit(original, cpu8, transformed.width, transformed.height, transformed.channels)
            : cpu8, transformed.channels);
          const errors: number[] = [];
          let sum = 0;
          let maximum = 0;
          for (let index = 0; index < rendered.length; index += 4) {
            for (let channel = 0; channel < 3; channel += 1) {
              const error = Math.abs(rendered[index + channel] - cpuDisplay[index + channel]);
              errors.push(error);
              sum += error;
              maximum = Math.max(maximum, error);
            }
          }
          errors.sort((left, right) => left - right);
          const average = sum / Math.max(1, errors.length);
          const p99 = errors[Math.floor(errors.length * .99)] ?? 0;
          // QA-02：与 §13.1 同阈值（平均 ≤1.5、P99 ≤3 码值）。
          gpuValidation = { average, p99, maximum, passed: average <= 1.5 && p99 <= 3 };
        }
      } else {
        const processed = processPixelSource(processingData, transformed.channels, message.recipe, processingDescriptor, renderOptions);
        const processedDisplay = processedToDisplay8(processed, processingDescriptor.bitDepth, transformed.width, transformed.channels);
        rendered = message.splitCompare ? compositeSplit(original, processedDisplay, transformed.width, transformed.height, transformed.channels) : processedDisplay;
      }
    } else {
      const processed = processPixelSource(processingData as Uint16Array, transformed.channels, message.recipe, processingDescriptor, renderOptions);
      const processedDisplay = processedToDisplay8(processed, processingDescriptor.bitDepth, transformed.width, transformed.channels);
      rendered = message.splitCompare
        ? compositeSplit(original, processedDisplay, transformed.width, transformed.height, transformed.channels)
        : processedDisplay;
    }

    const pixels = packDisplayRgba(rendered, renderedChannels);
    const response: PreviewResponse = {
      type: 'rendered',
      requestId: message.requestId,
      sourceVersion: message.sourceVersion,
      width: transformed.width,
      height: transformed.height,
      displayWidth: (message.interactive || message.idle) ? Math.round(transformed.width * source.full.width / renderSource.width) : transformed.width,
      displayHeight: (message.interactive || message.idle) ? Math.round(transformed.height * source.full.height / renderSource.height) : transformed.height,
      pixels: pixels.buffer as ArrayBuffer,
      histogram: calculateHistogram(rendered, renderedChannels),
      waveform: calculateWaveform(rendered, transformed.width, transformed.height, renderedChannels),
      backend,
      durationMs: performance.now() - startedAt,
      gpuValidation,
    };
    workerScope.postMessage(response, [pixels.buffer as ArrayBuffer]);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: message.requestId,
      sourceVersion: message.sourceVersion,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
