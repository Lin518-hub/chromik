import type { CaptureProfileId, InputTransfer } from './types';

export interface CaptureProfile {
  id: CaptureProfileId;
  label: string;
  shortLabel: string;
  description: string;
  inputTransfer: InputTransfer;
  basePercentile: number;
  whiteBalanceLimit: number;
  version: 'generic-1';
}

/**
 * Versioned, testable generic input configurations. These are deliberately not
 * advertised as measured camera or film-stock profiles. A measured ICC/DCP
 * workflow can be added without changing saved recipe semantics later.
 */
export const CAPTURE_PROFILES: Record<CaptureProfileId, CaptureProfile> = {
  camera_srgb: {
    id: 'camera_srgb',
    label: '手机 / 相机翻拍',
    shortLabel: '翻拍',
    description: '适用于手机 HEIC/JPEG 和相机导出的常规 sRGB 图像。',
    inputTransfer: 'srgb',
    basePercentile: 0.62,
    whiteBalanceLimit: 0.08,
    version: 'generic-1',
  },
  scanner_srgb: {
    id: 'scanner_srgb',
    label: '扫描仪文件',
    shortLabel: '扫描',
    description: '适用于扫描软件生成的 TIFF、PNG 或 JPEG。',
    inputTransfer: 'srgb',
    basePercentile: 0.7,
    whiteBalanceLimit: 0.05,
    version: 'generic-1',
  },
  linear_raw: {
    id: 'linear_raw',
    label: '线性 RGB 中间文件',
    shortLabel: '线性',
    description: '仅用于已明确导出为线性 RGB 的 16 位中间文件。',
    inputTransfer: 'linear',
    basePercentile: 0.64,
    whiteBalanceLimit: 0.06,
    version: 'generic-1',
  },
};

export function getCaptureProfile(id: CaptureProfileId): CaptureProfile {
  return CAPTURE_PROFILES[id];
}
