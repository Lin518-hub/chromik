import { useEffect, useRef, useState } from 'react';

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: (value: number) => string;
  onChange: (value: number) => void;
  onReset?: () => void;
}

export function RangeControl({ label, value, min, max, step = 1, display, onChange, onReset }: RangeControlProps) {
  const pendingRef = useRef<number | undefined>(undefined);
  const animationFrameRef = useRef<number | undefined>(undefined);
  // BUG-041：拖动期间用本地 pending 值驱动滑杆与数值显示，受控 value 在
  // rAF 提交前的这一帧不回跳，消除拖动抖动。
  const [dragValue, setDragValue] = useState<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const available = max - min;
  const shown = dragValue ?? value;
  const progress = available > 0 ? Math.max(0, Math.min(100, ((shown - min) / available) * 100)) : 0;
  const formatted = display ? display(shown) : shown > 0 ? `+${shown}` : String(shown);

  function flush() {
    if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = undefined;
    if (pendingRef.current === undefined) return;
    const next = pendingRef.current;
    pendingRef.current = undefined;
    setDragValue(undefined);
    onChangeRef.current(next);
  }

  function schedule(next: number) {
    setDragValue(next);
    pendingRef.current = next;
    if (animationFrameRef.current !== undefined) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = undefined;
      if (pendingRef.current === undefined) return;
      const pending = pendingRef.current;
      pendingRef.current = undefined;
      setDragValue(undefined);
      onChangeRef.current(pending);
    });
  }

  useEffect(() => () => {
    if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
    // 卸载时把最后未提交的值刷出去，拖动中途切视图不丢失调整。
    if (pendingRef.current !== undefined) onChangeRef.current(pendingRef.current);
    pendingRef.current = undefined;
  }, []);

  return (
    <div className="range-row">
      <label title="双击名称复位" onDoubleClick={onReset}>{label}</label>
      <div className="range-track">
        <input
          aria-label={label}
          aria-valuetext={formatted}
          className="range-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          disabled={available <= 0}
          style={{ '--range-progress': `${progress}%` } as React.CSSProperties}
          onChange={(event) => schedule(Number(event.target.value))}
          onPointerUp={flush}
          onPointerCancel={flush}
          onBlur={flush}
          onDoubleClick={onReset}
        />
      </div>
      <output>{formatted}</output>
    </div>
  );
}
