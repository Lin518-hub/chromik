import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import engData from '@tesseract.js-data/eng';
import type { FilmType, RollInput } from '../shared/types';

/** P3-9：识别管线只处理代理级图像，百万像素级上限足够且防失控内存。 */
const OCR_INPUT_PIXEL_LIMIT = 100_000_000;
/** P2-5：OCR 硬超时——tesseract 可能长时间挂起，超时后终止 worker 并报错。 */
const OCR_TIMEOUT_MS = 45_000;

interface FilmPattern {
  pattern: RegExp;
  stock: string;
  iso?: number;
  filmType: FilmType;
}

const FILM_PATTERNS: FilmPattern[] = [
  { pattern: /PORTRA\s*160/i, stock: 'Kodak Portra 160', iso: 160, filmType: 'color_negative' },
  { pattern: /PORTRA\s*400/i, stock: 'Kodak Portra 400', iso: 400, filmType: 'color_negative' },
  { pattern: /PORTRA\s*800/i, stock: 'Kodak Portra 800', iso: 800, filmType: 'color_negative' },
  { pattern: /EKTAR\s*100/i, stock: 'Kodak Ektar 100', iso: 100, filmType: 'color_negative' },
  { pattern: /(?:GOLD|GB)\s*200/i, stock: 'Kodak Gold 200', iso: 200, filmType: 'color_negative' },
  { pattern: /ULTRAMAX|MAX\s*400/i, stock: 'Kodak Ultramax 400', iso: 400, filmType: 'color_negative' },
  { pattern: /VISION\s*3.*50D/i, stock: 'Kodak Vision3 50D', iso: 50, filmType: 'color_negative' },
  { pattern: /VISION\s*3.*250D/i, stock: 'Kodak Vision3 250D', iso: 250, filmType: 'color_negative' },
  { pattern: /VISION\s*3.*500T/i, stock: 'Kodak Vision3 500T', iso: 500, filmType: 'color_negative' },
  { pattern: /EKTACHROME|E100/i, stock: 'Kodak Ektachrome E100', iso: 100, filmType: 'color_slide' },
  { pattern: /PROVIA.*100/i, stock: 'Fujifilm Provia 100F', iso: 100, filmType: 'color_slide' },
  { pattern: /VELVIA.*50/i, stock: 'Fujifilm Velvia 50', iso: 50, filmType: 'color_slide' },
  { pattern: /VELVIA.*100/i, stock: 'Fujifilm Velvia 100', iso: 100, filmType: 'color_slide' },
  { pattern: /SUPERIA.*400/i, stock: 'Fujifilm Superia 400', iso: 400, filmType: 'color_negative' },
  { pattern: /C200|FUJI(?:COLOR)?\s*200/i, stock: 'Fujifilm C200', iso: 200, filmType: 'color_negative' },
  { pattern: /PRO\s*400H/i, stock: 'Fujifilm Pro 400H', iso: 400, filmType: 'color_negative' },
  { pattern: /HP5(?:\s*PLUS)?/i, stock: 'Ilford HP5 Plus', iso: 400, filmType: 'bw_negative' },
  { pattern: /FP4(?:\s*PLUS)?/i, stock: 'Ilford FP4 Plus', iso: 125, filmType: 'bw_negative' },
  { pattern: /DELTA\s*100/i, stock: 'Ilford Delta 100', iso: 100, filmType: 'bw_negative' },
  { pattern: /DELTA\s*400/i, stock: 'Ilford Delta 400', iso: 400, filmType: 'bw_negative' },
  { pattern: /DELTA\s*3200/i, stock: 'Ilford Delta 3200', iso: 3200, filmType: 'bw_negative' },
  { pattern: /PAN\s*F(?:\s*PLUS)?/i, stock: 'Ilford Pan F Plus', iso: 50, filmType: 'bw_negative' },
  { pattern: /TRI[ -]?X/i, stock: 'Kodak Tri-X 400', iso: 400, filmType: 'bw_negative' },
  { pattern: /T[ -]?MAX\s*100|TMX/i, stock: 'Kodak T-Max 100', iso: 100, filmType: 'bw_negative' },
  { pattern: /T[ -]?MAX\s*400|TMY/i, stock: 'Kodak T-Max 400', iso: 400, filmType: 'bw_negative' },
  { pattern: /ACROS(?:\s*II)?/i, stock: 'Fujifilm Acros II 100', iso: 100, filmType: 'bw_negative' },
];

