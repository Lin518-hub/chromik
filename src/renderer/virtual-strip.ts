export function calculateVirtualStripWindow(input: {
  itemCount: number;
  itemStep: number;
  viewportWidth: number;
  scrollLeft: number;
  overscan?: number;
}): { startIndex: number; endIndex: number; totalWidth: number } {
  const overscan = input.overscan ?? 3;
  // BUG-053：步长为 0/负值会除零或产生负索引，入口防御性钳制。
  const itemStep = Math.max(1, input.itemStep);
  const startIndex = Math.max(0, Math.floor(input.scrollLeft / itemStep) - overscan);
  const endIndex = Math.min(input.itemCount, Math.ceil((input.scrollLeft + input.viewportWidth) / itemStep) + overscan);
  return { startIndex, endIndex, totalWidth: input.itemCount * itemStep };
}
