import { describe, expect, it } from 'vitest';
import { CONTACT_SHEET_MAX_PAGE_HEIGHT, contactSheetLayout, paginateContactSheet } from './contact-sheet-layout';
import type { ContactSheetConfig } from '../shared/types';

const config: ContactSheetConfig = {
  style: 'classic', resolution: 'best', columns: 3, showFileName: true, showMetadata: true, title: '', format: 'jpeg',
};

describe('contact sheet pagination', () => {
  it('bounds every best-quality page below the libvips-safe height', () => {
    const layout = contactSheetLayout(config);
    const pageHeight = layout.headerHeight + Math.ceil(layout.pageCapacity / config.columns) * layout.cellHeight + layout.footerHeight;
    expect(pageHeight).toBeLessThanOrEqual(CONTACT_SHEET_MAX_PAGE_HEIGHT);
    expect(layout.pageCapacity).toBeGreaterThan(100);
  });

  it('splits a 1000-frame roll without dropping or duplicating frames', () => {
    const source = Array.from({ length: 1000 }, (_, index) => index);
    const pages = paginateContactSheet(source, config);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(source);
    expect(pages.every((page) => page.length <= contactSheetLayout(config).pageCapacity)).toBe(true);
  });
});
