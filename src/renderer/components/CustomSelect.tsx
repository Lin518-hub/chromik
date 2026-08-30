import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface CustomSelectOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
}

export function CustomSelect<T extends string | number>({ value, options, onChange, label, className = '' }: {
  value: T;
  options: ReadonlyArray<CustomSelectOption<T>>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect>();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, selectedIndex));
  // BUG-052：父级内联 options 数组不再导致 document 监听反复重挂——用 ref
  // 持最新引用，keydown 处理器只依赖 open/activeIndex/onChange。
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!open) setActiveIndex(Math.max(0, selectedIndex));
  }, [open, selectedIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setRect(buttonRef.current?.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && (buttonRef.current?.contains(event.target) || event.target.closest('.custom-select-menu'))) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      const currentOptions = optionsRef.current;
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); return; }
      if (!currentOptions.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + currentOptions.length) % currentOptions.length);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setActiveIndex(event.key === 'Home' ? 0 : currentOptions.length - 1);
      } else if (event.key === 'Enter' || event.code === 'Space') {
        event.preventDefault();
        const option = currentOptions[activeIndex];
        if (option) onChangeRef.current(option.value);
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key);
    };
  }, [activeIndex, open]);

  const openFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const menuHeight = Math.min(320, Math.max(46, options.length * 46 + 12));
  const menuTop = rect
    ? rect.bottom + 7 + menuHeight <= window.innerHeight - 10
      ? rect.bottom + 7
      : Math.max(10, rect.top - menuHeight - 7)
    : 0;

  return <>
    <button ref={buttonRef} type="button" className={`custom-select-trigger ${open ? 'open' : ''} ${!selected ? 'invalid-value' : ''} ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onKeyDown={openFromKeyboard} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? `已失效：${String(value)}`}</span><ChevronDown size={15} />
    </button>
    {open && rect && createPortal(<div className="custom-select-menu glass-surface-strong" role="listbox" aria-label={label} aria-activedescendant={`${label}-option-${activeIndex}`} style={{ left: Math.max(10, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 12)), top: menuTop, width: Math.max(rect.width, 220), maxHeight: menuHeight }}>
      {options.map((option, index) => <button id={`${label}-option-${index}`} key={String(option.value)} type="button" role="option" tabIndex={-1} aria-selected={option.value === value} className={`${option.value === value ? 'selected' : ''} ${activeIndex === index ? 'active' : ''}`} onPointerEnter={() => setActiveIndex(index)} onClick={() => { onChange(option.value); setOpen(false); buttonRef.current?.focus(); }}>
        <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={15} />}
      </button>)}
    </div>, document.body)}
  </>;
}
