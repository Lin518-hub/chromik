import { clamp } from './image';

/**
 * Dust removal — "detect (mask) then repair" separation.
 *
 * The pipeline is split into two independent halves so the detector can
 * evolve without touching the repairer:
 *
 *   1. Detection produces a per-pixel mask (1 = dust pixel to repair):
 *      - `buildSpotMask` rasterizes the classical per-spot description
 *        (normalized center + radius) that the editor exposes today;
 *      - a future AI detector (small ONNX U-Net) can simply replace the
 *        `buildSpotMask` call site and hand the SAME `DustInpainter`
 *        interface an arbitrary-shape mask (dust strands, hairs, sensor
 *        streaks, ...). Nothing on the repair side changes — that is the
 *        design goal of the interface.
 *
 *   2. Repair (`DustInpainter.heal`) consumes only the mask — it never sees
 *      spots or detector internals.
 *
 * All implementations are deterministic, dependency-free JavaScript.
 */

export interface DustInpainter {
  /**
   * Repair `output` in place: every pixel where `mask[i] !== 0` is filled by
   * sample-based texture synthesis. `mask` has length `width * height`;
   * 1 = to repair, 0 = known source. Pixels outside the mask are never
   * modified (bit-identical). With 4 channels the alpha channel is preserved
   * as-is (only RGB is repaired), but alpha still participates in block
   * matching so texture is borrowed from regions with similar alpha.
   */
  heal(output: Float32Array, width: number, height: number, channels: number, mask: Uint8Array): void;
}

/**
 * Rasterize normalized dust spots into a per-pixel repair mask: each spot
 * becomes a disk of radius `r * min(width, height)` around
 * `(clamp(x) * (width - 1), clamp(y) * (height - 1))`, clipped to the image
 * bounds. Empty or missing spot lists yield an all-zero mask.
 */
export function buildSpotMask(
  width: number,
  height: number,
  spots: ReadonlyArray<{ x: number; y: number; r: number }>,
): Uint8Array {
  if (width <= 0 || height <= 0) return new Uint8Array(0);
  const mask = new Uint8Array(width * height);
  if (!spots || spots.length === 0) return mask;
  for (const spot of spots) {
    const cx = Math.round(clamp(spot.x) * (width - 1));
    const cy = Math.round(clamp(spot.y) * (height - 1));
    // BUG-026：半径按 r×min(width,height) 无额外上限时，合法的大标记
    // （r 允许到 0.5）单点即数百万次 Math.hypot 迭代，交互预览直接卡顿。
    // 256px 的绝对上限对除尘足够，且把每点成本封顶在 ~26 万次迭代内。
    const radius = Math.min(Math.max(1, spot.r * Math.min(width, height)), 256);
    const rCeil = Math.ceil(radius);
    for (let dy = -rCeil; dy <= rCeil; dy += 1) {
      for (let dx = -rCeil; dx <= rCeil; dx += 1) {
        if (Math.hypot(dx, dy) > radius) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        mask[py * width + px] = 1;
      }
    }
  }
  return mask;
}

/** Number of channels the repair actually writes (alpha at index 3 is kept). */
function repairedChannelCount(channels: number): number {
  return channels >= 4 ? 3 : channels;
}

const BLOCK_HALF = 2; // 5×5 neighbourhood around a pixel
const BLOCK_AREA = (2 * BLOCK_HALF + 1) * (2 * BLOCK_HALF + 1);
const TOP_CANDIDATES = 16; // full-MSE refinement pool after block-mean pruning
const MIN_SEARCH_RADIUS = 8;

/**
 * Copy the channels of the closest known pixel (expanding-square scan,
 * deterministic) onto pixel `p`. Safe fallback for tiny images and for
 * masks that cover nearly the whole frame.
 */
