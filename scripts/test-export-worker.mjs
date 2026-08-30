// ENG-03 协议验证：直接驱动编译后的 export.worker.js（不经 Electron）。
// 用法：npm run build && node scripts/test-export-worker.mjs
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = mkdtempSync(join(tmpdir(), 'chromik-wpool-'));
const srcPath = join(dir, 'source.png');
const outPath = join(dir, 'out.png');

const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#9a7a4c' } })
  .composite([{ input: Buffer.from(`<svg width="640" height="480"><rect width="640" height="480" fill="#9a7a4c"/><circle cx="320" cy="240" r="90" fill="#e8c37a"/></svg>`), left: 0, top: 0 }])
  .png().toBuffer();
writeFileSync(srcPath, png);

const workerPath = new URL('../dist-main/workers/export.worker.js', import.meta.url).pathname;
const worker = new Worker(workerPath, { workerData: {} });

const recipe = {
  schemaVersion: 6, algorithmVersion: 'chromik-6',
  crop: { x: 0, y: 0, width: 1, height: 1 },
  geometry: { corners: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}], rotation90: 0, straighten: 0, lensDistortion: 0, flipX: false, flipY: false },
  density: { enabled: false, low: [0.08,0.08,0.08], high: [1.8,1.8,1.8], mode: 'display_reference', profileId: 'camera_srgb', filmProfileId: 'generic_color_negative', inputTransfer: 'srgb', separation: 0, neutralProtection: 55, crossoverStrength: 1, shadowCorrection: [0,0,0], midCorrection: [0,0,0], highlightCorrection: [0,0,0] },
  grade: { exposureEv: 0, temperature: 0, tint: 0, contrast: 0, gamma: 1, saturation: 0, vibrance: 0, highlights: 0, shadows: 0, highlightRolloff: 35, fade: 0, printerLights: [0,0,0], blackAndWhite: false, look: 'neutral', lookStrength: 100, vignette: { strength: 0, midpoint: 50, roundness: 0 }, cmy: { cyan: 0, magenta: 0, yellow: 0, density: 0 }, curves: { rgb: [{x:0,y:0},{x:1,y:1}], red: [{x:0,y:0},{x:1,y:1}], green: [{x:0,y:0},{x:1,y:1}], blue: [{x:0,y:0},{x:1,y:1}] } },
  updatedAt: Date.now(),
};

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('worker 协议超时')), 30000);
  worker.on('message', (message) => {
    if (message.type === 'ready') {
      worker.postMessage({ type: 'task', jobId: randomUUID(), task: {
        sourcePath: srcPath, outputPath: outPath,
        sourceDescriptor: { role: 'master', transfer: 'srgb', bitDepth: 8, channels: 3, colorSpace: 'srgb' },
        recipe,
        config: { directory: dir, format: 'png', quality: 92, suffix: '_test', bitDepth: 8, resizeMode: 'original', width: 1, height: 1, lockAspect: true, allowUpscale: false, sharpening: 0, colorSpace: 'srgb', conflictPolicy: 'rename', borderPadding: 0 },
      } });
    }
    if (message.type === 'done') {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve(message);
    }
  });
  worker.on('error', reject);
});
await worker.terminate();

const ok = existsSync(outPath) && statSync(outPath).size > 1000;
console.log(`worker protocol: done=${JSON.stringify(result)} output=${ok ? 'OK' : 'MISSING'} (${statSync(outPath).size} bytes)`);
rmSync(dir, { recursive: true, force: true });
if (!ok) process.exit(1);
console.log('PASS');
