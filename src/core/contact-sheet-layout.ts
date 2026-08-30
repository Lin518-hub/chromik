import type { ContactSheetConfig } from '../shared/types';

// Sharp/libvips has pixel and dimension limits. Keeping every page below 30k
// pixels also bounds the composite list and peak memory for very large rolls.
export const CONTACT_SHEET_MAX_PAGE_HEIGHT = 30_000;

export interface ContactSheetLayout {
  scale: 1 | 2 | 3;
  cellWidth: number;
  cellHeight: number;
  headerHeight: number;
  footerHeight: number;
  pageCapacity: number;
}

export function contactSheetLayout(config: ContactSheetConfig): ContactSheetLayout {
  const scale = (config.resolution === 'preview' ? 1 : config.resolution === 'standard' ? 2 : 3) as 1 | 2 | 3;
  // BUG-028：columns 为 0 会让 pageCapacity 为 0、分页死循环、worker 内
  // 取模得 NaN。IPC 层已限定 3-6 列，这里保留最后一层防御纵深。
  const columns = Math.max(1, Math.floor(config.columns));
  const labelHeight = (config.showFileName || config.showMetadata ? 46 : 10) * scale;
  const cellHeight = 190 * scale + labelHeight;
  const headerHeight = 96 * scale;
  const footerHeight = 28 * scale;
  const rowsPerPage = Math.max(1, Math.floor((CONTACT_SHEET_MAX_PAGE_HEIGHT - headerHeight - footerHeight) / cellHeight));
  return {
    scale,
    cellWidth: 310 * scale,
    cellHeight,
    headerHeight,
    footerHeight,
    pageCapacity: rowsPerPage * columns,
  };
}

export function paginateContactSheet<T>(items: readonly T[], config: ContactSheetConfig): T[][] {
  const capacity = contactSheetLayout(config).pageCapacity;
  const pages: T[][] = [];
  for (let offset = 0; offset < items.length; offset += capacity) pages.push(items.slice(offset, offset + capacity));
  return pages;
}
