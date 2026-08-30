/**
 * Multi-exposure fusion (Mertens-style) for film digitization HDR merge.
 *
 * Industry reference: the same family of algorithms used by SilverFast
 * Multi-Exposure and open-source enfuse. v1 keeps it dependency-free:
 * well-exposedness + local contrast + saturation weights, smoothed and
 * normalized, combined with a global translation alignment estimated by
 * normalized cross-correlation on a downscaled luminance image.
 */

export interface HdrSource {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Hdr16Source {
  width: number;
  height: number;
  channels: number;
  data: Uint16Array;
}

export interface HdrMergeOptions {
  /** Estimate and compensate a global translation per source (default true). */
  align?: boolean;
}

const LUMA = [0.2126, 0.7152, 0.0722];

function luminance(data: Uint8Array | Uint8ClampedArray, channels: number, target: Float32Array | null = null): Float32Array {
  const output = target ?? new Float32Array(data.length / channels);
  for (let index = 0, out = 0; index < data.length; index += channels, out += 1) {
    output[out] = (data[index] * LUMA[0] + data[index + 1] * LUMA[1] + data[index + 2] * LUMA[2]) / 255;
  }
  return output;
}

/** Downscale by exact factor 2 (box average), used for alignment estimation. */
function halve(src: Float32Array, width: number, height: number): { data: Float32Array; width: number; height: number } {
  const outWidth = Math.max(1, width >> 1);
  const outHeight = Math.max(1, height >> 1);
  const data = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const a = src[y * 2 * width + x * 2];
      const b = src[y * 2 * width + x * 2 + 1];
      const c = src[(y * 2 + 1) * width + x * 2];
      const d = src[(y * 2 + 1) * width + x * 2 + 1];
      data[y * outWidth + x] = (a + b + c + d) * 0.25;
    }
  }
  return { data, width: outWidth, height: outHeight };
}

/**
 * Normalized cross-correlation shift search on a small image.
 * Returns the shift (dx, dy) that best aligns `source` onto `reference`
 * (source[dy + y][dx + x] ≈ reference[y][x]).
 */
function estimateShift(reference: Float32Array, source: Float32Array, width: number, height: number, range: number): { dx: number; dy: number } {
  let best = -Infinity;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -range; dy <= range; dy += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      // Zero-mean NCC: accumulated sums make it robust against borders and
      // exposure offsets (a plain dot product is biased by filled edges).
      let sumA = 0;
      let sumB = 0;
      let sumAB = 0;
      let sumA2 = 0;
      let sumB2 = 0;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let x = 0; x < width; x += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const a = reference[y * width + x];
          const b = source[sy * width + sx];
          sumA += a;
          sumB += b;
          sumAB += a * b;
          sumA2 += a * a;
          sumB2 += b * b;
          count += 1;
        }
      }
      if (!count) continue;
      const varianceA = Math.max(0, sumA2 - (sumA * sumA) / count);
      const varianceB = Math.max(0, sumB2 - (sumB * sumB) / count);
      const covariance = sumAB - (sumA * sumB) / count;
      const score = covariance / Math.max(1e-9, Math.sqrt(varianceA * varianceB));
      if (score > best) {
        best = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  return { dx: bestDx, dy: bestDy };
}

function boxBlurHorizontal(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const output = new Float32Array(data.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    let count = 0;
    const row = y * width;
    for (let x = -radius; x <= radius; x += 1) {
      if (x >= 0 && x < width) { sum += data[row + x]; count += 1; }
    }
    for (let x = 0; x < width; x += 1) {
      output[row + x] = sum / Math.max(1, count);
      const leaving = x - radius;
      if (leaving >= 0 && leaving < width) { sum -= data[row + leaving]; count -= 1; }
      const entering = x + radius + 1;
      if (entering >= 0 && entering < width) { sum += data[row + entering]; count += 1; }
    }
  }
  return output;
}

