import measuredStockData from './measured-stock-data.json';

/**
 * Measured film-stock data derived from the MIT-licensed
 * `JanLohse/spectral_film_lut` project (https://github.com/JanLohse/spectral_film_lut).
 * That project digitized film datasheet characteristic curves and spectral dye
 * densities. See `src/shared/measured-stock-data.json` and the MIT LICENSE note
 * in `src/shared/film-stock-profiles.ts`.
 */

export interface MeasuredHdLuts {
  /** Per-channel LUT: input normalized density [0,1] -> display [0,1]. */
  luts: [Float32Array, Float32Array, Float32Array];
}

const LUT_SIZE = 256;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildHdLut(curve: Record<string, number>): Float32Array {
  const entries = Object.entries(curve)
    .map(([exposure, density]) => [Number(exposure), density] as const)
    .sort((left, right) => left[0] - right[0]);
  const exposures = entries.map(([exposure]) => exposure);
  const densities = entries.map(([, density]) => density);
  const dmin = densities.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const dmax = densities.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const emin = exposures[0];
  const emax = exposures[exposures.length - 1];
  const lut = new Float32Array(LUT_SIZE);
  for (let index = 0; index < LUT_SIZE; index += 1) {
    const t = index / (LUT_SIZE - 1);
    const dTarget = dmin + t * (dmax - dmin);
    let exposure: number;
    if (dTarget <= densities[0]) {
      exposure = exposures[0];
    } else if (dTarget >= densities[densities.length - 1]) {
      exposure = exposures[exposures.length - 1];
    } else {
      let low = 0;
      while (densities[low + 1] < dTarget) low += 1;
      const fraction = (dTarget - densities[low]) / (densities[low + 1] - densities[low]);
      exposure = exposures[low] + (exposures[low + 1] - exposures[low]) * fraction;
    }
    lut[index] = clamp01((exposure - emin) / (emax - emin));
  }
  return lut;
}

/**
 * Maps Chromik's generic stock ids to the measured dataset ids.
 * Only stocks whose dataset entry carries a full 3-channel `sensiometricCurve`
 * are listed; stocks missing from the dataset or with fewer than 3 curves
 * (e.g. `kodak_portra_800`, `kodak_trix_400`) intentionally stay unmapped.
 */
const MEASURED_ID_BY_STOCK: Record<string, string> = {
  fujifilm_pro400h: 'fuji_pro_400h',
  fujifilm_superia_400: 'fuji_superia_xtra_400',
  fujifilm_c200: 'fuji_c200',
  kodak_portra_160: 'kodak_portra_160',
  kodak_portra_400: 'kodak_portra_400',
  kodak_ektar_100: 'kodak_ektar_100',
  kodak_gold_200: 'kodak_gold_200',
  kodak_ultramax_400: 'kodak_ultramax_400',
};

const cache = new Map<string, MeasuredHdLuts | undefined>();

/**
 * Returns the datasheet H-D characteristic curve (per RGB channel) for a stock,
 * precomputed as inverse LUTs, or undefined when the stock has no measured data.
 *
 * IMPORTANT: the datasheet curves are Status-M optical densities while Chromik
 * computes a scanner density (`-log10(scan/base)`). Applying them directly is a
 * shape-preserving tonal approximation, not a full Status-M / spectral
 * inversion; it replaces the generic toe/shoulder with the real per-channel
 * curve shape.
 */
export function getMeasuredHdLuts(stockId: string): MeasuredHdLuts | undefined {
  const measuredId = MEASURED_ID_BY_STOCK[stockId] ?? stockId;
  if (cache.has(measuredId)) return cache.get(measuredId);
  const entry = (measuredStockData as Array<{ id: string; sensiometricCurve?: Array<Record<string, number>> }>)
    .find((item) => item.id === measuredId && item.sensiometricCurve?.length === 3);
  if (!entry?.sensiometricCurve) {
    cache.set(measuredId, undefined);
    return undefined;
  }
  const luts = entry.sensiometricCurve.map(buildHdLut) as [Float32Array, Float32Array, Float32Array];
  cache.set(measuredId, { luts });
  return { luts };
}
