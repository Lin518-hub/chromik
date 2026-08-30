import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';
import { estimateDensityAnchors, estimateFilmBaseRobust } from './density';

/**
 * COLOR-01 骨架：自动反相视觉回归（固定输入 → 固定输出）。
 *
 * 每次 `npm test` 都会用确定性种子合成一张"负片"，走完整自动转换链路
 * （稳健片基 → 密度锚点 → processRgb8），然后断言：
 *   1) 输出无 NaN、值域合法（不发白：均值不高；不黑：均值不低）；
 *   2) 中性场景不严重偏色（R/G/B 均值差有界）；
 *   3) 与 golden 特征文件（src/core/golden/chromik-visual-regression.json）
 *      对比，防止算法改动导致旧样片再次发白/偏色。
 *
 * 更新 golden：GOLDEN_UPDATE=1 npm test src/core/visual-regression.test.ts
 * 真实样片回归库（文档 QA-01）就绪后，把本测试的合成输入换成固定样片即可。
 */

const GOLDEN_DIR = join(process.cwd(), 'src', 'core', 'golden');
const GOLDEN_PATH = join(GOLDEN_DIR, 'chromik-visual-regression.json');
const GOLDEN_TOLERANCE = 0.02;

/** Deterministic synthetic negative: orange base + scene + fixed-seed grain. */
function buildSyntheticNegative(width = 640, height = 480): { data: Uint8ClampedArray; width: number; height: number } {
  const base = [238, 166, 108];
  const data = new Uint8ClampedArray(width * height * 3);
  let seed = 13579;
  const random = () => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const scene = (x: number, y: number): [number, number, number] => {
    // 中性灰卡补丁：反转后应接近中性（用于偏色断言）
    if (x > 0.30 && x < 0.52 && y > 0.32 && y < 0.52) return [0.5, 0.5, 0.5];
    // 天空/山体/树木/大地 —— 通道范围近似匹配的典型自然场景：
    // 只有轻微的冷暖倾向（真实照片的高光/阴影在各通道几乎同步到达
    // 黑白端，逐通道自动锚点才保持灰卡中性）。
    if (y < 0.5) return [0.34 + y * 0.12, 0.4 + y * 0.12, 0.46 + y * 0.12];
    if (y < 0.7) return [0.2, 0.27, 0.22];
    return [0.28, 0.24, 0.19];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / width;
      const ny = y / height;
      const isBorder = nx < 0.05 || nx > 0.95 || ny < 0.06 || ny > 0.94;
      const [sr, sg, sb] = scene((nx - 0.05) / 0.9, (ny - 0.06) / 0.88);
      const index = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const sceneValue = channel === 0 ? sr : channel === 1 ? sg : sb;
        data[index + channel] = isBorder
          ? Math.max(0, Math.min(255, Math.round(base[channel] + (random() - 0.5) * 4)))
          : Math.max(1, Math.min(255, Math.round(base[channel] * 10 ** -(0.08 + sceneValue * 1.2) + (random() - 0.5) * 5)));
      }
    }
  }
  return { data, width, height };
}

function analyze(output: Uint8ClampedArray): {
  mean: number[];
  overall: number;
  clippedHigh: number;
  clippedLow: number;
} {
  const sums = [0, 0, 0];
  let overall = 0;
  let clippedHigh = 0;
  let clippedLow = 0;
  const totalChannels = output.length;
  for (let index = 0; index < output.length; index += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = output[index + channel];
      sums[channel] += value;
      overall += value;
      if (value >= 254) clippedHigh += 1;
      if (value <= 1) clippedLow += 1;
    }
  }
  const pixels = output.length / 3;
  return {
    mean: sums.map((sum) => sum / pixels / 255),
    overall: overall / totalChannels / 255,
    clippedHigh: clippedHigh / totalChannels,
    clippedLow: clippedLow / totalChannels,
  };
}

function runAutomaticConversion(): { data: Uint8ClampedArray; stats: ReturnType<typeof analyze> } {
  const { data, width, height } = buildSyntheticNegative();
  const recipe = createDefaultRecipe();
  recipe.density.enabled = true;
  const base = estimateFilmBaseRobust(data, width, height, 3);
  recipe.baseRgb = base.rgb;
  const anchors = estimateDensityAnchors(data, width, height, 3, base.rgb, {
    inputTransfer: recipe.density.inputTransfer,
    separation: recipe.density.separation,
    profileId: recipe.density.profileId,
    filmProfileId: recipe.density.filmProfileId,
  });
  recipe.density.low = anchors.low;
  recipe.density.high = anchors.high;
  recipe.density.shadowCorrection = anchors.shadowCorrection;
  recipe.density.midCorrection = anchors.midCorrection;
  recipe.density.highlightCorrection = anchors.highlightCorrection;
  const output = processRgb8(data, 3, recipe, { width, height });
  return { data: output, stats: analyze(output) };
}

describe('visual regression: automatic inversion baseline', () => {
  it('produces a sane, neutral, non-washed-out result', () => {
    const { data, stats } = runAutomaticConversion();
    expect(data.every((value) => Number.isFinite(value))).toBe(true);
    expect(stats.overall).toBeGreaterThan(0.1);
    expect(stats.overall).toBeLessThan(0.85);
    expect(stats.clippedHigh).toBeLessThan(0.35);
    expect(stats.clippedLow).toBeLessThan(0.35);
    expect(Math.abs(stats.mean[0] - stats.mean[1])).toBeLessThan(0.09);
    expect(Math.abs(stats.mean[1] - stats.mean[2])).toBeLessThan(0.09);
  });

  it('matches the golden feature file (or writes it on first run)', () => {
    const { stats } = runAutomaticConversion();
    if (process.env.GOLDEN_UPDATE === '1' || !exists(GOLDEN_PATH)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN_PATH, JSON.stringify({ stats, generatedAt: new Date().toISOString() }, null, 2));
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { stats: ReturnType<typeof analyze> };
    expect(Math.abs(stats.overall - golden.stats.overall)).toBeLessThan(GOLDEN_TOLERANCE);
    for (let channel = 0; channel < 3; channel += 1) {
      expect(Math.abs(stats.mean[channel] - golden.stats.mean[channel])).toBeLessThan(GOLDEN_TOLERANCE);
    }
  });
});

function exists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}