function boxBlurVertical(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const output = new Float32Array(data.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y <= radius; y += 1) {
      if (y >= 0 && y < height) { sum += data[y * width + x]; count += 1; }
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / Math.max(1, count);
      const leaving = y - radius;
      if (leaving >= 0 && leaving < height) { sum -= data[leaving * width + x]; count -= 1; }
      const entering = y + radius + 1;
      if (entering >= 0 && entering < height) { sum += data[entering * width + x]; count += 1; }
    }
  }
  return output;
}

function smoothWeights(data: Float32Array, width: number, height: number, radius = 2): Float32Array {
  return boxBlurVertical(boxBlurHorizontal(data, width, height, radius), width, height, radius);
}

/**
 * Merges 2+ equally sized exposures into one 8-bit image. Sources must share
 * identical dimensions (the caller is responsible for resizing); when
 * `align` is enabled each source is translated to best match the first one
 * and the output is cropped to the common overlap.
 */
export function mergeExposures(sources: HdrSource[], options: HdrMergeOptions = {}): { width: number; height: number; data: Uint8ClampedArray } {
  if (sources.length < 2) throw new Error('HDR 合成至少需要两张不同曝光的图像');
  const { width, height } = sources[0];
  for (const source of sources) {
    if (source.width !== width || source.height !== height || (source.channels !== 3 && source.channels !== 4)) {
      throw new Error('HDR 合成要求所有素材尺寸一致（3/4 通道）');
    }
    if (source.data.length !== width * height * source.channels) throw new Error('HDR 素材像素尺寸不匹配');
  }
  const align = options.align ?? true;

  // 1. Global translation alignment (NCC on downscaled luminance).
  const shifts: Array<{ dx: number; dy: number }> = [{ dx: 0, dy: 0 }];
  if (align) {
    const lumaRef = luminance(sources[0].data, sources[0].channels);
    let ref = lumaRef;
    let refWidth = width;
    let refHeight = height;
    while (Math.max(refWidth, refHeight) > 160) {
      const next = halve(ref, refWidth, refHeight);
      ref = next.data;
      refWidth = next.width;
      refHeight = next.height;
    }
    for (let index = 1; index < sources.length; index += 1) {
      let small = luminance(sources[index].data, sources[index].channels);
      let smallWidth = width;
      let smallHeight = height;
      while (Math.max(smallWidth, smallHeight) > 160) {
        const next = halve(small, smallWidth, smallHeight);
        small = next.data;
        smallWidth = next.width;
        smallHeight = next.height;
      }
      const shift = estimateShift(ref, small, smallWidth, smallHeight, 20);
      shifts.push({ dx: Math.round(shift.dx * (width / smallWidth)), dy: Math.round(shift.dy * (height / smallHeight)) });
    }
  } else {
    for (let index = 1; index < sources.length; index += 1) shifts.push({ dx: 0, dy: 0 });
  }

  // Translated sampling: merged(y, x) = source(y + shift.dy, x + shift.dx)
  // inside bounds; out-of-bounds sources contribute zero weight. The
  // reference (first source, shift 0) always covers the full canvas, so
  // edges degrade gracefully instead of being cropped.
  const outWidth = width;
  const outHeight = height;

  // 2. Per-source quality weights (Mertens): well-exposedness × contrast × saturation.
  const weights: Float32Array[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const shift = shifts[index];
    const channels = source.channels;
    const weight = new Float32Array(outWidth * outHeight);
    for (let y = 0; y < outHeight; y += 1) {
      const sy = y + shift.dy;
      if (sy < 0 || sy >= height) continue;
      for (let x = 0; x < outWidth; x += 1) {
        const sx = x + shift.dx;
        if (sx < 0 || sx >= width) continue;
        const at = (sy * width + sx) * channels;
        const r = source.data[at] / 255;
        const g = source.data[at + 1] / 255;
        const b = source.data[at + 2] / 255;
        // Clipped pixels carry no information: force zero weight so the
        // smoothed weight map cannot leak a contrast spike from the clip
        // boundary into the flat plateau (which would let a blown-out source
        // dominate the blend with white).
        if (r * 255 <= 1 || g * 255 <= 1 || b * 255 <= 1 || r * 255 >= 254 || g * 255 >= 254 || b * 255 >= 254) {
          weight[y * outWidth + x] = 0;
          continue;
        }
        const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
        const mean = (r + g + b) / 3;
        const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);
        const exposure = Math.exp(-((luma - 0.5) ** 2) / (2 * 0.2 ** 2));
        let contrast = 0;
        if (sx > 0 && sx < width - 1 && sy > 0 && sy < height - 1) {
          // 4-neighbour Laplacian magnitude on luminance.
          const lap = 4 * luma
            - luminanceAt(source, width, sx - 1, sy, channels)
            - luminanceAt(source, width, sx + 1, sy, channels)
            - luminanceAt(source, width, sx, sy - 1, channels)
            - luminanceAt(source, width, sx, sy + 1, channels);
          contrast = Math.abs(lap);
        }
        weight[y * outWidth + x] = exposure * contrast * saturation + 1e-12;
      }
    }
    weights.push(smoothWeights(weight, outWidth, outHeight));
  }

  // 3. Normalize weights per pixel and blend.
  const output = new Uint8ClampedArray(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const pixel = y * outWidth + x;
      let total = 0;
      for (let index = 0; index < sources.length; index += 1) total += weights[index][pixel];
      if (total <= 1e-15) {
        // Every source is clipped (or out of bounds) here: fall back to the
        // reference exposure instead of emitting black.
        const refAt = (y * width + x) * sources[0].channels;
        const out = pixel * 3;
        output[out] = sources[0].data[refAt];
        output[out + 1] = sources[0].data[refAt + 1];
        output[out + 2] = sources[0].data[refAt + 2];
        continue;
      }
      let outR = 0;
      let outG = 0;
      let outB = 0;
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const shift = shifts[index];
        const channels = source.channels;
        const sy = y + shift.dy;
        const sx = x + shift.dx;
        if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
        const at = (sy * width + sx) * channels;
        const w = weights[index][pixel] / Math.max(1e-9, total);
        outR += source.data[at] * w;
        outG += source.data[at + 1] * w;
        outB += source.data[at + 2] * w;
      }
      const out = pixel * 3;
      output[out] = Math.round(outR);
      output[out + 1] = Math.round(outG);
      output[out + 2] = Math.round(outB);
    }
  }
  return { width: outWidth, height: outHeight, data: output };
}