function copyNearestKnownPixel(
  output: Float32Array,
  width: number,
  height: number,
  channels: number,
  known: Uint8Array,
  p: number,
): boolean {
  const px = p % width;
  const py = (p / width) | 0;
  const copyChannels = repairedChannelCount(channels);
  const maxDim = Math.max(width, height);
  for (let d = 1; d <= maxDim; d += 1) {
    const y0 = Math.max(0, py - d);
    const y1 = Math.min(height - 1, py + d);
    const x0 = Math.max(0, px - d);
    const x1 = Math.min(width - 1, px + d);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (Math.max(Math.abs(x - px), Math.abs(y - py)) !== d) continue;
        const n = y * width + x;
        if (known[n] !== 0) {
          const src = n * channels;
          const dst = p * channels;
          for (let c = 0; c < copyChannels; c += 1) output[dst + c] = output[src + c];
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * PatchMatch-style sample-based inpainter (simple, deterministic, pure JS).
 *
 * Repair strategy ("onion peel" BFS, from the mask boundary inward):
 *  - the boundary of the mask (pixels adjacent to known pixels) is repaired
 *    first; those pixels then count as known, expanding the boundary until
 *    the mask is empty;
 *  - each pixel searches the known region inside a square of radius
 *    `max(8, min(width, height) / 8)` around it. Candidate 5×5 blocks must
 *    lie fully inside the image and contain no masked pixel. The best block
 *    is chosen by mean-square error across all channels, and its centre pixel
 *    value is copied onto the repaired pixel;
 *  - performance: per-channel integral images give O(1) block means, so the
 *    candidates are first pruned by block-mean distance (keep top-K), then
 *    refined by full 5×5 MSE. On large images the search square is sampled
 *    every `step` pixels to bound the work;
 *  - sources are restricted to blocks that were known in the ORIGINAL mask
 *    (never healed), which keeps the integral images valid for the whole run
 *    and avoids error propagation;
 *  - termination is guaranteed: each masked pixel is healed at most once
 *    (queue guard), so the loop is bounded by the mask pixel count — plus an
 *    explicit iteration cap as defense in depth against pathological inputs.
 */
export function createPatchMatchInpainter(): DustInpainter {
  return {
    heal(output, width, height, channels, mask) {
      const pixelCount = width * height;
      if (pixelCount === 0 || channels < 1 || mask.length !== pixelCount) return;
      let maskedCount = 0;
      for (let i = 0; i < pixelCount; i += 1) if (mask[i] !== 0) maskedCount += 1;
      if (maskedCount === 0) return;

      const known = new Uint8Array(pixelCount);
      for (let i = 0; i < pixelCount; i += 1) known[i] = mask[i] === 0 ? 1 : 0;

      // Tiny images cannot host a 5×5 block: fall back to nearest-known copy.
      if (width < 2 * BLOCK_HALF + 1 || height < 2 * BLOCK_HALF + 1) {
        for (let i = 0; i < pixelCount; i += 1) {
          if (mask[i] !== 0) copyNearestKnownPixel(output, width, height, channels, known, i);
        }
        return;
      }

      const stride = width + 1;

      // Prefix sums of the mask → O(1) "does this 5×5 block contain a masked
      // pixel?" test (row-sum accumulation keeps this to one pass).
      const maskPrefix = new Uint32Array((width + 1) * (height + 1));
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        const pRow = (y + 1) * stride;
        const pPrev = y * stride;
        let rowCount = 0;
        for (let x = 0; x < width; x += 1) {
          rowCount += mask[row + x] !== 0 ? 1 : 0;
          maskPrefix[pRow + x + 1] = maskPrefix[pPrev + x + 1] + rowCount;
        }
      }
      const blockOk = new Uint8Array(pixelCount);
      for (let y = BLOCK_HALF; y < height - BLOCK_HALF; y += 1) {
        for (let x = BLOCK_HALF; x < width - BLOCK_HALF; x += 1) {
          const x0 = x - BLOCK_HALF;
          const x1 = x + BLOCK_HALF + 1;
          const y0 = y - BLOCK_HALF;
          const y1 = y + BLOCK_HALF + 1;
          const count = maskPrefix[y1 * stride + x1] - maskPrefix[y0 * stride + x1]
            - maskPrefix[y1 * stride + x0] + maskPrefix[y0 * stride + x0];
          if (count === 0) blockOk[y * width + x] = 1;
        }
      }

      // Per-channel integral images over the ORIGINAL values. They stay valid
      // because candidate blocks are restricted to `blockOk` centres, whose
      // contents never change during the whole heal.
      const sums: Float32Array[] = [];
      for (let c = 0; c < channels; c += 1) {
        const s = new Float32Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y += 1) {
          const pRow = (y + 1) * stride;
          const pPrev = y * stride;
          const rowBase = y * width * channels + c;
          let rowSum = 0;
          for (let x = 0; x < width; x += 1) {
            rowSum += output[rowBase + x * channels];
            s[pRow + x + 1] = s[pPrev + x + 1] + rowSum;
          }
        }
        sums.push(s);
      }

      const searchRadius = Math.max(MIN_SEARCH_RADIUS, Math.floor(Math.min(width, height) / 8));
      // Bound the number of evaluated centres on large images: sample every
      // `step`-th centre inside the search square (step 1 for small images).
      const step = searchRadius <= MIN_SEARCH_RADIUS + 4 ? 1 : Math.max(2, Math.round(searchRadius / 12));

      const copyChannels = repairedChannelCount(channels);

      // BFS queue of masked pixels ordered from the boundary inward.
      const healed = new Uint8Array(pixelCount);
      const queued = new Uint8Array(pixelCount);
      const queue = new Int32Array(maskedCount);
      let head = 0;
      let tail = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = y * width + x;
          if (mask[i] === 0) continue;
          let boundary = false;
          for (let dy = -1; dy <= 1 && !boundary; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              if (known[ny * width + nx] !== 0) {
                boundary = true;
                break;
              }
            }
          }
          if (boundary) {
            queue[tail] = i;
            tail += 1;
            queued[i] = 1;
          }
        }
      }

      // Reusable scratch buffers for the per-pixel search.
      const windowPixels = new Int32Array(BLOCK_AREA);
      const targetMean = new Float64Array(channels);
      const bestCosts = new Float64Array(TOP_CANDIDATES);
      const bestCentres = new Int32Array(TOP_CANDIDATES);

      // Safety cap: each masked pixel is healed at most once (the `queued`
      // guard bounds `tail` by maskedCount); the counter is defense in depth.
      let iterations = 0;
      while (head < tail && iterations <= maskedCount) {
        const p = queue[head];
        head += 1;
        iterations += 1;
        if (healed[p] !== 0) continue;
        const px = p % width;
        const py = (p / width) | 0;

        // Known pixels (original or already healed) inside the 5×5 window
        // around p define the target texture signature.
        let windowCount = 0;
        for (let dy = -BLOCK_HALF; dy <= BLOCK_HALF; dy += 1) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -BLOCK_HALF; dx <= BLOCK_HALF; dx += 1) {
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const pos = ny * width + nx;
            if (mask[pos] === 0 || healed[pos] !== 0) {
              windowPixels[windowCount] = pos;
              windowCount += 1;
            }
          }
        }

        healed[p] = 1;

        if (windowCount === 0) {
          // No context at all (mask covers the whole neighbourhood): fall
          // back to the nearest known pixel instead of inventing data.
          copyNearestKnownPixel(output, width, height, channels, known, p);
        } else {
          targetMean.fill(0);
          for (let k = 0; k < windowCount; k += 1) {
            const base = windowPixels[k] * channels;
            for (let c = 0; c < channels; c += 1) targetMean[c] += output[base + c];
          }
          for (let c = 0; c < channels; c += 1) targetMean[c] /= windowCount;

          // Phase 1 — block-mean pruning: keep the TOP_CANDIDATES centres
          // whose O(1) integral-image block mean is closest to the target.
          bestCosts.fill(Infinity);
          bestCentres.fill(-1);
          let filled = 0;
          const cyMin = Math.max(BLOCK_HALF, py - searchRadius);
          const cyMax = Math.min(height - 1 - BLOCK_HALF, py + searchRadius);
          const cxMin = Math.max(BLOCK_HALF, px - searchRadius);
          const cxMax = Math.min(width - 1 - BLOCK_HALF, px + searchRadius);
          for (let cy = cyMin; cy <= cyMax; cy += step) {
            for (let cx = cxMin; cx <= cxMax; cx += step) {
              const centre = cy * width + cx;
              if (blockOk[centre] === 0) continue;
              const x0 = cx - BLOCK_HALF;
              const x1 = cx + BLOCK_HALF + 1;
              const y0 = cy - BLOCK_HALF;
              const y1 = cy + BLOCK_HALF + 1;
              let cost = 0;
              for (let c = 0; c < channels; c += 1) {
                const s = sums[c];
                const mean = (s[y1 * stride + x1] - s[y0 * stride + x1]
                  - s[y1 * stride + x0] + s[y0 * stride + x0]) / BLOCK_AREA;
                cost += Math.abs(mean - targetMean[c]);
              }
              if (filled < TOP_CANDIDATES || cost < bestCosts[TOP_CANDIDATES - 1]) {
                let insertAt = filled;
                while (insertAt > 0 && cost < bestCosts[insertAt - 1]) {
                  bestCosts[insertAt] = bestCosts[insertAt - 1];
                  bestCentres[insertAt] = bestCentres[insertAt - 1];
                  insertAt -= 1;
                }
                bestCosts[insertAt] = cost;
                bestCentres[insertAt] = centre;
                if (filled < TOP_CANDIDATES) filled += 1;
              }
            }
          }

          // Phase 2 — full 5×5 MSE across all channels on the top-K pool.
          let bestMse = Infinity;
          let bestCentre = -1;
          for (let k = 0; k < filled; k += 1) {
            const centre = bestCentres[k];
            const centreX = centre % width;
            const centreY = Math.floor(centre / width);
            let mse = 0;
            for (let w = 0; w < windowCount; w += 1) {
              const destination = windowPixels[w];
              const destinationX = destination % width;
              const destinationY = Math.floor(destination / width);
              const sourceX = centreX + destinationX - px;
              const sourceY = centreY + destinationY - py;
              const srcBase = (sourceY * width + sourceX) * channels;
              const dstBase = destination * channels;
              for (let c = 0; c < channels; c += 1) {
                const d = output[dstBase + c] - output[srcBase + c];
                mse += d * d;
              }
            }
            if (mse < bestMse) {
              bestMse = mse;
              bestCentre = centre;
            }
          }

          if (bestCentre >= 0) {
            const srcBase = bestCentre * channels;
            const dstBase = p * channels;
            for (let c = 0; c < copyChannels; c += 1) output[dstBase + c] = output[srcBase + c];
          } else {
            copyNearestKnownPixel(output, width, height, channels, known, p);
          }
        }

        // The pixel is now known: its masked neighbours become boundary.
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const n = ny * width + nx;
            if (mask[n] !== 0 && healed[n] === 0 && queued[n] === 0) {
              queue[tail] = n;
              tail += 1;
              queued[n] = 1;
            }
          }
        }
      }
    },
  };
}
