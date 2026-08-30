import type { CropRect, EditRecipe, Point, Quad } from '../shared/types';
import { clamp } from './image';

export type PixelArray = Uint8Array | Uint8ClampedArray | Uint16Array;

/** Map crop-handle coordinates into the oriented full-source preview. */
export function orientNormalizedPoint(point: Point, geometry: EditRecipe['geometry']): Point {
  const flippedX = geometry.flipX ? 1 - point.x : point.x;
  const flippedY = geometry.flipY ? 1 - point.y : point.y;
  if (geometry.rotation90 === 1) return { x: 1 - flippedY, y: flippedX };
  if (geometry.rotation90 === 2) return { x: 1 - flippedX, y: 1 - flippedY };
  if (geometry.rotation90 === 3) return { x: flippedY, y: 1 - flippedX };
  return { x: flippedX, y: flippedY };
}

/** Inverse of orientNormalizedPoint, used when dragging an oriented handle. */
export function unorientNormalizedPoint(point: Point, geometry: EditRecipe['geometry']): Point {
  let flippedX = point.x;
  let flippedY = point.y;
  if (geometry.rotation90 === 1) { flippedX = point.y; flippedY = 1 - point.x; }
  else if (geometry.rotation90 === 2) { flippedX = 1 - point.x; flippedY = 1 - point.y; }
  else if (geometry.rotation90 === 3) { flippedX = 1 - point.y; flippedY = point.x; }
  return {
    x: geometry.flipX ? 1 - flippedX : flippedX,
    y: geometry.flipY ? 1 - flippedY : flippedY,
  };
}

export function quadToCrop(corners: Quad): CropRect {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = clamp(Math.min(...xs));
  const y = clamp(Math.min(...ys));
  const right = clamp(Math.max(...xs));
  const bottom = clamp(Math.max(...ys));
  return { x, y, width: Math.max(0.02, right - x), height: Math.max(0.02, bottom - y) };
}

/** BUG-020：四角有效性防御——损坏配方在迁移层之外的最后一道闸。 */
export function isValidQuad(corners: unknown): corners is Quad {
  if (!Array.isArray(corners) || corners.length !== 4) return false;
  return corners.every((point) => Boolean(point) && typeof point === 'object'
    && Number.isFinite((point as Point).x) && Number.isFinite((point as Point).y));
}

const IDENTITY_QUAD: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

export function mapUnitSquareToQuad(u: number, v: number, corners: Quad): Point {
  const [tl, tr, br, bl] = corners;
  const dx1 = tr.x - br.x;
  const dx2 = bl.x - br.x;
  const dx3 = tl.x - tr.x + br.x - bl.x;
  const dy1 = tr.y - br.y;
  const dy2 = bl.y - br.y;
  const dy3 = tl.y - tr.y + br.y - bl.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(determinant) > 1e-9) {
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const a = tr.x - tl.x + g * tr.x;
  const b = bl.x - tl.x + h * bl.x;
  const d = tr.y - tl.y + g * tr.y;
  const e = bl.y - tl.y + h * bl.y;
  const denominator = g * u + h * v + 1;
  // BUG-029：极端/自相交角点会让分母趋于 0，产生 ±Infinity/NaN 坐标，
  // 而 clamp 不拦截 NaN（Math.min/Math.max 对 NaN 返回 NaN），随后
  // Math.floor(NaN) 越界取像素。退化时退回双线性分子并夹紧。
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return { x: clamp(a * u + b * v + tl.x), y: clamp(d * u + e * v + tl.y) };
  }
  return {
    x: clamp((a * u + b * v + tl.x) / denominator),
    y: clamp((d * u + e * v + tl.y) / denominator),
  };
}

function distance(a: Point, b: Point, width: number, height: number): number {
  return Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
}

function createLike(input: PixelArray, length: number): PixelArray {
  return input instanceof Uint16Array ? new Uint16Array(length) : new Uint8ClampedArray(length);
}

