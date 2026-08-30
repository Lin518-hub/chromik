import { clamp } from './image';
import type { Quad } from '../shared/types';

export interface FrameDetection {
  corners: Quad;
  score: number;
}

export interface FrameDetectOptions {
  kind?: 'strip' | 'contact' | 'single' | 'unknown';
  maxFrames?: number;
}

function gray(data: ArrayLike<number>, at: number, channels: number): number {
  return ((data[at] ?? 0) * 0.2126 + (data[at + 1] ?? 0) * 0.7152 + (data[at + 2] ?? 0) * 0.0722) / 255;
}

function smooth(values: number[], radius: number): number[] {
  const result = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = i + offset;
      if (index < 0 || index >= values.length) continue;
      sum += values[index]; count += 1;
    }
    result[i] = sum / Math.max(1, count);
  }
  return result;
}

function boundaries(projection: number[], maxFrames: number): number[] {
  const values = smooth(projection, Math.max(2, Math.round(projection.length / 160)));
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const high = sorted[Math.floor(sorted.length * 0.85)] ?? median;
  const threshold = median + Math.max((high - median) * 0.75, 0.025);
  const minGap = Math.max(6, Math.round(projection.length / Math.max(3, maxFrames + 1)) * 0.45);
  const peaks: number[] = [];
  for (let index = 1; index < values.length - 1; index += 1) {
    if (values[index] < threshold || values[index] < values[index - 1] || values[index] < values[index + 1]) continue;
    if (peaks.length && index - peaks[peaks.length - 1] < minGap) {
      if (values[index] > values[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = index;
      continue;
    }
    peaks.push(index);
  }
  if (peaks.length > maxFrames - 1) {
    peaks.sort((a, b) => values[b] - values[a]);
    peaks.length = maxFrames - 1;
    peaks.sort((a, b) => a - b);
  }
  return [0, ...peaks, projection.length - 1];
}

/** Traditional, explainable frame suggestions based on edge projections. */
export function detectFrameGrid(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels = 3,
  options: FrameDetectOptions = {},
): FrameDetection[] {
  if (width < 16 || height < 16 || channels < 3 || data.length < width * height * channels) return [];
  const kind = options.kind ?? 'unknown';
  const maxFrames = Math.max(1, Math.min(60, options.maxFrames ?? (kind === 'contact' ? 24 : 36)));
  const vertical = new Array(width).fill(0);
  const horizontal = new Array(height).fill(0);
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const current = gray(data, (y * width + x) * channels, channels);
      vertical[x] += Math.abs(current - gray(data, (y * width + x - 1) * channels, channels));
      horizontal[y] += Math.abs(current - gray(data, ((y - 1) * width + x) * channels, channels));
    }
  }
  const xCuts = boundaries(vertical, kind === 'strip' ? maxFrames : Math.min(maxFrames, 12));
  const yCuts = kind === 'strip' ? [0, height - 1] : boundaries(horizontal, Math.min(maxFrames, 8));
  const detections: FrameDetection[] = [];
  for (let row = 0; row < yCuts.length - 1; row += 1) {
    for (let column = 0; column < xCuts.length - 1; column += 1) {
      const x0 = xCuts[column] / (width - 1);
      const x1 = xCuts[column + 1] / (width - 1);
      const y0 = yCuts[row] / (height - 1);
      const y1 = yCuts[row + 1] / (height - 1);
      if (x1 - x0 < 0.06 || y1 - y0 < 0.06) continue;
      const insetX = Math.min(0.02, (x1 - x0) * 0.08);
      const insetY = Math.min(0.02, (y1 - y0) * 0.08);
      detections.push({
        corners: [
          { x: clamp(x0 + insetX), y: clamp(y0 + insetY) },
          { x: clamp(x1 - insetX), y: clamp(y0 + insetY) },
          { x: clamp(x1 - insetX), y: clamp(y1 - insetY) },
          { x: clamp(x0 + insetX), y: clamp(y1 - insetY) },
        ],
        score: 1,
      });
      if (detections.length >= maxFrames) return detections;
    }
  }
  return detections;
}
