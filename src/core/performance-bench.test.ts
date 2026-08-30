import { describe, expect, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import { processRgb8 } from './reconstruct';
import { estimateDensityAnchors, estimateFilmBaseRobust } from './density';

/**
 * QA-02 性能基准（core 层）：固定输入、固定机器记录、宽松断言防灾难性回归。
 *
 * 每次 `npm test` 记录在 console；正式性能台账请把输出归档到
 * `docs/performance.md`（含机器型号/OS/日期），文档要求"性能有可复现的
 * 输入、机器和耗时记录"。
 */

function syntheticNegative(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const base = [238, 166, 108];
  const data = new Uint8ClampedArray(width * height * 3);
  let seed = 24680;
  const random = () => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const scene = (x: number, y: number): [number, number, number] => {
    if (x > 0.3 && x < 0.52 && y > 0.32 && y < 0.52) return [0.5, 0.5, 0.5];
    if (y < 0.5) return [0.3 + y * 0.14, 0.48 + y * 0.1, 0.72 - y * 0.12];
    if (y < 0.7) return [0.2, 0.34, 0.26];
    return [0.26, 0.2, 0.14];
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

describe('core performance baseline (QA-02)', () => {
  it('8MP automatic-inversion pipeline stays within budget', { timeout: 30000 }, () => {
    const { data, width, height } = syntheticNegative(2880, 2160);
    const recipe = createDefaultRecipe();
    recipe.density.enabled = true;

    let started = performance.now();
    const base = estimateFilmBaseRobust(data, width, height, 3);
    const baseMs = performance.now() - started;

    started = performance.now();
    const anchors = estimateDensityAnchors(data, width, height, 3, base.rgb, {
      inputTransfer: recipe.density.inputTransfer,
      separation: recipe.density.separation,
      profileId: recipe.density.profileId,
      filmProfileId: recipe.density.filmProfileId,
    });
    const anchorsMs = performance.now() - started;

    recipe.baseRgb = base.rgb;
    recipe.density.low = anchors.low;
    recipe.density.high = anchors.high;
    recipe.density.shadowCorrection = anchors.shadowCorrection;
    recipe.density.midCorrection = anchors.midCorrection;
    recipe.density.highlightCorrection = anchors.highlightCorrection;

    started = performance.now();
    processRgb8(data, 3, recipe, { width, height });
    const processMs = performance.now() - started;

    // 宽松上限：防灾难性回归（如误引入 O(n²) 或全量拷贝）。机器记录见输出。
    expect(baseMs).toBeLessThan(4000);
    expect(anchorsMs).toBeLessThan(4000);
    expect(processMs).toBeLessThan(6000);
    console.log(`[bench] 8MP (2880×2160): base=${baseMs.toFixed(0)}ms anchors=${anchorsMs.toFixed(0)}ms processRgb8=${processMs.toFixed(0)}ms`);
  });
});