function luminanceAt(source: HdrSource, width: number, x: number, y: number, channels: number): number {
  const at = (y * width + x) * channels;
  return (source.data[at] * LUMA[0] + source.data[at + 1] * LUMA[1] + source.data[at + 2] * LUMA[2]) / 255;
}

function luminance16(data: Uint16Array, channels: number, target: Float32Array | null = null): Float32Array {
  const output = target ?? new Float32Array(data.length / channels);
  for (let index = 0, out = 0; index < data.length; index += channels, out += 1) {
    output[out] = (data[index] * LUMA[0] + data[index + 1] * LUMA[1] + data[index + 2] * LUMA[2]) / 65535;
  }
  return output;
}

function luminanceAt16(source: Hdr16Source, width: number, x: number, y: number, channels: number): number {
  const at = (y * width + x) * channels;
  return (source.data[at] * LUMA[0] + source.data[at + 1] * LUMA[1] + source.data[at + 2] * LUMA[2]) / 65535;
}

/**
 * 16-bit counterpart to `mergeExposures`. The weighting and alignment are
 * identical, but all statistics remain normalized from Uint16 samples and
 * the result is kept as Uint16 instead of quantizing through an 8-bit proxy.
 */
export function mergeExposures16(sources: Hdr16Source[], options: HdrMergeOptions = {}): { width: number; height: number; data: Uint16Array } {
  if (sources.length < 2) throw new Error('HDR 合成至少需要两张不同曝光的图像');
  const { width, height } = sources[0];
  for (const source of sources) {
    if (source.width !== width || source.height !== height || (source.channels !== 3 && source.channels !== 4)) throw new Error('HDR 合成要求所有素材尺寸一致（3/4 通道）');
    if (source.data.length !== width * height * source.channels) throw new Error('HDR 素材像素尺寸不匹配');
  }
  const align = options.align ?? true;
  const shifts: Array<{ dx: number; dy: number }> = [{ dx: 0, dy: 0 }];
  let ref = luminance16(sources[0].data, sources[0].channels);
  let refWidth = width;
  let refHeight = height;
  while (align && Math.max(refWidth, refHeight) > 160) {
    const next = halve(ref, refWidth, refHeight);
    ref = next.data; refWidth = next.width; refHeight = next.height;
  }
  for (let index = 1; index < sources.length; index += 1) {
    if (!align) { shifts.push({ dx: 0, dy: 0 }); continue; }
    let small = luminance16(sources[index].data, sources[index].channels);
    let smallWidth = width;
    let smallHeight = height;
    while (Math.max(smallWidth, smallHeight) > 160) {
      const next = halve(small, smallWidth, smallHeight);
      small = next.data; smallWidth = next.width; smallHeight = next.height;
    }
    const shift = estimateShift(ref, small, smallWidth, smallHeight, 20);
    shifts.push({ dx: Math.round(shift.dx * (width / smallWidth)), dy: Math.round(shift.dy * (height / smallHeight)) });
  }

  const weights: Float32Array[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const shift = shifts[index];
    const weight = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const sy = y + shift.dy;
      if (sy < 0 || sy >= height) continue;
      for (let x = 0; x < width; x += 1) {
        const sx = x + shift.dx;
        if (sx < 0 || sx >= width) continue;
        const at = (sy * width + sx) * source.channels;
        const r = source.data[at] / 65535;
        const g = source.data[at + 1] / 65535;
        const b = source.data[at + 2] / 65535;
        // 16-bit data has meaningful highlight detail above 65280. Reusing the
        // 8-bit 254/255 threshold discarded that entire range; only the final
        // two sensor codes are treated as truly clipped here.
        if (r <= 1 / 65535 || g <= 1 / 65535 || b <= 1 / 65535
          || r >= 65534 / 65535 || g >= 65534 / 65535 || b >= 65534 / 65535) continue;
        const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
        const mean = (r + g + b) / 3;
        const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);
        const exposure = Math.exp(-((luma - 0.5) ** 2) / (2 * 0.2 ** 2));
        let contrast = 0;
        if (sx > 0 && sx < width - 1 && sy > 0 && sy < height - 1) {
          const lap = 4 * luma
            - luminanceAt16(source, width, sx - 1, sy, source.channels)
            - luminanceAt16(source, width, sx + 1, sy, source.channels)
            - luminanceAt16(source, width, sx, sy - 1, source.channels)
            - luminanceAt16(source, width, sx, sy + 1, source.channels);
          contrast = Math.abs(lap);
        }
        weight[y * width + x] = exposure * contrast * saturation + 1e-12;
      }
    }
    weights.push(smoothWeights(weight, width, height));
  }

  const output = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      let total = 0;
      for (const weight of weights) total += weight[pixel];
      const out = pixel * 3;
      if (total <= 1e-15) {
        const refAt = out / 3 * sources[0].channels;
        output[out] = sources[0].data[refAt];
        output[out + 1] = sources[0].data[refAt + 1];
        output[out + 2] = sources[0].data[refAt + 2];
        continue;
      }
      let outR = 0; let outG = 0; let outB = 0;
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const shift = shifts[index];
        const sy = y + shift.dy; const sx = x + shift.dx;
        if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
        const at = (sy * width + sx) * source.channels;
        const w = weights[index][pixel] / Math.max(1e-9, total);
        outR += source.data[at] * w; outG += source.data[at + 1] * w; outB += source.data[at + 2] * w;
      }
      output[out] = Math.max(0, Math.min(65535, Math.round(outR)));
      output[out + 1] = Math.max(0, Math.min(65535, Math.round(outG)));
      output[out + 2] = Math.max(0, Math.min(65535, Math.round(outB)));
    }
  }
  return { width, height, data: output };
}
