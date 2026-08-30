// Self-contained export colour/bit-depth smoke test. Run after npm run build.
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { encodeTiff16 } = require('../dist-main/adapters/tiff16.js');
const { createDefaultRecipe } = require('../dist-main/shared/defaults.js');
const directory = mkdtempSync(join(tmpdir(), 'chromik-export-color-'));
const sourcePath = join(directory, 'linear-source.tiff');
const width = 257;
const height = 96;
const pixels = new Uint16Array(width * height * 3);
for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
  const index = (y * width + x) * 3;
  pixels[index] = Math.round(x / (width - 1) * 55_000);
  pixels[index + 1] = Math.round(y / (height - 1) * 48_000);
  pixels[index + 2] = 20_000 + x;
}
writeFileSync(sourcePath, encodeTiff16(width, height, pixels, 3));

const worker = new Worker(new URL('../dist-main/workers/export.worker.js', import.meta.url));
await new Promise((resolve, reject) => {
  worker.on('message', function ready(message) {
    if (message.type !== 'ready') return;
    worker.off('message', ready);
    resolve();
  });
  worker.once('error', reject);
});

const recipe = createDefaultRecipe();
recipe.grade.contrast = 0;
const runTask = (outputPath, format, bitDepth, colorSpace, displayTransform) => new Promise((resolve, reject) => {
  const jobId = randomUUID();
  const onMessage = (message) => {
    if (message.type !== 'done' || message.jobId !== jobId) return;
    worker.off('message', onMessage);
    if (message.error) reject(new Error(message.error)); else resolve();
  };
  worker.on('message', onMessage);
  worker.postMessage({ type: 'task', jobId, task: {
    sourcePath, outputPath,
    sourceDescriptor: { role: 'master', transfer: 'linear', bitDepth: 16, channels: 3, colorSpace: 'srgb', decoder: 'chromik-cache' },
    recipe, displayTransform,
    config: { directory, format, quality: 94, suffix: '', bitDepth, resizeMode: 'original', width, height, lockAspect: true, allowUpscale: false, sharpening: 0, colorSpace, conflictPolicy: 'rename', borderPadding: 0 },
  } });
});

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
try {
  const p3Path = join(directory, 'positive-p3.tif');
  const srgbPath = join(directory, 'positive-srgb.png');
  const dngPath = join(directory, 'positive-linear.dng');
  await runTask(p3Path, 'tiff', 16, 'p3', 'camera-raw-neutral');
  await runTask(srgbPath, 'png', 16, 'srgb', 'camera-raw-neutral');
  // DNG deliberately bypasses the display-only path and writes LinearRaw.
  await runTask(dngPath, 'dng', 16, 'srgb', undefined);

  const p3 = await sharp(p3Path).metadata();
  const srgb = await sharp(srgbPath).metadata();
  const expectedP3Carrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).withIccProfile('p3').png().toBuffer();
  const expectedP3 = (await sharp(expectedP3Carrier).metadata()).icc;
  const expectedSrgbCarrier = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).withIccProfile('srgb').png().toBuffer();
  const expectedSrgb = (await sharp(expectedSrgbCarrier).metadata()).icc;
  const dng = await import('node:fs/promises').then(({ readFile }) => readFile(dngPath));
  const is16Bit = (value) => Array.isArray(value) ? value.every((item) => item === 16) : value === 16;
  const passed = is16Bit(p3.bitsPerSample)
    && is16Bit(srgb.bitsPerSample)
    && p3.icc && expectedP3 && hash(p3.icc) === hash(expectedP3)
    && srgb.icc && expectedSrgb && hash(srgb.icc) === hash(expectedSrgb)
    && dng.includes(Buffer.from([1, 4, 0, 0]));
  console.log(JSON.stringify({ passed: Boolean(passed), p3: { bits: p3.bitsPerSample, icc: p3.icc?.length }, srgb: { bits: srgb.bitsPerSample, icc: srgb.icc?.length }, dngBytes: dng.length }));
  if (!passed) process.exitCode = 1;
} finally {
  await worker.terminate();
  rmSync(directory, { recursive: true, force: true });
}
