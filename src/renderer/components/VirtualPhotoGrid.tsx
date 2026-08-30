import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from 'react';
import { calculateVirtualGridWindow } from '../virtual-grid';

interface VirtualPhotoGridProps<T> {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
  style?: CSSProperties;
  layoutMode: 'grid' | 'list';
  minimumColumnWidth: number;
  gap: number;
  thumbnailHeightRatio: number;
  metadataHeight: number;
  listItemHeight: number;
  ariaLabel: string;
}

export function VirtualPhotoGrid<T>({
  items, itemKey, renderItem, className = '', style, layoutMode, minimumColumnWidth, gap,
  thumbnailHeightRatio, metadataHeight, listItemHeight, ariaLabel,
}: VirtualPhotoGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const [viewport, setViewport] = useState({ width: 1, height: 1, scrollTop: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setViewport((current) => ({
      width: container.clientWidth,
      height: container.clientHeight,
      scrollTop: Math.min(current.scrollTop, container.scrollHeight),
    }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const windowed = useMemo(() => calculateVirtualGridWindow({
    itemCount: items.length,
    containerWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollTop: viewport.scrollTop,
    minimumColumnWidth,
    gap,
    thumbnailHeightRatio,
    metadataHeight,
    listMode: layoutMode === 'list',
    listItemHeight,
  }), [gap, items.length, layoutMode, listItemHeight, metadataHeight, minimumColumnWidth, thumbnailHeightRatio, viewport]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      setViewport((current) => current.scrollTop === next ? current : { ...current, scrollTop: next });
    });
  };

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
  }, []);

  const visible = items.slice(windowed.startIndex, windowed.endIndex);
  const rowCount = Math.ceil(items.length / Math.max(1, windowed.columns));
  return <div
    ref={containerRef}
    className={`photo-grid virtual-photo-grid library-${layoutMode} ${className}`}
    style={style}
    onScroll={onScroll}
    role="grid"
    aria-label={ariaLabel}
    aria-rowcount={rowCount}
    aria-colcount={windowed.columns}
    data-item-count={items.length}
  >
    <div className="virtual-photo-spacer" style={{ height: windowed.totalHeight }}>
      <div
        className={`virtual-photo-window library-${layoutMode}`}
        style={{
          top: windowed.offsetTop,
          gridTemplateColumns: layoutMode === 'grid' ? `repeat(${windowed.columns}, minmax(0, 1fr))` : undefined,
          gap,
        }}
      >
        {visible.map((item, cellIndex) => {
          // Map the flat virtualized index back to (rowIndex, columnIndex)
          // so a screen reader reports the cell position a sighted user sees.
          const absoluteIndex = windowed.startIndex + cellIndex;
          const rowIndex = Math.floor(absoluteIndex / Math.max(1, windowed.columns));
          const columnIndex = layoutMode === 'list' ? 1 : (absoluteIndex % windowed.columns) + 1;
          return (
            <div key={itemKey(item)} className="virtual-photo-cell" role="row" aria-rowindex={rowIndex + 1}>
              <div className="virtual-photo-cell-inner" role="gridcell" aria-colindex={columnIndex}>{renderItem(item)}</div>
            </div>
          );
        })}
      </div>
    </div>
  </div>;
}