export function warpPerspectivePixels(
  input: PixelArray,
  width: number,
  height: number,
  channels: number,
  corners: Quad,
): { data: PixelArray; width: number; height: number; channels: number } {
  // BUG-020：损坏的四角（旧库数据可能绕过 zod 校验）会让整个渲染/导出
  // 崩溃；此处回退到全幅恒等，把问题限制在迁移层日志而不是炸掉任务。
  if (!isValidQuad(corners)) corners = IDENTITY_QUAD;
  const axisAligned = Math.abs(corners[0].y - corners[1].y) < 1e-7
    && Math.abs(corners[3].y - corners[2].y) < 1e-7
    && Math.abs(corners[0].x - corners[3].x) < 1e-7
    && Math.abs(corners[1].x - corners[2].x) < 1e-7;
  if (axisAligned) {
    const left = Math.max(0, Math.floor(corners[0].x * width));
    const top = Math.max(0, Math.floor(corners[0].y * height));
    const right = Math.min(width, Math.ceil(corners[2].x * width));
    const bottom = Math.min(height, Math.ceil(corners[2].y * height));
    const outWidth = Math.max(2, right - left);
    const outHeight = Math.max(2, bottom - top);
    const output = createLike(input, outWidth * outHeight * channels);
    for (let y = 0; y < outHeight; y += 1) {
      const sourceStart = ((top + y) * width + left) * channels;
      output.set(input.subarray(sourceStart, sourceStart + outWidth * channels), y * outWidth * channels);
    }
    return { data: output, width: outWidth, height: outHeight, channels };
  }
  const topWidth = distance(corners[0], corners[1], width, height);
  const bottomWidth = distance(corners[3], corners[2], width, height);
  const leftHeight = distance(corners[0], corners[3], width, height);
  const rightHeight = distance(corners[1], corners[2], width, height);
  const outWidth = Math.max(2, Math.min(width * 2, Math.round((topWidth + bottomWidth) / 2)));
  const outHeight = Math.max(2, Math.min(height * 2, Math.round((leftHeight + rightHeight) / 2)));
  const output = createLike(input, outWidth * outHeight * channels);

  for (let y = 0; y < outHeight; y += 1) {
    const v = outHeight === 1 ? 0 : y / (outHeight - 1);
    for (let x = 0; x < outWidth; x += 1) {
      const u = outWidth === 1 ? 0 : x / (outWidth - 1);
      const point = mapUnitSquareToQuad(u, v, corners);
      const sx = point.x * (width - 1);
      const sy = point.y * (height - 1);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const tx = sx - x0;
      const ty = sy - y0;
      const target = (y * outWidth + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        const p00 = input[(y0 * width + x0) * channels + channel] ?? 0;
        const p10 = input[(y0 * width + x1) * channels + channel] ?? 0;
        const p01 = input[(y1 * width + x0) * channels + channel] ?? 0;
        const p11 = input[(y1 * width + x1) * channels + channel] ?? 0;
        const top = p00 + (p10 - p00) * tx;
        const bottom = p01 + (p11 - p01) * tx;
        output[target + channel] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { data: output, width: outWidth, height: outHeight, channels };
}

export function orientPixels(
  input: PixelArray,
  width: number,
  height: number,
  channels: number,
  geometry: EditRecipe['geometry'],
): { data: PixelArray; width: number; height: number; channels: number } {
  const rotation = geometry.rotation90;
  const outWidth = rotation % 2 === 0 ? width : height;
  const outHeight = rotation % 2 === 0 ? height : width;
  const output = createLike(input, input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fx = geometry.flipX ? width - 1 - x : x;
      const fy = geometry.flipY ? height - 1 - y : y;
      let dx = fx;
      let dy = fy;
      if (rotation === 1) { dx = height - 1 - fy; dy = fx; }
      else if (rotation === 2) { dx = width - 1 - fx; dy = height - 1 - fy; }
      else if (rotation === 3) { dx = fy; dy = width - 1 - fx; }
      const source = (y * width + x) * channels;
      const target = (dy * outWidth + dx) * channels;
      for (let channel = 0; channel < channels; channel += 1) output[target + channel] = input[source + channel] ?? 0;
    }
  }
  return { data: output, width: outWidth, height: outHeight, channels };
}

export function correctLensAndStraightenPixels(
  input: PixelArray,
  width: number,
  height: number,
  channels: number,
  geometry: Pick<EditRecipe['geometry'], 'straighten' | 'lensDistortion'>,
): { data: PixelArray; width: number; height: number; channels: number } {
  const angle = geometry.straighten * Math.PI / 180;
  const distortion = geometry.lensDistortion / 100;
  if (Math.abs(angle) < 1e-7 && Math.abs(distortion) < 1e-7) return { data: input, width, height, channels };
  const output = createLike(input, input.length);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const aspect = width / Math.max(1, height);
  const absoluteCosine = Math.abs(cosine);
  const absoluteSine = Math.abs(sine);
  const fillScale = Math.min(
    aspect / Math.max(1e-6, aspect * absoluteCosine + absoluteSine),
    1 / Math.max(1e-6, aspect * absoluteSine + absoluteCosine),
  );
  for (let y = 0; y < height; y += 1) {
    const normalizedY = (y / Math.max(1, height - 1) - 0.5) * 2;
    for (let x = 0; x < width; x += 1) {
      const normalizedX = (x / Math.max(1, width - 1) - 0.5) * 2 * aspect;
      const rotatedX = (normalizedX * cosine - normalizedY * sine) * fillScale;
      const rotatedY = (normalizedX * sine + normalizedY * cosine) * fillScale;
      const radiusSquared = rotatedX * rotatedX + rotatedY * rotatedY;
      const radial = 1 + distortion * radiusSquared * 0.35;
      const sourceX = ((rotatedX * radial / aspect) * 0.5 + 0.5) * (width - 1);
      const sourceY = ((rotatedY * radial) * 0.5 + 0.5) * (height - 1);
      if (sourceX < 0 || sourceY < 0 || sourceX > width - 1 || sourceY > height - 1) continue;
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fractionX = sourceX - x0;
      const fractionY = sourceY - y0;
      const target = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        const top = (input[(y0 * width + x0) * channels + channel] ?? 0) * (1 - fractionX)
          + (input[(y0 * width + x1) * channels + channel] ?? 0) * fractionX;
        const bottom = (input[(y1 * width + x0) * channels + channel] ?? 0) * (1 - fractionX)
          + (input[(y1 * width + x1) * channels + channel] ?? 0) * fractionX;
        output[target + channel] = Math.round(top * (1 - fractionY) + bottom * fractionY);
      }
    }
  }
  return { data: output, width, height, channels };
}

export function applyGeometry(
  input: PixelArray,
  width: number,
  height: number,
  channels: number,
  geometry: EditRecipe['geometry'],
): { data: PixelArray; width: number; height: number; channels: number } {
  const warped = warpPerspectivePixels(input, width, height, channels, geometry.corners);
  const corrected = correctLensAndStraightenPixels(warped.data, warped.width, warped.height, channels, geometry);
  return orientPixels(corrected.data, corrected.width, corrected.height, channels, geometry);
}
