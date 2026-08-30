import type { FilmResponseProfileId, FilmType } from './types';

export interface FilmResponseProfile {
  id: FilmResponseProfileId;
  label: string;
  description: string;
  filmTypes: FilmType[];
  lowPercentile: number;
  highPercentile: number;
  minimumDensitySpan: number;
  crossoverCorrection: boolean;
  measured: false;
  version: 'generic-1';
}

/**
 * Auditable generic response settings, not measured stock simulations. Their
 * purpose is to keep automatic-analysis constants versioned and replaceable
 * when real sensitometry/spectral measurements become available.
 */
export const FILM_RESPONSE_PROFILES: Record<FilmResponseProfileId, FilmResponseProfile> = {
  generic_color_negative: {
    id: 'generic_color_negative',
    label: '通用彩色负片',
    description: '彩色负片通用密度范围，并启用有上限的阴影/高光交叉色偏估算。',
    filmTypes: ['color_negative'],
    lowPercentile: 0.005,
    highPercentile: 0.99,
    minimumDensitySpan: 0.18,
    crossoverCorrection: true,
    measured: false,
    version: 'generic-1',
  },
  generic_bw_negative: {
    id: 'generic_bw_negative',
    label: '通用黑白负片',
    description: '黑白负片通用密度范围；不从场景颜色估算交叉色偏。',
    filmTypes: ['bw_negative'],
    lowPercentile: 0.005,
    highPercentile: 0.99,
    minimumDensitySpan: 0.2,
    crossoverCorrection: false,
    measured: false,
    version: 'generic-1',
  },
};

export function filmResponseProfileForType(filmType: FilmType): FilmResponseProfileId {
  return filmType === 'bw_negative' || filmType === 'bw_slide' ? 'generic_bw_negative' : 'generic_color_negative';
}

export function getFilmResponseProfile(id: FilmResponseProfileId): FilmResponseProfile {
  return FILM_RESPONSE_PROFILES[id];
}
