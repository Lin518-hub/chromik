import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export function InfoTip({ text }: { text: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const bounds = anchorRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const popoverWidth = popoverRef.current?.offsetWidth ?? 232;
    const popoverHeight = popoverRef.current?.offsetHeight ?? 80;
    const padding = 8;
    const gap = 8;
    const spaceBelow = window.innerHeight - bounds.bottom - gap;
    const spaceAbove = bounds.top - gap;
    const below = spaceBelow >= popoverHeight || spaceBelow >= spaceAbove;
    setPosition({
      left: Math.max(padding + popoverWidth / 2, Math.min(window.innerWidth - padding - popoverWidth / 2, bounds.left + bounds.width / 2)),
      top: Math.max(padding, Math.min(window.innerHeight - padding - popoverHeight, below ? bounds.bottom + gap : bounds.top - gap - popoverHeight)),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, text, updatePosition]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    window.addEventListener('keydown', keyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', keyDown);
    };
  }, [open, updatePosition]);

  function togglePinned() {
    // BUG-046：setState updater 必须保持纯函数——拆成两次独立 setState，
    // StrictMode 双调用与并发渲染下语义稳定。
    const next = !pinned;
    setPinned(next);
    setOpen(next);
  }

  return (
    <>
      <span ref={anchorRef} className="info-tip" role="button" tabIndex={0} aria-label={`说明：${text}`} aria-expanded={open} aria-describedby={open ? tooltipId : undefined} onClick={(event) => { event.preventDefault(); event.stopPropagation(); togglePinned(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePinned(); } }} onMouseEnter={() => { updatePosition(); setOpen(true); }} onMouseLeave={() => { if (!pinned) setOpen(false); }} onFocus={() => { updatePosition(); setOpen(true); }} onBlur={() => { setPinned(false); setOpen(false); }}>
        <Info size={15} />
      </span>
      {open && createPortal(<span ref={popoverRef} id={tooltipId} className="info-tip-popover" style={position} role="tooltip">{text}</span>, document.body)}
    </>
  );
}
