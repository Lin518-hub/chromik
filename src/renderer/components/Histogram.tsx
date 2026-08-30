import { useCallback, useEffect, useRef, useState } from 'react';
import type { WaveformData } from '../../core/histogram';

interface HistogramProps {
  bins: [number[], number[], number[]] | null;
  waveform?: WaveformData | null;
}

const CHANNEL_COLORS = ['rgba(239, 68, 68, .72)', 'rgba(34, 197, 94, .68)', 'rgba(59, 130, 246, .72)'] as const;

function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const scale = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  return context;
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.save();
  context.strokeStyle = 'rgba(148, 126, 88, .13)';
  context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const x = width * index / 4;
    const y = height * index / 4;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.restore();
}

export function Histogram({ bins, waveform }: HistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'histogram' | 'waveform'>('histogram');
  // BUG-039：ResizeObserver 只挂一次；数据更新经 rAF 去重后重画，
  // 不再随 bins 引用变化反复销毁/重建观察者。
  const latestRef = useRef({ bins, mode, waveform });
  latestRef.current = { bins, mode, waveform };
  const drawFrameRef = useRef<number | undefined>(undefined);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = prepareCanvas(canvas);
    if (!context) return;
    const { width, height } = canvas.getBoundingClientRect();
    drawGrid(context, width, height);
    const current = latestRef.current;

    if (current.mode === 'histogram') {
      if (!current.bins) return;
      const max = Math.max(1, ...current.bins.flat());
      context.globalCompositeOperation = 'multiply';
      current.bins.forEach((channel, channelIndex) => {
        context.beginPath();
        context.moveTo(0, height);
        channel.forEach((count, index) => {
          const x = index / Math.max(1, channel.length - 1) * width;
          const y = height - Math.sqrt(count / max) * (height - 4);
          context.lineTo(x, y);
        });
        context.lineTo(width, height);
        context.closePath();
        context.fillStyle = CHANNEL_COLORS[channelIndex];
        context.fill();
      });
      return;
    }

    if (!current.waveform) return;
    const wave = current.waveform;
    const max = Math.max(1, ...wave.bins.flat());
    const cellWidth = width / wave.columns;
    const cellHeight = height / wave.levels;
    const denominator = Math.max(1, Math.log1p(max));
    context.globalCompositeOperation = 'screen';
    wave.bins.forEach((channel, channelIndex) => {
      context.fillStyle = CHANNEL_COLORS[channelIndex].replace(/\.[0-9]+\)$/, '1)');
      channel.forEach((count, index) => {
        if (!count) return;
        const column = index % wave.columns;
        const level = Math.floor(index / wave.columns);
        context.globalAlpha = Math.min(.8, Math.log1p(count) / denominator * .8);
        context.fillRect(column * cellWidth, level * cellHeight, Math.max(1, cellWidth + .25), Math.max(1, cellHeight + .25));
      });
    });
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }, []);

  const scheduleDraw = useCallback(() => {
    if (drawFrameRef.current !== undefined) return;
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = undefined;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => scheduleDraw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [bins, mode, waveform, scheduleDraw]);

  useEffect(() => () => {
    if (drawFrameRef.current !== undefined) cancelAnimationFrame(drawFrameRef.current);
  }, []);

  return <div className="scope-wrap">
    <div className="scope-tabs" role="tablist" aria-label="色彩监看">
      <button type="button" role="tab" aria-selected={mode === 'histogram'} className={mode === 'histogram' ? 'active' : ''} onClick={() => setMode('histogram')}>直方图</button>
      <button type="button" role="tab" aria-selected={mode === 'waveform'} className={mode === 'waveform' ? 'active' : ''} disabled={!waveform} onClick={() => setMode('waveform')}>RGB 波形</button>
    </div>
    <canvas ref={canvasRef} className="histogram-canvas" aria-label={mode === 'histogram' ? 'RGB 直方图' : 'RGB 波形图'} />
  </div>;
}
