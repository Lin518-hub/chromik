import type { CaptureProfileId, CropRect, CurvePoints, DustSpot, EditRecipe, FilmType, Matrix9, Point, Quad, RGB, RollCalibration } from './types';
import { filmResponseProfileForType } from './film-response-profiles';
import { getFilmStockProfile } from './film-stock-profiles';

export const identityCurve = (): CurvePoints => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

/**
 * A generic capture has no measured camera/light/film response matrix. Keep
 * channel separation disabled until a versioned measured profile is selected;
 * automatic neutral-axis estimation remains data-driven and reversible.
 */
export const DEFAULT_DENSITY_SEPARATION = 0;

/**
 * A small, reversible D65 viewing adaptation for colour-negative positives.
 * It compensates the cool result left by strict neutral-axis removal without
 * changing optical-density anchors or pretending to be a stock measurement.
 */
export const DEFAULT_COLOR_NEGATIVE_TEMPERATURE = 18;

function simplifyCurve(points: CurvePoints): CurvePoints {
  if (points.length <= 2) return points;
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1];
    const next = points[index + 1];
    const span = next.x - previous.x;
    if (span <= 0) return false;
    const interpolated = previous.y + (next.y - previous.y) * ((point.x - previous.x) / span);
    return Math.abs(point.y - interpolated) > .0001;
  });
}

function migrateCurve(input: unknown): CurvePoints {
  if (!Array.isArray(input)) return identityCurve();
  if (input.length >= 2 && input.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return simplifyCurve(input.map((y, index) => ({ x: index / (input.length - 1), y: Math.max(0, Math.min(1, y)) })));
  }
  const points = input.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const point = value as { x?: unknown; y?: unknown };
    return typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y)
      ? [{ x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }]
      : [];
  }).sort((a, b) => a.x - b.x);
  if (points.length < 2) return identityCurve();
  points[0].x = 0;
  points[points.length - 1].x = 1;
  return simplifyCurve(points.slice(0, 16));
}

export function rectToQuad(crop: CropRect): Quad {
  return [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x + crop.width, y: crop.y + crop.height },
    { x: crop.x, y: crop.y + crop.height },
  ];
}

/** BUG-020：四角校验——旧库损坏数据绕过 zod，必须在迁移层兜住。 */
function validQuad(value: unknown): Quad | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const corners: Point[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const point = item as { x?: unknown; y?: unknown };
    if (typeof point.x !== 'number' || typeof point.y !== 'number') return undefined;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
    corners.push({ x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) });
  }
  return corners as Quad;
}

export function createDefaultRecipe(): EditRecipe {
  return {
    schemaVersion: 6,
    algorithmVersion: 'chromik-6',
    crop: { x: 0, y: 0, width: 1, height: 1 },
    geometry: {
      corners: rectToQuad({ x: 0, y: 0, width: 1, height: 1 }),
      rotation90: 0,
      straighten: 0,
      lensDistortion: 0,
      flipX: false,
      flipY: false,
    },
    density: {
      enabled: false,
      low: [0.08, 0.08, 0.08],
      high: [1.8, 1.8, 1.8],
      mode: 'display_reference',
      profileId: 'camera_srgb',
      filmProfileId: 'generic_color_negative',
      inputTransfer: 'srgb',
      separation: DEFAULT_DENSITY_SEPARATION,
      neutralProtection: 55,
      crossoverStrength: 1,
      shadowCorrection: [0, 0, 0],
      midCorrection: [0, 0, 0],
      highlightCorrection: [0, 0, 0],
    },
    grade: {
      exposureEv: 0,
      temperature: 0,
      tint: 0,
      contrast: 8,
      gamma: 1,
      saturation: 0,
      vibrance: 0,
      highlights: 0,
      shadows: 0,
      highlightRolloff: 35,
      fade: 0,
      printerLights: [0, 0, 0],
      blackAndWhite: false,
      look: 'neutral',
      lookStrength: 100,
      vignette: { strength: 0, midpoint: 50, roundness: 0 },
      cmy: { cyan: 0, magenta: 0, yellow: 0, density: 0 },
      curves: {
        rgb: identityCurve(),
        red: identityCurve(),
        green: identityCurve(),
        blue: identityCurve(),
      },
    },
    updatedAt: Date.now(),
  };
}