export function parseFilmEdgeText(text: string): Partial<Pick<RollInput, 'filmType' | 'filmStock' | 'iso'>> {
  const normalized = text.replace(/[^A-Z0-9+\- ]/gi, ' ').replace(/\s+/g, ' ').trim();
  for (const candidate of FILM_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return { filmType: candidate.filmType, filmStock: candidate.stock, iso: candidate.iso };
    }
  }
  const isoMatch = normalized.match(/(?:ISO|ASA)\s*(25|50|64|80|100|125|160|200|250|400|500|800|1600|3200)/i);
  return isoMatch ? { iso: Number(isoMatch[1]) } : {};
}

async function createEdgeOcrImage(source: string | Buffer): Promise<Buffer> {
  const metadata = await sharp(source, { failOn: 'error', limitInputPixels: OCR_INPUT_PIXEL_LIMIT }).metadata();
  const rawWidth = metadata.width ?? 0;
  const rawHeight = metadata.height ?? 0;
  const swapsAxes = Boolean(metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8);
  const width = swapsAxes ? rawHeight : rawWidth;
  const height = swapsAxes ? rawWidth : rawHeight;
  if (!width || !height) throw new Error('无法读取片基图像');
  const horizontalHeight = Math.max(24, Math.round(height * 0.18));
  const verticalWidth = Math.max(24, Math.round(width * 0.14));
  const regions = [
    { left: 0, top: 0, width, height: horizontalHeight, angle: 0 },
    { left: 0, top: height - horizontalHeight, width, height: horizontalHeight, angle: 180 },
    { left: 0, top: 0, width: verticalWidth, height, angle: 90 },
    { left: width - verticalWidth, top: 0, width: verticalWidth, height, angle: 270 },
  ];
  const strips: Buffer[] = [];
  for (const region of regions) {
    // Keep extraction and the subsequent edge rotation in separate pipelines. libvips may
    // otherwise reorder adjacent rotate/extract operations and invalidate a right-edge crop.
    const extracted = await sharp(source, { failOn: 'error', limitInputPixels: OCR_INPUT_PIXEL_LIMIT })
      .rotate()
      .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .png()
      .toBuffer();
    const strip = await sharp(extracted)
      .rotate(region.angle)
      .grayscale()
      .normalize()
      .sharpen()
      .resize({ height: 180, width: 3000, fit: 'inside', withoutEnlargement: false })
      .threshold(145)
      .png()
      .toBuffer();
    strips.push(strip);
  }
  const stripMetadata = await Promise.all(strips.map((strip) => sharp(strip).metadata()));
  const outputWidth = Math.max(...stripMetadata.map((item) => item.width ?? 0));
  const heights = stripMetadata.map((item) => item.height ?? 0);
  const outputHeight = heights.reduce((sum, value) => sum + value, 0) + 30 * (strips.length - 1);
  let top = 0;
  const composites = strips.map((strip, index) => {
    const item = { input: strip, left: 0, top };
    top += heights[index] + 30;
    return item;
  });
  return sharp({ create: { width: outputWidth, height: outputHeight, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .png()
    .toBuffer();
}

export async function recognizeFilmEdge(source: string | Buffer, cacheDirectory: string): Promise<{
  text: string;
  confidence: number;
  detected: Partial<Pick<RollInput, 'filmType' | 'filmStock' | 'iso'>>;
}> {
  const input = await createEdgeOcrImage(source);
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: engData.langPath,
    gzip: engData.gzip,
    cachePath: path.join(cacheDirectory, 'tesseract'),
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    const result = await Promise.race([
      worker.recognize(input),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          // 超时后立即终止 worker，让 Promise 以明确错误结束而不是悬挂。
          void worker.terminate().catch(() => undefined);
          reject(new Error('片基文字识别超时，已取消'));
        }, OCR_TIMEOUT_MS);
      }),
    ]);
    const text = result.data.text.replace(/\s+/g, ' ').trim();
    return { text, confidence: Math.max(0, Math.min(1, result.data.confidence / 100)), detected: parseFilmEdgeText(text) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await worker.terminate().catch(() => undefined);
  }
}
