import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { FrameSummary } from '../../shared/types';
import { calculateFitZoom, zoomAroundPoint, type ViewTransform } from '../viewport';

interface ExportPreviewProps {
  frame: FrameSummary;
  rollName: string;
  systemGestures: boolean;
}

export function ExportPreview({ frame, rollName, systemGestures }: ExportPreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fitModeRef = useRef(true);
  const proofRequestRef = useRef(0);
  const panRef = useRef<{ pointerId: number; clientX: number; clientY: number; start: ViewTransform } | undefined>(undefined);
  const [naturalSize, setNaturalSize] = useState({ width: frame.width, height: frame.height });
  const [view, setView] = useState<ViewTransform>({ zoom: 1, x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [proof, setProof] = useState<{ url: string; width: number; height: number }>();
  const [proofLoading, setProofLoading] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [imageError, setImageError] = useState(false);
  // BUG-037：平移/缩放按 rAF 合并提交，高 DPR 下不再以鼠标事件频率整幅重渲染。
  const pendingViewRef = useRef<ViewTransform | undefined>(undefined);
  const viewFrameRef = useRef<number | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const flushView = useCallback(() => {
    if (viewFrameRef.current !== undefined) cancelAnimationFrame(viewFrameRef.current);
    viewFrameRef.current = undefined;
    if (pendingViewRef.current) {
      setView(pendingViewRef.current);
      pendingViewRef.current = undefined;
    }
  }, []);
  const scheduleView = useCallback((next: ViewTransform) => {
    pendingViewRef.current = next;
    if (viewFrameRef.current !== undefined) return;
    viewFrameRef.current = requestAnimationFrame(() => flushView());
  }, [flushView]);
  useEffect(() => () => {
    if (viewFrameRef.current !== undefined) cancelAnimationFrame(viewFrameRef.current);
  }, []);

  const fitView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    fitModeRef.current = true;
    setView({ zoom: calculateFitZoom(stage.clientWidth, stage.clientHeight, naturalSize.width, naturalSize.height, 44), x: 0, y: 0 });
  }, [naturalSize.height, naturalSize.width]);

  useEffect(() => {
    proofRequestRef.current += 1;
    fitModeRef.current = true;
    setProof(undefined);
    setProofLoading(false);
    setImageReady(false);
    setImageError(false);
    setNaturalSize({ width: frame.width, height: frame.height });
  }, [frame.height, frame.id, frame.recipe.updatedAt, frame.width]);

  useEffect(() => { if (fitModeRef.current) fitView(); }, [fitView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => fitModeRef.current && fitView());
    observer.observe(stage);
    const wheel = (event: WheelEvent) => {
      if (event.cancelable) event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      fitModeRef.current = false;
      const precisePan = systemGestures && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && !event.ctrlKey
        && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 80);
      if (precisePan) {
        scheduleView({ ...viewRef.current, x: viewRef.current.x - event.deltaX, y: viewRef.current.y - event.deltaY });
        return;
      }
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? .008 : .0015));
      scheduleView(zoomAroundPoint(viewRef.current, viewRef.current.zoom * factor,
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        { width: bounds.width, height: bounds.height }));
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); stage.removeEventListener('wheel', wheel); };
  }, [fitView, systemGestures]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => target instanceof HTMLElement
      && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName);
    const down = (event: KeyboardEvent) => { if (event.code === 'Space' && !isEditable(event.target)) { event.preventDefault(); setSpacePressed(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePressed(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  function zoom(factor: number) {
    const stage = stageRef.current;
    if (!stage) return;
    fitModeRef.current = false;
    setView((current) => zoomAroundPoint(current, current.zoom * factor,
      { x: stage.clientWidth / 2, y: stage.clientHeight / 2 },
      { width: stage.clientWidth, height: stage.clientHeight }));
  }

  function showActualSize() {
    fitModeRef.current = false;
    if (proof) {
      setView({ zoom: 1, x: 0, y: 0 });
      return;
    }
    const requestId = ++proofRequestRef.current;
    setProofLoading(true);
    setImageError(false);
    void window.filmLab.renderProofPreview(frame.id, frame.recipe).then((result) => {
      if (requestId !== proofRequestRef.current) return;
      setImageReady(false);
      setProof(result);
      setNaturalSize({ width: result.width, height: result.height });
      setView({ zoom: 1, x: 0, y: 0 });
    }).catch((error) => {
      if (requestId !== proofRequestRef.current) return;
      console.error('Chromik export full-resolution proof failed', error);
      setImageError(true);
    }).finally(() => {
      if (requestId === proofRequestRef.current) setProofLoading(false);
    });
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 1 && !(event.button === 0 && spacePressed)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    fitModeRef.current = false;
    panRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: view };
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    scheduleView({ ...pan.start, x: pan.start.x + event.clientX - pan.clientX, y: pan.start.y + event.clientY - pan.clientY });
  }

  function pointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = undefined;
  }

  return <div ref={stageRef} className={`export-preview glass-surface ${spacePressed ? 'space-pan-ready' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onAuxClick={(event) => event.preventDefault()}>
    <div className="export-preview-media" style={{ width: naturalSize.width, height: naturalSize.height, transform: `translate(-50%, -50%) translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})` }}>
      <img src={proof?.url ?? `${frame.processedPreviewUrl}&priority=hero`} draggable={false} alt={`${frame.name} 调整后预览`} onLoad={(event) => { setImageReady(true); setImageError(false); setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }} onError={() => { setImageReady(false); setImageError(true); }} />
    </div>
    {!imageReady && !imageError && <div className="export-preview-status">正在读取处理后预览…</div>}
    {imageError && <button className="export-preview-status error" onClick={showActualSize}>预览读取失败，点击生成原图检查</button>}
    <div className="export-preview-controls"><button onClick={() => zoom(.8)}><Minus size={14} /></button><button className="zoom-value" disabled={proofLoading} title="生成并按原始像素 100% 检查" onClick={showActualSize}>{proofLoading ? '原图…' : `${Math.round(view.zoom * 100)}%`}</button><button onClick={() => zoom(1.25)}><Plus size={14} /></button><span /><button onClick={fitView}><Maximize2 size={14} /></button></div>
    <div className="export-preview-overlay"><div><strong>{frame.name}</strong><span>{rollName} · {proof ? '全分辨率检查图' : '处理后代理（点百分比载入原图）'}</span></div><small>{naturalSize.width} × {naturalSize.height}</small></div>
  </div>;
}