export function createRecipeForFilmType(filmType: FilmType): EditRecipe {
  const recipe = createDefaultRecipe();
  const negative = filmType === 'color_negative' || filmType === 'bw_negative';
  recipe.density.filmProfileId = filmResponseProfileForType(filmType);
  recipe.grade.blackAndWhite = filmType === 'bw_negative' || filmType === 'bw_slide';
  if (negative) {
    // Negative density needs a gentle toe and shoulder after anchor
    // normalisation. This is our generic, independently-authored display
    // rendering intent; it is not an exposure gain or a measured Cineon LUT.
    recipe.density.mode = 'cineon';
    recipe.grade.contrast = 0;
  }
  if (filmType === 'color_negative') recipe.grade.temperature = DEFAULT_COLOR_NEGATIVE_TEMPERATURE;
  return recipe;
}

export function createDefaultCalibration(filmType: FilmType): RollCalibration {
  const recipe = createRecipeForFilmType(filmType);
  return { density: { ...recipe.density }, updatedAt: Date.now() };
}

export function migrateCalibration(input: unknown, filmType: FilmType): RollCalibration {
  const defaults = createDefaultCalibration(filmType);
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Partial<RollCalibration>;
  const rawDensity = raw.density as LegacyDensity | undefined;
  const densityWithoutEngine = { ...(rawDensity ?? {}) };
  delete densityWithoutEngine.engine;
  const baseRgb = Array.isArray(raw.baseRgb) && raw.baseRgb.length === 3
    ? raw.baseRgb.map((value) => Math.max(1, Math.min(255, Number(value) || 1))) as RollCalibration['baseRgb']
    : undefined;
  const anchors = migrateDensityAnchors(rawDensity, baseRgb);
  return {
    baseRgb,
    baseRgbLinear: validLinearRgb(raw.baseRgbLinear),
    density: {
      ...defaults.density,
      ...densityWithoutEngine,
      ...anchors,
      mode: validDensityMode(rawDensity?.mode),
      profileId: validProfileId(rawDensity?.profileId),
      filmProfileId: validFilmProfileId(rawDensity?.filmProfileId, filmType),
      inputTransfer: rawDensity?.inputTransfer === 'linear' ? 'linear' : 'srgb',
      separation: migratedSeparation(rawDensity),
      neutralProtection: finitePercent(rawDensity?.neutralProtection, defaults.density.neutralProtection),
      crossoverStrength: finiteCrossover(rawDensity?.crossoverStrength),
      shadowCorrection: boundedRgb(rawDensity?.shadowCorrection, defaults.density.shadowCorrection, -2, 2),
      midCorrection: boundedRgb(rawDensity?.midCorrection, migratedMidCorrection(rawDensity), -2, 2),
      highlightCorrection: boundedRgb(rawDensity?.highlightCorrection, defaults.density.highlightCorrection, -2, 2),
      filmStockProfileId: validStockProfileId(rawDensity?.filmStockProfileId),
      filmStockProfileVersion: validStockProfileVersion(rawDensity?.filmStockProfileVersion, rawDensity?.filmStockProfileId),
      separationMatrix: validMatrix9(rawDensity?.separationMatrix),
      lightSourceRgb: validBaseRgb(rawDensity?.lightSourceRgb),
    },
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

export function migrateRecipe(input: unknown): EditRecipe {
  const defaults = createDefaultRecipe();
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Partial<EditRecipe> & {
    schemaVersion?: number;
    crop?: CropRect;
    density?: LegacyDensity & { mode?: string };
    grade?: Partial<EditRecipe['grade']>;
  };
  const crop = raw.crop ?? defaults.crop;
  const curves = raw.grade?.curves;
  const baseRgb = validBaseRgb(raw.baseRgb);
  const densityWithoutEngine = { ...(raw.density ?? {}) };
  delete densityWithoutEngine.engine;
  const anchors = migrateDensityAnchors(raw.density, baseRgb);
  const preserveLegacyAlgorithm = raw.algorithmVersion === 'chromik-5'
    || (raw.algorithmVersion !== 'chromik-6' && (raw.schemaVersion ?? 0) < 6);
  return {
    ...defaults,
    ...raw,
    schemaVersion: preserveLegacyAlgorithm ? 5 : 6,
    algorithmVersion: preserveLegacyAlgorithm ? 'chromik-5' : 'chromik-6',
    baseRgb,
    baseRgbLinear: validLinearRgb(raw.baseRgbLinear),
    crop,
    geometry: {
      ...defaults.geometry,
      ...(raw.geometry ?? {}),
      corners: validQuad(raw.geometry?.corners) ?? rectToQuad(crop),
    },
    density: {
      ...defaults.density,
      ...densityWithoutEngine,
      ...anchors,
      mode: validDensityMode(raw.density?.mode),
      profileId: validProfileId(raw.density?.profileId),
      filmProfileId: validFilmProfileId(raw.density?.filmProfileId, 'unknown'),
      inputTransfer: raw.density?.inputTransfer === 'linear' ? 'linear' : 'srgb',
      separation: migratedSeparation(raw.density),
      neutralProtection: finitePercent(raw.density?.neutralProtection, defaults.density.neutralProtection),
      crossoverStrength: finiteCrossover(raw.density?.crossoverStrength),
      shadowCorrection: boundedRgb(raw.density?.shadowCorrection, defaults.density.shadowCorrection, -2, 2),
      midCorrection: boundedRgb(raw.density?.midCorrection, migratedMidCorrection(raw.density), -2, 2),
      highlightCorrection: boundedRgb(raw.density?.highlightCorrection, defaults.density.highlightCorrection, -2, 2),
      filmStockProfileId: validStockProfileId(raw.density?.filmStockProfileId),
      separationMatrix: validMatrix9(raw.density?.separationMatrix),
      lightSourceRgb: validBaseRgb(raw.density?.lightSourceRgb),
    },
    grade: {
      ...defaults.grade,
      ...(raw.grade ?? {}),
      vibrance: typeof raw.grade?.vibrance === 'number' ? raw.grade.vibrance : defaults.grade.vibrance,
      highlightRolloff: typeof raw.grade?.highlightRolloff === 'number' ? raw.grade.highlightRolloff : defaults.grade.highlightRolloff,
      fade: typeof raw.grade?.fade === 'number' ? raw.grade.fade : defaults.grade.fade,
      look: ['neutral', 'warm_print', 'classic_color', 'cool_slide', 'silver_bw'].includes(raw.grade?.look ?? '')
        ? raw.grade!.look as EditRecipe['grade']['look']
        : defaults.grade.look,
      lookStrength: typeof raw.grade?.lookStrength === 'number' ? Math.max(0, Math.min(100, raw.grade.lookStrength)) : defaults.grade.lookStrength,
      printerLights: raw.grade?.printerLights ?? defaults.grade.printerLights,
      vignette: validVignette(raw.grade?.vignette, defaults.grade.vignette),
      cmy: validCmy(raw.grade?.cmy, defaults.grade.cmy),
      lutId: typeof raw.grade?.lutId === 'string' && raw.grade.lutId.length <= 128 ? raw.grade.lutId : undefined,
      curves: {
        rgb: migrateCurve(curves?.rgb),
        red: migrateCurve(curves?.red),
        green: migrateCurve(curves?.green),
        blue: migrateCurve(curves?.blue),
      },
    },
    spots: validSpots(raw.spots),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

/** Explicit, user-triggered algorithm upgrade. Merely opening a library never calls this. */
export function upgradeRecipeToCurrent(input: EditRecipe): EditRecipe {
  if (input.algorithmVersion === 'chromik-6') return input;
  return {
    ...input,
    schemaVersion: 6,
    algorithmVersion: 'chromik-6',
    baseRgbLinear: input.baseRgbLinear ?? input.baseRgb?.map((value) => srgbSampleToLinear(value / 255)) as RGB | undefined,
    updatedAt: Date.now(),
  };
}

function finitePercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function validProfileId(value: unknown): CaptureProfileId {
  return value === 'scanner_srgb' || value === 'linear_raw' ? value : 'camera_srgb';
}

function validFilmProfileId(value: unknown, filmType: FilmType): EditRecipe['density']['filmProfileId'] {
  return value === 'generic_bw_negative' || value === 'generic_color_negative'
    ? value
    : filmResponseProfileForType(filmType);
}

type LegacyDensity = Partial<EditRecipe['density']> & { engine?: 'classic' | 'adaptive' };

function boundedRgb(value: unknown, fallback: [number, number, number], minimum: number, maximum: number): [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === 'number' && Number.isFinite(channel))
    ? value.map((channel) => Math.max(minimum, Math.min(maximum, channel))) as [number, number, number]
    : [...fallback];
}

function validBaseRgb(value: unknown): EditRecipe['baseRgb'] {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  return value.map((channel) => Math.max(1, Math.min(255, Number(channel) || 1))) as EditRecipe['baseRgb'];
}

function validLinearRgb(value: unknown): EditRecipe['baseRgbLinear'] {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  if (!value.every((channel) => typeof channel === 'number' && Number.isFinite(channel))) return undefined;
  return value.map((channel) => Math.max(1e-6, Math.min(1, channel))) as EditRecipe['baseRgbLinear'];
}

function srgbSampleToLinear(value: number): number {
  const sample = Math.max(0, Math.min(1, value));
  return sample <= 0.04045 ? sample / 12.92 : ((sample + 0.055) / 1.055) ** 2.4;
}

function migrateDensityAnchors(density: LegacyDensity | undefined, baseRgb: EditRecipe['baseRgb']): Pick<EditRecipe['density'], 'low' | 'high'> | Record<string, never> {
  if (density?.engine !== 'classic' || !baseRgb || !Array.isArray(density.low) || !Array.isArray(density.high)) return {};
  const convert = (anchor: number, channel: number) => {
    const base = baseRgb[channel] / 255;
    const encodedSample = Math.max(1e-6, Math.min(1, base * 10 ** -anchor));
    return -Math.log10(Math.max(1e-6, srgbSampleToLinear(encodedSample) / Math.max(1e-6, srgbSampleToLinear(base))));
  };
  return {
    low: density.low.map(convert) as EditRecipe['density']['low'],
    high: density.high.map(convert) as EditRecipe['density']['high'],
  };
}

function migratedSeparation(density: LegacyDensity | undefined): number {
  if (!density || typeof density.separation !== 'number' || !Number.isFinite(density.separation)) return 0;
  // Version 3 shipped a generic 35% matrix by default. It was not measured and
  // could make existing conversions less stable, so only explicit non-default
  // values survive the compatibility migration.
  if (density.engine === undefined && density.separation === 35) return 0;
  return Math.max(0, Math.min(100, density.separation));
}

function validDensityMode(value: unknown): EditRecipe['density']['mode'] {
  return value === 'cineon' ? 'cineon' : 'display_reference';
}

function signedPercent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : fallback;
}

function validVignette(value: unknown, fallback: EditRecipe['grade']['vignette']): EditRecipe['grade']['vignette'] {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Partial<EditRecipe['grade']['vignette']>;
  return {
    strength: signedPercent(raw.strength, fallback.strength),
    midpoint: finitePercent(raw.midpoint, fallback.midpoint),
    roundness: signedPercent(raw.roundness, fallback.roundness),
  };
}

function validCmy(value: unknown, fallback: EditRecipe['grade']['cmy']): EditRecipe['grade']['cmy'] {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Partial<EditRecipe['grade']['cmy']>;
  return {
    cyan: signedPercent(raw.cyan, fallback.cyan),
    magenta: signedPercent(raw.magenta, fallback.magenta),
    yellow: signedPercent(raw.yellow, fallback.yellow),
    density: signedPercent(raw.density, fallback.density),
  };
}

function finiteCrossover(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 1;
}

function validStockProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && getFilmStockProfile(value) ? value : undefined;
}

/**
 * COL-11：只接受当前型号的真实配置版本；旧配方缺失版本时回填当前版本
 * （本代配置尚未发生过破坏性升级，回填不会改变外观；将来升级时在此
 * 按版本分派迁移）。
 */
function validStockProfileVersion(value: unknown, profileId: unknown): string | undefined {
  const profile = validStockProfileId(profileId);
  if (!profile) return undefined;
  const current = getFilmStockProfile(profile)?.version;
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : current;
}

function validMatrix9(value: unknown): Matrix9 | undefined {
  if (!Array.isArray(value) || value.length !== 9) return undefined;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return undefined;
  return value.map((entry) => Math.max(-2, Math.min(2, entry))) as Matrix9;
}

/** Old recipes only stored shadow/highlight corrections; derive a mid anchor. */
function migratedMidCorrection(density: LegacyDensity | undefined): RGB {
  const shadow = Array.isArray(density?.shadowCorrection) && density.shadowCorrection.length === 3 ? density.shadowCorrection : [0, 0, 0];
  const highlight = Array.isArray(density?.highlightCorrection) && density.highlightCorrection.length === 3 ? density.highlightCorrection : [0, 0, 0];
  return shadow.map((value, channel) => (value + (highlight[channel] ?? 0)) / 2) as RGB;
}

function validSpots(value: unknown): DustSpot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const spots: DustSpot[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const spot = item as { x?: unknown; y?: unknown; r?: unknown };
    if (typeof spot.x !== 'number' || typeof spot.y !== 'number' || typeof spot.r !== 'number') continue;
    if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y) || !Number.isFinite(spot.r)) continue;
    spots.push({
      x: Math.max(0, Math.min(1, spot.x)),
      y: Math.max(0, Math.min(1, spot.y)),
      r: Math.max(0.001, Math.min(0.5, spot.r)),
    });
  }
  return spots.length ? spots : undefined;
}
