import type { FilmType, Matrix9 } from './types';

export interface FilmStockProfile {
  id: string;
  label: string;
  description: string;
  filmTypes: FilmType[];
  /** Density-anchor percentiles used during automatic analysis. */
  lowPercentile: number;
  highPercentile: number;
  minimumDensitySpan: number;
  /** Whether tonal-band crossover correction is estimated for this stock. */
  crossoverCorrection: boolean;
  /** Scales how strongly estimated crossover corrections are applied. */
  crossoverStrength: number;
  /** Default channel-decoupling strength (0-100). */
  separation: number;
  /** Optional custom 3×3 channel-decoupling matrix (row-major). */
  separationMatrix?: Matrix9;
  /** Default neutral (white-balance) protection (0-100). */
  neutralProtection: number;
  /** Filmic toe knee in [0,1]; 0 = no toe compression. */
  toeKnee: number;
  /** Filmic shoulder knee in [0,1]; 1 = no shoulder compression. */
  shoulderKnee: number;
  measured: false;
  version: 'generic-1';
}

const GENERIC_COLOR_MATRIX: Matrix9 = [
  1.055, -0.040, -0.015,
  -0.025, 1.050, -0.025,
  -0.010, -0.035, 1.045,
];

/**
 * Generic, versioned per-stock starting points. They are display-reference
 * approximations tuned by hand, NOT measured sensitometry or spectral dye
 * densities. Real Kodak/Fuji/Ilford measurements would replace these.
 */
export const FILM_STOCK_PROFILES: FilmStockProfile[] = [
  {
    id: 'kodak_portra_160',
    label: 'Kodak Portra 160',
    description: '通用近似：低饱和人像负片，偏柔和的肩部。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.18,
    crossoverCorrection: true, crossoverStrength: 1.0,
    separation: 32, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 55,
    toeKnee: 0.06, shoulderKnee: 0.82,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_portra_400',
    label: 'Kodak Portra 400',
    description: '通用近似：最常用的 400 度人像负片，皮肤还原优先。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.19,
    crossoverCorrection: true, crossoverStrength: 1.0,
    separation: 32, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 58,
    toeKnee: 0.07, shoulderKnee: 0.83,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_portra_800',
    label: 'Kodak Portra 800',
    description: '通用近似：高感人像负片，颗粒更多，反差略高。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.2,
    crossoverCorrection: true, crossoverStrength: 0.9,
    separation: 30, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 52,
    toeKnee: 0.08, shoulderKnee: 0.84,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_ektar_100',
    label: 'Kodak Ektar 100',
    description: '通用近似：高饱和风景负片，反差更高，肩部收得较早。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.2,
    crossoverCorrection: true, crossoverStrength: 1.1,
    separation: 38, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 50,
    toeKnee: 0.05, shoulderKnee: 0.78,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_gold_200',
    label: 'Kodak Gold 200',
    description: '通用近似：消费级负片，暖调、反差适中。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.19,
    crossoverCorrection: true, crossoverStrength: 0.9,
    separation: 28, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 55,
    toeKnee: 0.09, shoulderKnee: 0.85,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_ultramax_400',
    label: 'Kodak Ultramax 400',
    description: '通用近似：高饱和消费负片，宽容度一般。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.19,
    crossoverCorrection: true, crossoverStrength: 0.95,
    separation: 30, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 52,
    toeKnee: 0.08, shoulderKnee: 0.85,
    measured: false, version: 'generic-1',
  },
  {
    id: 'fujifilm_pro400h',
    label: 'Fujifilm Pro 400H',
    description: '通用近似：Fuji 人像负片，偏绿肤底、柔和。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.19,
    crossoverCorrection: true, crossoverStrength: 1.0,
    separation: 34, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 60,
    toeKnee: 0.1, shoulderKnee: 0.84,
    measured: false, version: 'generic-1',
  },
  {
    id: 'fujifilm_superia_400',
    label: 'Fujifilm Superia 400',
    description: '通用近似：消费级负片，绿调倾向、色彩鲜艳。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.2,
    crossoverCorrection: true, crossoverStrength: 0.9,
    separation: 32, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 55,
    toeKnee: 0.08, shoulderKnee: 0.86,
    measured: false, version: 'generic-1',
  },
  {
    id: 'fujifilm_c200',
    label: 'Fujifilm C200',
    description: '通用近似：入门彩色负片，柔和偏绿。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.19,
    crossoverCorrection: true, crossoverStrength: 0.85,
    separation: 26, separationMatrix: GENERIC_COLOR_MATRIX, neutralProtection: 55,
    toeKnee: 0.1, shoulderKnee: 0.87,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_trix_400',
    label: 'Kodak Tri-X 400',
    description: '通用近似：经典黑白负片，反差高、颗粒粗。',
    filmTypes: ['bw_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.22,
    crossoverCorrection: false, crossoverStrength: 0,
    separation: 0, neutralProtection: 60,
    toeKnee: 0.08, shoulderKnee: 0.82,
    measured: false, version: 'generic-1',
  },
  {
    id: 'kodak_tmax_400',
    label: 'Kodak T-Max 400',
    description: '通用近似：现代黑白负片，细腻、直方图更线性。',
    filmTypes: ['bw_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.22,
    crossoverCorrection: false, crossoverStrength: 0,
    separation: 0, neutralProtection: 60,
    toeKnee: 0.05, shoulderKnee: 0.88,
    measured: false, version: 'generic-1',
  },
  {
    id: 'ilford_hp5_plus',
    label: 'Ilford HP5 Plus',
    description: '通用近似：经典黑白负片，中间调丰富。',
    filmTypes: ['bw_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.22,
    crossoverCorrection: false, crossoverStrength: 0,
    separation: 0, neutralProtection: 60,
    toeKnee: 0.07, shoulderKnee: 0.84,
    measured: false, version: 'generic-1',
  },
  {
    id: 'ilford_fp4_plus',
    label: 'Ilford FP4 Plus',
    description: '通用近似：中速黑白负片，影调细腻。',
    filmTypes: ['bw_negative'],
    lowPercentile: 0.005, highPercentile: 0.99, minimumDensitySpan: 0.2,
    crossoverCorrection: false, crossoverStrength: 0,
    separation: 0, neutralProtection: 60,
    toeKnee: 0.06, shoulderKnee: 0.86,
    measured: false, version: 'generic-1',
  },
];

export function getFilmStockProfile(id: string): FilmStockProfile | undefined {
  return FILM_STOCK_PROFILES.find((profile) => profile.id === id);
}

/** Fuzzy-match a roll's film-stock string to a generic profile, e.g. "portra 400". */
export function suggestFilmStockProfile(filmStock: string): FilmStockProfile | undefined {
  const normalized = filmStock.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!normalized) return undefined;
  return FILM_STOCK_PROFILES.find((profile) => {
    const key = profile.id.replace(/^kodak_|^fujifilm_|^ilford_|^fuji_/, '').replace(/_/g, '');
    return key === normalized || normalized.includes(key);
  });
}
