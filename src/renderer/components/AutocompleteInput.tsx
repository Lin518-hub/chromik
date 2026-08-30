import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s._+\-/]/g, '');
}

function score(candidate: string, query: string): number {
  const target = normalize(candidate);
  const needle = normalize(query);
  if (!needle) return 1;
  if (target === needle) return 1000;
  if (target.startsWith(needle)) return 700 - target.length;
  const inside = target.indexOf(needle);
  if (inside >= 0) return 500 - inside * 3 - target.length * .1;
  let cursor = 0;
  let distance = 0;
  for (const char of needle) {
    const next = target.indexOf(char, cursor);
    if (next < 0) return -1;
    distance += next - cursor;
    cursor = next + 1;
  }
  return 250 - distance - target.length * .1;
}

export function AutocompleteInput({ value, suggestions, placeholder, label, onChange }: {
  value: string;
  suggestions: readonly string[];
  placeholder?: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // BUG-038：blur 定时器持有句柄并在卸载时清理；回调内先判 mounted，
  // 不再出现“组件已卸载仍提交输入”的悬挂回调。
  const blurTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (blurTimerRef.current !== undefined) window.clearTimeout(blurTimerRef.current);
  }, []);
  const matches = useMemo(() => suggestions
    .map((item) => ({ item, score: score(item, value) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.item.localeCompare(right.item, 'zh-CN'))
    .slice(0, 8), [suggestions, value]);

  function choose(next: string) {
    window.clearTimeout(blurTimerRef.current);
    onChange(next);
    setOpen(false);
    setActive(0);
  }

  return <div className={`autocomplete-input ${open ? 'open' : ''}`}>
    <div className="autocomplete-field"><Search size={14} /><input value={value} placeholder={placeholder} aria-label={label}
      onFocus={() => setOpen(true)}
      onChange={(event) => { onChange(event.target.value); setOpen(true); setActive(0); }}
      onBlur={() => {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = window.setTimeout(() => {
          blurTimerRef.current = undefined;
          if (!mountedRef.current) return;
          const exact = suggestions.find((item) => normalize(item) === normalize(value));
          if (exact && exact !== value) onChange(exact);
          setOpen(false);
        }, 120);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((index) => Math.min(matches.length - 1, index + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
        else if (event.key === 'Enter' && open && matches[active]) { event.preventDefault(); choose(matches[active].item); }
        else if (event.key === 'Escape') setOpen(false);
      }} /></div>
    {open && <div className="autocomplete-menu glass-surface-strong" role="listbox" aria-label={`${label}建议`}>
      {matches.length ? matches.map(({ item }, index) => <button key={item} type="button" role="option" aria-selected={item === value} className={index === active ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}><span>{item}</span>{item === value && <Check size={14} />}</button>)
        : <div className="autocomplete-empty">没有匹配项，可继续使用自定义内容</div>}
    </div>}
  </div>;
}
