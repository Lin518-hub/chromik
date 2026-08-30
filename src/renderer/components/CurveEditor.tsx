import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CurvePoint, CurvePoints } from '../../shared/types';

interface CurveEditorProps {
  channel: 'rgb' | 'red' | 'green' | 'blue';
  points: CurvePoints;
  onChange: (points: CurvePoints) => void;
}

const colours = { rgb: '#B87512', red: '#DC2626', green: '#16A34A', blue: '#2563EB' };

function pointerPoint(event: React.PointerEvent<SVGSVGElement>, svg: SVGSVGElement): CurvePoint {
  const bounds = svg.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height)),
  };
}

export function CurveEditor({ channel, points, onChange }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const [dragIndex, setDragIndex] = useState<number>();

  useEffect(() => {
    setSelectedIndex(undefined);
    setDragIndex(undefined);
  }, [channel]);

  function updateFromPointer(event: React.PointerEvent<SVGSVGElement>, index: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const pointer = pointerPoint(event, svg);
    const next = points.map((point) => ({ ...point }));
    const endpoint = index === 0 || index === points.length - 1;
    // BUG-034：相邻锚点间距 <0.024 时上下界反转会越过右邻、打乱顺序；
    // 这种情况只更新 y，保持 x 单调。
    const leftBound = index > 0 ? next[index - 1].x + .012 : 0;
    const rightBound = index < points.length - 1 ? next[index + 1].x - .012 : 1;
    next[index] = {
      x: endpoint || rightBound - leftBound < 0 ? next[index].x
        : Math.max(leftBound, Math.min(rightBound, pointer.x)),
      y: pointer.y,
    };
    onChange(next);
  }

  function addPoint(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || (event.target as Element).tagName === 'circle') return;
    const svg = svgRef.current;
    if (!svg || points.length >= 16) return;
    const point = pointerPoint(event, svg);
    const next = [...points.map((item) => ({ ...item })), point].sort((a, b) => a.x - b.x);
    const index = next.indexOf(point);
    if (index === 0 || index === next.length - 1 || Math.abs(next[index - 1].x - point.x) < .012 || Math.abs(next[index + 1].x - point.x) < .012) return;
    onChange(next);
    setSelectedIndex(index);
  }

  function deleteSelected() {
    if (selectedIndex === undefined || selectedIndex === 0 || selectedIndex === points.length - 1) return;
    onChange(points.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(undefined);
  }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (selectedIndex === undefined) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      // BUG-035：svg 可聚焦（tabIndex=0），焦点落在编辑器内或删除按钮上时
      // 即可删除选中锚点；其余控件保持原有键盘行为。
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.curve-editor') && !target.classList.contains('curve-delete-button')) return;
      event.preventDefault();
      deleteSelected();
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [points, selectedIndex, onChange]);

  const coordinates = points.map((point) => `${point.x * 100},${100 - point.y * 100}`).join(' ');
  const canDelete = selectedIndex !== undefined && selectedIndex > 0 && selectedIndex < points.length - 1;

  return <>
    <svg
      ref={svgRef}
      className="curve-editor"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      tabIndex={0}
      role="application"
      aria-label="曲线编辑器：点击添加锚点，拖动移动，Delete 删除选中锚点"
      onPointerDown={addPoint}
      onPointerMove={(event) => dragIndex !== undefined && updateFromPointer(event, dragIndex)}
      onPointerUp={() => setDragIndex(undefined)}
      onPointerCancel={() => setDragIndex(undefined)}
    >
      <rect width="100" height="100" className="curve-hit-area" />
      {[25, 50, 75].map((value) => <path key={`v${value}`} d={`M${value} 0V100 M0 ${value}H100`} className="curve-grid" />)}
      <path d="M0 100L100 0" className="curve-reference" />
      <polyline points={coordinates} fill="none" stroke={colours[channel]} strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
      {points.map((point, index) => (
        <circle
          key={`${index}-${point.x.toFixed(4)}`}
          className={selectedIndex === index ? 'selected' : ''}
          cx={point.x * 100}
          cy={100 - point.y * 100}
          r="2.2"
          fill="#fff"
          stroke={colours[channel]}
          strokeWidth="1.3"
          vectorEffect="non-scaling-stroke"
          onDoubleClick={() => { setSelectedIndex(index); if (index > 0 && index < points.length - 1) onChange(points.filter((_, itemIndex) => itemIndex !== index)); }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            setSelectedIndex(index);
            setDragIndex(index);
          }}
        />
      ))}
    </svg>
    <div className="curve-help"><span>点击曲线添加锚点 · 拖动调整</span><button className="curve-delete-button" disabled={!canDelete} onClick={deleteSelected}><Trash2 size={12} />删除锚点</button></div>
  </>;
}
