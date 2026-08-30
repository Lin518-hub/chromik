import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { calculateVirtualStripWindow } from '../virtual-strip';

export function VirtualFilmstrip<T>({
  items, itemKey, selectedIndex, renderItem, itemWidth = 92, gap = 7,
}: {
  items: T[];
  itemKey: (item: T) => string;
  selectedIndex: number;
  renderItem: (item: T, index: number) => ReactNode;
  itemWidth?: number;
  gap?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const [viewport, setViewport] = useState({ width: 1, scrollLeft: 0 });
  const itemStep = itemWidth + gap;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setViewport((current) => ({ ...current, width: container.clientWidth }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || selectedIndex < 0) return;
    const left = selectedIndex * itemStep;
    const right = left + itemWidth;
    if (left < container.scrollLeft) container.scrollTo({ left, behavior: 'smooth' });
    else if (right > container.scrollLeft + container.clientWidth) container.scrollTo({ left: right - container.clientWidth, behavior: 'smooth' });
  }, [itemStep, itemWidth, selectedIndex]);

  const windowed = useMemo(() => calculateVirtualStripWindow({
    itemCount: items.length, itemStep, viewportWidth: viewport.width, scrollLeft: viewport.scrollLeft,
  }), [itemStep, items.length, viewport]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const scrollLeft = event.currentTarget.scrollLeft;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => setViewport((current) => current.scrollLeft === scrollLeft ? current : { ...current, scrollLeft }));
  };

  useEffect(() => () => { if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current); }, []);

  return <div ref={containerRef} className="filmstrip virtual-filmstrip" onScroll={onScroll} role="list" aria-label={`处理后画面，共 ${items.length} 张`}>
    <div className="virtual-filmstrip-track" style={{ width: windowed.totalWidth }}>
      {items.slice(windowed.startIndex, windowed.endIndex).map((item, offset) => {
        const index = windowed.startIndex + offset;
        return <div key={itemKey(item)} className="virtual-filmstrip-cell" style={{ left: index * itemStep, width: itemWidth }} role="listitem">{renderItem(item, index)}</div>;
      })}
    </div>
  </div>;
}
