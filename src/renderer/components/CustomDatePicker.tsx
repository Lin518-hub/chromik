import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function todayString(): string { return formatLocalDate(new Date()); }

export function CustomDatePicker({ value, onChange, label = '拍摄日期' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => { const date = parseDate(value); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const [rect, setRect] = useState<DOMRect>();
  const [activeDay, setActiveDay] = useState<number | undefined>(value ? parseDate(value).getDate() : undefined);
  const selected = value ? parseDate(value) : undefined;
  const today = new Date();
  const days = useMemo(() => {
    const firstWeekday = (month.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(firstWeekday).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
  }, [month]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setRect(triggerRef.current?.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && (triggerRef.current?.contains(event.target) || event.target.closest('.custom-date-popover'))) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // BUG-047：Escape 关闭后把焦点还给触发按钮（与 CustomSelect 一致）。
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const dayCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      setActiveDay((current) => {
        const base = current ?? selected?.getDate() ?? new Date().getDate();
        switch (event.key) {
          case 'ArrowLeft': return Math.max(1, base - 1);
          case 'ArrowRight': return Math.min(dayCount, base + 1);
          case 'ArrowUp': return Math.max(1, base - 7);
          case 'ArrowDown': return Math.min(dayCount, base + 7);
          case 'Home': return 1;
          case 'End': return dayCount;
          default: return base;
        }
      });
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key); };
  }, [month, open, selected?.getDate()]);

  function choose(day: number) {
    onChange(formatLocalDate(new Date(month.getFullYear(), month.getMonth(), day)));
    setOpen(false);
    triggerRef.current?.focus();
  }

  return <>
    <button ref={triggerRef} type="button" className={`custom-date-trigger ${open ? 'open' : ''}`} aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((state) => !state)}><CalendarDays size={15} /><span>{value || '选择日期'}</span></button>
    {open && rect && createPortal(<div className="custom-date-popover glass-surface-strong" role="dialog" aria-label={label} style={{ left: Math.min(rect.left, window.innerWidth - 292), top: Math.min(rect.bottom + 7, window.innerHeight - 350) }}>
      <header><button aria-label="上个月" onClick={() => setMonth((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}><ChevronLeft size={16} /></button><b>{month.getFullYear()} 年 {month.getMonth() + 1} 月</b><button aria-label="下个月" onClick={() => setMonth((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}><ChevronRight size={16} /></button></header>
      <div className="custom-date-week">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="custom-date-grid" role="grid" aria-label={`${label}日期网格`}>{days.map((day, index) => day === null ? <i key={`blank-${index}`} /> : <button
        key={day}
        role="gridcell"
        aria-selected={selected?.getFullYear() === month.getFullYear() && selected.getMonth() === month.getMonth() && selected.getDate() === day}
        aria-label={`${month.getFullYear()} 年 ${month.getMonth() + 1} 月 ${day} 日`}
        className={`${selected?.getFullYear() === month.getFullYear() && selected.getMonth() === month.getMonth() && selected.getDate() === day ? 'selected' : ''} ${today.getFullYear() === month.getFullYear() && today.getMonth() === month.getMonth() && today.getDate() === day ? 'today' : ''} ${activeDay === day ? 'active' : ''}`}
        onClick={() => choose(day)}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(day); } }}
      >{day}</button>)}</div>
      <footer><button onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); onChange(formatLocalDate(now)); setOpen(false); triggerRef.current?.focus(); }}>今天</button><button onClick={() => { onChange(''); setOpen(false); triggerRef.current?.focus(); }}>清除</button></footer>
    </div>, document.body)}
  </>;
}
