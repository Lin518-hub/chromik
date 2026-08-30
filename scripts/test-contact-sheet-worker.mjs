// Builds a real CHPX source, exercises contact-sheet output and verifies that
// cancellation leaves neither a final image nor an atomic-write temporary.
// Run after `npm run build`.
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { encodeDevelopProxy } = require('../dist-main/core/develop-proxy.js');
const directory = mkdtempSync(join(tmpdir(), 'chromik-contact-worker-'));
const proxyPath = join(directory, 'source.chpx');
const width = 960;
const height = 640;
const pixels = new Uint16Array(width * height * 3);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 3;
    pixels[index] = Math.round(65_535 * x / (width - 1));
    pixels[index + 1] = Math.round(65_535 * y / (height - 1));
    pixels[index + 2] = 28_000;
  }
}
writeFileSync(proxyPath, encodeDevelopProxy({ width, height, channels: 3, bitDepth: 16, transfer: 'linear', data: pixels }));

const recipe = {
  schemaVersion: 6, algorithmVersion: 'chromik-6', crop: { x: 0, y: 0, width: 1, height: 1 },
  geometry: { corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], rotation90: 0, straighten: 0, lensDistortion: 0, flipX: false, flipY: false },
  density: { enabled: false, low: [.08, .08, .08], high: [1.8, 1.8, 1.8], mode: 'display_reference', profileId: 'camera_srgb', filmProfileId: 'generic_color_negative', inputTransfer: 'linear', separation: 0, neutralProtection: 55, crossoverStrength: 1, shadowCorrection: [0, 0, 0], midCorrection: [0, 0, 0], highlightCorrection: [0, 0, 0] },
  grade: { exposureEv: 0, temperature: 0, tint: 0, contrast: 0, gamma: 1, saturation: 0, vibrance: 0, highlights: 0, shadows: 0, highlightRolloff: 35, fade: 0, printerLights: [0, 0, 0], blackAndWhite: false, look: 'neutral', lookStrength: 100, vignette: { strength: 0, midpoint: 50, roundness: 0 }, cmy: { cyan: 0, magenta: 0, yellow: 0, density: 0 }, curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }], red: [{ x: 0, y: 0 }, { x: 1, y: 1 }], green: [{ x: 0, y: 0 }, { x: 1, y: 1 }], blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
  updatedAt: 1,
};
const config = { style: 'classic', resolution: 'preview', columns: 4, showFileName: true, showMetadata: true, title: '', format: 'jpeg' };
const frame = (index) => ({ id: `frame-${index}`, name: `Frame ${index}`, frameNumber: index, width, height, proxyPath, recipe });
const workerPath = new URL('../dist-main/workers/contact-sheet.worker.js', import.meta.url);

function runWorker(outputPath, count, cancelAfterFirst = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { jobId: `job-${count}`, config, rolls: [{ name: 'QA roll', filmType: 'color_negative', filmStock: 'Generic', camera: 'QA', shotDate: '', outputPath, frames: Array.from({ length: count }, (_, index) => frame(index + 1)) }] } });
    let cancelled = false;
    worker.on('message', (message) => {
      if (cancelAfterFirst && message.type === 'progress' && !cancelled) {
        cancelled = true;
        worker.postMessage({ type: 'cancel' });
      }
      if (message.type === 'result') {
        void worker.terminate();
        resolve(message);
      }
    });
    worker.once('error', reject);
  });
}

try {
  const outputPath = join(directory, 'sheet.jpg');
  const success = await runWorker(outputPath, 4);
  const metadata = await sharp(outputPath).metadata();
  if (success.cancelled || success.fatal || !metadata.icc?.length || metadata.space !== 'srgb') throw new Error('contact sheet smoke output failed');

  const cancelledPath = join(directory, 'cancelled.jpg');
  const cancelled = await runWorker(cancelledPath, 80, true);
  const leftovers = readdirSync(directory).filter((name) => name.startsWith('cancelled.jpg'));
  if (!cancelled.cancelled || leftovers.length) throw new Error(`contact sheet cancellation cleanup failed: ${leftovers.join(',')}`);
  console.log(JSON.stringify({ passed: true, output: { width: metadata.width, height: metadata.height, iccBytes: metadata.icc.length }, cancellation: { cancelled: true, leftovers: 0 } }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
