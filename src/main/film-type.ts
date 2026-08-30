import sharp from 'sharp';
import type { FilmType } from '../shared/types';

export interface FilmTypeEstimate {
  filmType: FilmType;
  confidence: number;
  reason: string;
}

export function classifyFilmPixels(data: ArrayLike<number>, width: number, height: number, channels: number, maxValue = 255): FilmTypeEstimate {
  // BUG-044：位深防御——任何非正/非有限 maxValue 都归一化回 8 位假设，
  // 避免 16 位数据除以 255 导致全饱和误判。
  if (!Number.isFinite(maxValue) || maxValue <= 0) maxValue = 255;
  let edgeLuma = 0;
  let centerLuma = 0;
  let edgeWarmth = 0;
  let chroma = 0;
  let edgeCount = 0;
  let centerCount = 0;
  const borderX = Math.max(2, Math.round(width * .12));
  const borderY = Math.max(2, Math.round(height * .12));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      const red = data[index] / maxValue;
      const green = data[index + 1] / maxValue;
      const blue = data[index + 2] / maxValue;
      const luma = red * .2126 + green * .7152 + blue * .0722;
      chroma += Math.max(red, green, blue) - Math.min(red, green, blue);
      const edge = x < borderX || x >= width - borderX || y < borderY || y >= height - borderY;
      if (edge) {
        edgeLuma += luma;
        edgeWarmth += red - blue;
        edgeCount += 1;
      } else {
        centerLuma += luma;
        centerCount += 1;
      }
    }
  }
  edgeLuma /= Math.max(1, edgeCount);
  centerLuma /= Math.max(1, centerCount);
  edgeWarmth /= Math.max(1, edgeCount);
  chroma /= Math.max(1, width * height);
  const blackAndWhite = chroma < .055;
  const edgeDifference = edgeLuma - centerLuma;
  const negativeSignal = edgeDifference > .07 || edgeWarmth > .12;
  const slideSignal = edgeDifference < -.07 && edgeLuma < .28;
  if (!negativeSignal && !slideSignal) {
    return { filmType: 'unknown', confidence: .42, reason: '画面没有保留足够明确的片基边缘，请手动确认片种' };
  }
  const filmType: FilmType = negativeSignal
    ? (blackAndWhite ? 'bw_negative' : 'color_negative')
    : (blackAndWhite ? 'bw_slide' : 'color_slide');
  const separation = Math.min(.35, Math.abs(edgeDifference));
  const confidence = Math.max(.55, Math.min(.96, .58 + separation * 1.35 + (negativeSignal ? Math.max(0, edgeWarmth) * .35 : 0)));
  const polarity = negativeSignal ? '边缘片基比画面更亮' : '边缘片框明显更暗';
  const colour = blackAndWhite ? '通道色差很低' : '检测到彩色通道差异';
  return { filmType, confidence, reason: `${polarity}，${colour}` };
}

export async function detectFilmTypeFromImage(sourcePath: string): Promise<FilmTypeEstimate> {
  const { data, info } = await sharp(sourcePath, { failOn: 'error', limitInputPixels: 1_000_000_000 })
    .rotate()
    .removeAlpha()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return classifyFilmPixels(data, info.width, info.height, info.channels);
}
