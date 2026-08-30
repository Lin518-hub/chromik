import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { estimateDensityAnchors, estimateFilmBaseRobust, detectContentRect } = require('../dist-main/core/density.js');
const { createDefaultRecipe, rectToQuad } = require('../dist-main/shared/defaults.js');

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
const format = process.argv[4] || 'png';
const width = Number(process.argv[5] || 0);
const height = Number(process.argv[6] || 0);
if (!sourcePath || !outputPath) throw new Error('Usage: node scripts/export-smoke.mjs <source> <output>');

const { data, info } = await sharp(sourcePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const base = estimateFilmBaseRobust(data, info.width, info.height, info.channels);
const baseRgb = base.rgb;
const { low, high, shadowCorrection, midCorrection, highlightCorrection } = estimateDensityAnchors(data, info.width, info.height, info.channels, baseRgb, { baseRgbLinear: base.linearRgb });
const { crop, confidence } = detectContentRect(data, info.width, info.height, info.channels, baseRgb, { baseRgbLinear: base.linearRgb });
const recipe = createDefaultRecipe();
recipe.crop = crop;
recipe.geometry.corners = rectToQuad(crop);
recipe.baseRgb = baseRgb;
recipe.baseRgbLinear = base.linearRgb;
recipe.density.enabled = true;
recipe.density.low = low;
recipe.density.high = high;
recipe.density.shadowCorrection = shadowCorrection;
recipe.density.midCorrection = midCorrection;
recipe.density.highlightCorrection = highlightCorrection;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.rm(outputPath, { force: true });

await new Promise((resolve, reject) => {
  const worker = new Worker(new URL('../dist-main/workers/export.worker.js', import.meta.url));
  const jobId = randomUUID();
  worker.on('message', (message) => {
    if (message?.type === 'ready') {
      worker.postMessage({
        type: 'task',
        jobId,
        task: {
          sourcePath,
          outputPath,
          sourceDescriptor: { role: 'master', transfer: 'srgb', bitDepth: 8, channels: 3, colorSpace: 'srgb' },
          recipe,
          config: {
            directory: path.dirname(outputPath), format, quality: 92, suffix: '_processed', bitDepth: 16,
            resizeMode: width > 0 && height > 0 ? 'dimensions' : 'original',
            width: width || info.width, height: height || info.height, lockAspect: true,
            allowUpscale: false, sharpening: 20, conflictPolicy: 'rename', borderPadding: 0,
            colorSpace: 'srgb',
          },
        },
      });
      return;
    }
    if (message?.jobId !== jobId) return;
    void worker.terminate();
    if (message.type === 'done' && !message.error) resolve();
    else reject(new Error(message.error || message.message || '导出工作线程失败'));
  });
  worker.once('error', reject);
});

const metadata = await sharp(outputPath).metadata();
console.log(JSON.stringify({
  outputPath,
  baseRgb,
  crop,
  cropConfidence: Number(confidence.toFixed(3)),
  format: metadata.format,
  width: metadata.width,
  height: metadata.height,
  colourspace: metadata.space,
  hasIcc: Boolean(metadata.icc?.length),
  bitsPerSample: metadata.bitsPerSample,
}));
