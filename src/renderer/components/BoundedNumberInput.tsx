import { useEffect, useRef, useState } from 'react';

interface BoundedNumberInputProps {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  className?: string;
  step?: number;
  scrubbable?: boolean;
  'aria-label'?: string;
  onChange: (value: number) => void;
}

export function BoundedNumberInput(props: BoundedNumberInputProps) {
  const [draft, setDraft] = useState(String(props.value));
  const [scrubbing, setScrubbing] = useState(false);
  const focused = useRef(false);
  const drag = useRef<{ x: number; value: number } | undefined>(undefined);

  useEffect(() => {
    if (!focused.current) setDraft(String(props.value));
  }, [props.value]);

  // BUG-036：按 step 量化而不是一刀切取整，非整数 step 的参数（如 0.1/0.01）
  // 不再被静默吞掉小数。
  function quantize(parsed: number): number {
    const step = props.step ?? 1;
    if (!Number.isFinite(step) || step <= 0) return Math.round(parsed);
    return Math.round(parsed / step) * step;
  }

  function commit(input = draft) {
    const parsed = Number(input);
    const next = Number.isFinite(parsed) && input.trim() !== ''
      ? quantize(Math.max(props.min, Math.min(props.max, parsed)))
      : props.value;
    setDraft(String(next));
    if (next !== props.value) props.onChange(next);
  }

  return <input
    type="number"
    className={`${props.className ?? ''} ${props.scrubbable ? 'scrubbable-number' : ''} ${scrubbing ? 'scrubbing' : ''}`.trim()}
    min={props.min}
    max={props.max}
    step={props.step ?? 1}
    disabled={props.disabled}
    value={draft}
    aria-label={props['aria-label']}
    onFocus={() => { focused.current = true; }}
    onChange={(event) => {
      const next = event.target.value;
      setDraft(next);
      if (next.trim() === '') return;
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed >= props.min && parsed <= props.max) props.onChange(quantize(parsed));
    }}
    onBlur={() => { focused.current = false; commit(); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    onPointerDown={(event) => {
      if (!props.scrubbable || props.disabled || event.button !== 0) return;
      drag.current = { x: event.clientX, value: props.value };
      event.currentTarget.setPointerCapture(event.pointerId);
      setScrubbing(true);
    }}
    onPointerMove={(event) => {
      if (!props.scrubbable || !drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const step = props.step ?? 1;
      const delta = Math.round((event.clientX - drag.current.x) / 4) * step;
      const next = Math.max(props.min, Math.min(props.max, drag.current.value + delta));
      setDraft(String(next));
      if (next !== props.value) props.onChange(next);
    }}
    onPointerUp={(event) => {
      if (!drag.current) return;
      drag.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setScrubbing(false);
    }}
    onPointerCancel={() => { drag.current = undefined; setScrubbing(false); }}
  />;
}
