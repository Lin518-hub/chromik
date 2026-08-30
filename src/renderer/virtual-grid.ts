export interface VirtualGridInput {
  itemCount: number;
  containerWidth: number;
  viewportHeight: number;
  scrollTop: number;
  minimumColumnWidth: number;
  gap: number;
  thumbnailHeightRatio: number;
  metadataHeight: number;
  listMode: boolean;
  listItemHeight: number;
  overscanRows?: number;
}

export interface VirtualGridWindow {
  columns: number;
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
  rowHeight: number;
}

/** Pure layout math shared by the React virtual grid and its 1000-card test. */
export function calculateVirtualGridWindow(input: VirtualGridInput): VirtualGridWindow {
  const width = Math.max(1, input.containerWidth - 6);
  const gap = Math.max(0, input.gap);
  const columns = input.listMode
    ? 1
    : Math.max(1, Math.floor((width + gap) / (Math.max(1, input.minimumColumnWidth) + gap)));
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const cardHeight = input.listMode
    ? Math.max(1, input.listItemHeight)
    : Math.max(1, columnWidth * input.thumbnailHeightRatio + input.metadataHeight);
  const rowHeight = cardHeight + gap;
  const rows = Math.ceil(Math.max(0, input.itemCount) / columns);
  const overscan = Math.max(0, input.overscanRows ?? 2);
  const startRow = Math.max(0, Math.floor(Math.max(0, input.scrollTop) / rowHeight) - overscan);
  const visibleRows = Math.ceil(Math.max(1, input.viewportHeight) / rowHeight) + overscan * 2;
  const endRow = Math.min(rows, startRow + visibleRows);
  return {
    columns,
    startIndex: Math.min(input.itemCount, startRow * columns),
    endIndex: Math.min(input.itemCount, endRow * columns),
    offsetTop: startRow * rowHeight,
    totalHeight: Math.max(0, rows * rowHeight - gap),
    rowHeight,
  };
}
