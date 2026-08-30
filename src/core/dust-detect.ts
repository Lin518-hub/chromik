import { clamp } from './image';

/** A conservative, dependency-free dust suggestion produced from a preview. */
export interface DustCandidate {
  x: number;
  y: number;
  r: number;
  score: number;
  kind: 'dark' | 'bright';
}

export interface DustDetectOptions {
  /** Maximum number of suggestions returned (default 80). */
  maxSpots?: number;
  /** Luma residual, normalized to 0…1, required to call a point dust. */
  threshold?: number;
  /** Minimum distance between suggestions in source pixels (default 8). */
  minDistance?: number;
  /** Radius bounds in normalized image units. */
  minRadius?: number;
  maxRadius?: number;
}

function luma(data: ArrayLike<number>, at: number, channels: number, scale: number): number {
  return ((data[at] ?? 0) * 0.2126 + (data[at + 1] ?? 0) * 0.7152 + (data[at + 2] ?? 0) * 0.0722) / scale;
}

/**
 * Detect small isolated dark/bright dust spots in an RGB preview.
 *
 * This intentionally proposes edits instead of changing pixels. It compares
 * each pixel to a four-neighbour cross and an eight-pixel ring, rejects strong
 * edges/textured regions, then applies deterministic non-maximum suppression.
 * The result is suitable for merging into the editor's normalized DustSpot
 * list and can later be replaced by a learned detector without changing the
 * repair pipeline.
 */
export function detectDustSpots(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels = 3,
  maxValue = 255,
  options: DustDetectOptions = {},
): DustCandidate[] {
  if (width < 7 || height < 7 || channels < 3 || data.length < width * height * channels) return [];
  const scale = Math.max(1, maxValue);
  const threshold = Math.max(0.02, options.threshold ?? 0.12);
  const maxSpots = Math.max(1, Math.min(400, Math.floor(options.maxSpots ?? 80)));
  const minDistance = Math.max(2, Math.floor(options.minDistance ?? Math.max(5, Math.min(width, height) / 180)));
  const minRadius = Math.max(0.0005, options.minRadius ?? 2 / Math.min(width, height));
  const maxRadius = Math.max(minRadius, options.maxRadius ?? 12 / Math.min(width, height));
  const candidates: DustCandidate[] = [];

  for (let y = 3; y < height - 3; y += 1) {
    for (let x = 3; x < width - 3; x += 1) {
      const center = luma(data, (y * width + x) * channels, channels, scale);
      const left = luma(data, (y * width + x - 1) * channels, channels, scale);
      const right = luma(data, (y * width + x + 1) * channels, channels, scale);
      const up = luma(data, ((y - 1) * width + x) * channels, channels, scale);
      const down = luma(data, ((y + 1) * width + x) * channels, channels, scale);
      const crossMean = (left + right + up + down) * 0.25;
      const ring: number[] = [];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (Math.abs(dx) + Math.abs(dy) < 3) continue;
          ring.push(luma(data, ((y + dy) * width + x + dx) * channels, channels, scale));
        }
      }
      const ringMean = ring.reduce((sum, value) => sum + value, 0) / ring.length;
      const ringVariance = ring.reduce((sum, value) => sum + (value - ringMean) ** 2, 0) / ring.length;
      const localTexture = Math.sqrt(ringVariance);
      const residual = Math.abs(center - (crossMean * 0.65 + ringMean * 0.35));
      const edgePenalty = Math.abs(left - right) + Math.abs(up - down);
      // Dust is isolated: opposing neighbours should agree, while an edge
      // has a large opposing difference. Textured surrounds are also ignored.
      if (residual < threshold || edgePenalty > residual * 1.9 || localTexture > 0.16) continue;
      const score = residual * (1 - Math.min(1, edgePenalty / Math.max(residual * 2, 1e-6)))
        * (1 - Math.min(0.8, localTexture * 2));
      if (score <= 0) continue;
      const radius = clamp(Math.max(minRadius, Math.min(maxRadius, (1.8 + residual * 5) / Math.min(width, height))), minRadius, maxRadius);
      candidates.push({
        x: x / Math.max(1, width - 1),
        y: y / Math.max(1, height - 1),
        r: radius,
        score,
        kind: center < crossMean ? 'dark' : 'bright',
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const accepted: DustCandidate[] = [];
  const minDistanceSquared = minDistance * minDistance;
  for (const candidate of candidates) {
    const px = candidate.x * (width - 1);
    const py = candidate.y * (height - 1);
    let tooClose = false;
    for (const chosen of accepted) {
      const dx = px - chosen.x * (width - 1);
      const dy = py - chosen.y * (height - 1);
      if (dx * dx + dy * dy < minDistanceSquared) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    accepted.push(candidate);
    if (accepted.length >= maxSpots) break;
  }
  return accepted;
}
