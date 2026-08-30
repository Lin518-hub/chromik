import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Grid2X2, LoaderCircle, Maximize2, Minus, MousePointer2, Plus, ScanLine, Trash2, X } from 'lucide-react';
import type { AssetSummary, FrameRegionInput, FrameSummary, Point, Quad, SprocketInfo } from '../../shared/types';
import { detectFrameGrid } from '../../core/frame-detect';
import { calculateFitZoom, zoomAroundPoint, type ViewTransform } from '../viewport';
import type { EditorContext, EditorToolId } from '../navigation';
import { BoundedNumberInput } from './BoundedNumberInput';
import { EditorShell } from './EditorShell';

interface RegionDraft {
  id: string;
  frameId?: string;
  corners: Quad;
}

interface ManualFramerProps {
  asset: AssetSummary;
  assets: AssetSummary[];
  frames: FrameSummary[];
  onSave: (regions: FrameRegionInput[]) => Promise<void>;
  systemGestures: boolean;
  editorContext: EditorContext;
  onSelectAsset: (asset: AssetSummary) => void;
  onToolChange: (tool: EditorToolId) => void;
}

interface DragState {
  kind: 'pan' | 'move' | 'corner' | 'add';
  pointerId: number;
  startClient: Point;
  startNormalized?: Point;
  startView?: ViewTransform;
  regionId?: string;
  cornerIndex?: number;
  originals?: Map<string, Quad>;
}

interface MagnifierState {
  left: number;
  top: number;
  point: Point;
  cornerIndex: number;
}

const FULL_QUAD: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

function cloneQuad(corners: Quad): Quad {
  return corners.map((point) => ({ ...point })) as Quad;
}

function suggestedCount(asset: AssetSummary): number {
  const aspect = asset.width / asset.height;
  if (asset.kind === 'single') return 1;
  if (asset.kind === 'strip') return Math.max(2, Math.min(48, Math.round(Math.max(aspect / 1.5, 1 / aspect / 1.5))));
  return Math.max(4, Math.min(36, Math.round(Math.sqrt(asset.width * asset.height) / 700)));
}

function makeSuggestions(asset: AssetSummary, count: number): RegionDraft[] {
  const inset = 0.012;
  const gap = 0.006;
  if (asset.kind === 'single' || count === 1) return [{ id: crypto.randomUUID(), corners: cloneQuad(FULL_QUAD) }];
  const landscape = asset.width >= asset.height;
  if (asset.kind === 'strip') {
    return Array.from({ length: count }, (_, index) => {
      const slotStart = index / count;
      const slotEnd = (index + 1) / count;
      const x0 = landscape ? slotStart + gap / 2 : inset;
      const x1 = landscape ? slotEnd - gap / 2 : 1 - inset;
      const y0 = landscape ? inset : slotStart + gap / 2;
      const y1 = landscape ? 1 - inset : slotEnd - gap / 2;
      return { id: crypto.randomUUID(), corners: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
    });
  }
  const sourceAspect = asset.width / asset.height;
  let best = { columns: count, rows: 1, score: Infinity };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const gridAspect = columns * 1.5 / rows;
    const score = Math.abs(Math.log(gridAspect / sourceAspect)) + (columns * rows - count) * 0.08;
    if (score < best.score) best = { columns, rows, score };
  }
  return Array.from({ length: count }, (_, index) => {
    const column = index % best.columns;
    const row = Math.floor(index / best.columns);
    const x0 = column / best.columns + gap;
    const x1 = (column + 1) / best.columns - gap;
    const y0 = row / best.rows + gap;
    const y1 = (row + 1) / best.rows - gap;
    return { id: crypto.randomUUID(), corners: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
  });
}

export function ManualFramer({ asset, assets, frames, onSave, systemGestures, editorContext, onSelectAsset, onToolChange }: ManualFramerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const fitModeRef = useRef(true);
  const [naturalSize, setNaturalSize] = useState({ width: asset.width, height: asset.height });
  const [view, setView] = useState<ViewTransform>({ zoom: 1, x: 0, y: 0 });
  const [regions, setRegions] = useState<RegionDraft[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'select' | 'add'>('select');
  const [count, setCount] = useState(() => suggestedCount(asset));
  const [saving, setSaving] = useState(false);
  const [suggestionConfirmOpen, setSuggestionConfirmOpen] = useState(false);
  const [magnifier, setMagnifier] = useState<MagnifierState>();
  const [sprockets, setSprockets] = useState<{ top: SprocketInfo[]; bottom: SprocketInfo[] }>();
  const [sprocketBusy, setSprocketBusy] = useState(false);
  const [traditionalBusy, setTraditionalBusy] = useState(false);

  useEffect(() => {
    setRegions(frames.map((frame) => ({ id: frame.id, frameId: frame.id, corners: cloneQuad(frame.recipe.geometry.corners) })));
    setSelected(new Set());
    setCount(suggestedCount(asset));
    fitModeRef.current = true;
  }, [asset.id, frames]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && suggestionConfirmOpen) {
        event.preventDefault();
        setSuggestionConfirmOpen(false);
        return;
      }
      if (suggestionConfirmOpen) return;
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) {
        event.preventDefault();
        setRegions((items) => items.filter((item) => !selected.has(item.id)));
        setSelected(new Set());
      }
      if (event.key === 'Escape' && mode === 'add') setMode('select');
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [mode, selected, suggestionConfirmOpen]);

  const fitView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    fitModeRef.current = true;
    setView({ zoom: calculateFitZoom(stage.clientWidth, stage.clientHeight, naturalSize.width, naturalSize.height, 90), x: 0, y: 0 });
  }, [naturalSize.height, naturalSize.width]);

  useEffect(() => {
    fitView();
  }, [fitView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (fitModeRef.current) fitView();
    });
    observer.observe(stage);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      fitModeRef.current = false;
      const preciseTrackpad = systemGestures && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        && !event.ctrlKey
        && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 80);
      if (preciseTrackpad) {
        setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
        return;
      }
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
      setView((current) => zoomAroundPoint(
        current,
        current.zoom * Math.exp(-event.deltaY * deltaScale * (event.ctrlKey ? .008 : .0015)),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        { width: bounds.width, height: bounds.height },
      ));
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      stage.removeEventListener('wheel', wheel);
    };
  }, [fitView, systemGestures]);

  function normalizedPoint(clientX: number, clientY: number): Point | null {
    const bounds = mediaRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
    };
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    fitModeRef.current = false;
    dragRef.current = {
      kind: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startView: view,
    };
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button === 1) return startPan(event);
    if (event.button !== 0 || mode !== 'add') return;
    const start = normalizedPoint(event.clientX, event.clientY);
    if (!start) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const id = crypto.randomUUID();
    const corners: Quad = [{ ...start }, { ...start }, { ...start }, { ...start }];
    setRegions((items) => [...items, { id, corners }]);
    setSelected(new Set([id]));
    dragRef.current = { kind: 'add', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startNormalized: start, regionId: id };
  }

  function handleRegionPointerDown(region: RegionDraft, event: React.PointerEvent<SVGPolygonElement>) {
    if (event.button !== 0 || mode !== 'select') return;
    event.preventDefault();
    event.stopPropagation();
    const nextSelected = event.shiftKey
      ? new Set(selected.has(region.id) ? [...selected].filter((id) => id !== region.id) : [...selected, region.id])
      : new Set(selected.has(region.id) ? selected : [region.id]);
    setSelected(nextSelected);
    const start = normalizedPoint(event.clientX, event.clientY);
    if (!start) return;
    stageRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: 'move', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startNormalized: start,
      originals: new Map(regions.filter((item) => nextSelected.has(item.id)).map((item) => [item.id, cloneQuad(item.corners)])),
    };
  }

  function handleCornerPointerDown(region: RegionDraft, cornerIndex: number, event: React.PointerEvent<SVGCircleElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(new Set([region.id]));
    stageRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: 'corner', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY },
      regionId: region.id, cornerIndex,
    };
    const point = normalizedPoint(event.clientX, event.clientY);
    if (point) updateMagnifier(event.clientX, event.clientY, point, cornerIndex);
  }

  function updateMagnifier(clientX: number, clientY: number, point: Point, cornerIndex: number) {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const lensSize = 146;
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const left = localX + lensSize + 34 > bounds.width ? localX - lensSize - 24 : localX + 24;
    const top = Math.max(10, Math.min(bounds.height - lensSize - 10, localY - lensSize / 2));
    setMagnifier({ left, top, point, cornerIndex });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === 'pan' && drag.startView) {
      setView({
        ...drag.startView,
        x: drag.startView.x + event.clientX - drag.startClient.x,
        y: drag.startView.y + event.clientY - drag.startClient.y,
      });
      return;
    }
    const point = normalizedPoint(event.clientX, event.clientY);
    if (!point) return;
    if (drag.kind === 'add' && drag.startNormalized && drag.regionId) {
      const x0 = Math.min(drag.startNormalized.x, point.x);
      const x1 = Math.max(drag.startNormalized.x, point.x);
      const y0 = Math.min(drag.startNormalized.y, point.y);
      const y1 = Math.max(drag.startNormalized.y, point.y);
      setRegions((items) => items.map((item) => item.id === drag.regionId
        ? { ...item, corners: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }
        : item));
    } else if (drag.kind === 'corner' && drag.regionId !== undefined && drag.cornerIndex !== undefined) {
      updateMagnifier(event.clientX, event.clientY, point, drag.cornerIndex);
      setRegions((items) => items.map((item) => {
        if (item.id !== drag.regionId) return item;
        const corners = cloneQuad(item.corners);
        corners[drag.cornerIndex!] = point;
        return { ...item, corners };
      }));
    } else if (drag.kind === 'move' && drag.startNormalized && drag.originals) {
      const dx = point.x - drag.startNormalized.x;
      const dy = point.y - drag.startNormalized.y;
      let constrainedX = dx;
      let constrainedY = dy;
      for (const corners of drag.originals.values()) {
        constrainedX = Math.max(constrainedX, -Math.min(...corners.map((corner) => corner.x)));
        constrainedX = Math.min(constrainedX, 1 - Math.max(...corners.map((corner) => corner.x)));
        constrainedY = Math.max(constrainedY, -Math.min(...corners.map((corner) => corner.y)));
        constrainedY = Math.min(constrainedY, 1 - Math.max(...corners.map((corner) => corner.y)));
      }
      setRegions((items) => items.map((item) => {
        const original = drag.originals?.get(item.id);
        return original ? { ...item, corners: original.map((corner) => ({ x: corner.x + constrainedX, y: corner.y + constrainedY })) as Quad } : item;
      }));
    }
  }

  function finishPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (dragRef.current.kind === 'add') {
      const id = dragRef.current.regionId;
      setRegions((items) => items.filter((item) => {
        if (item.id !== id) return true;
        const xs = item.corners.map((corner) => corner.x);
        const ys = item.corners.map((corner) => corner.y);
        return Math.max(...xs) - Math.min(...xs) >= 0.015 && Math.max(...ys) - Math.min(...ys) >= 0.015;
      }));
    }
    dragRef.current = undefined;
    setMagnifier(undefined);
  }

  function replaceWithSuggestions() {
    const next = makeSuggestions(asset, count);
    setRegions(next);
    setSelected(new Set(next.map((region) => region.id)));
    setMode('select');
    setSuggestionConfirmOpen(false);
  }

  async function detectTraditionalFrames() {
    setTraditionalBusy(true);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = asset.previewUrl;
      await image.decode();
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(16, Math.round(image.naturalWidth * scale));
      const height = Math.max(16, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('无法创建图像分析画布');
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const result = detectFrameGrid(pixels.data, width, height, 4, { kind: asset.kind, maxFrames: 60 });
      if (!result.length) {
        setSuggestionConfirmOpen(true);
        return;
      }
      const next = result.map((item) => ({ id: crypto.randomUUID(), corners: item.corners }));
      setRegions(next);
      setCount(next.length);
      setSelected(new Set(next.map((item) => item.id)));
      setMode('select');
    } catch {
      setSuggestionConfirmOpen(true);
    } finally {
      setTraditionalBusy(false);
    }
  }

  function applySuggestions() {
    if (regions.length) setSuggestionConfirmOpen(true);
    else replaceWithSuggestions();
  }

  function deleteSelected() {
    setRegions((items) => items.filter((item) => !selected.has(item.id)));
    setSelected(new Set());
  }

  async function detectSprockets() {
    setSprocketBusy(true);
    try {
      const result = await window.filmLab.detectSprockets(asset.id);
      setSprockets(result);
    } catch (error) {
      setSprockets({ top: [], bottom: [] });
    } finally {
      setSprocketBusy(false);
    }
  }

  function snapRegionsToSprockets() {
    if (!sprockets) return;
    const topBottom = Math.max(0, ...sprockets.top.map((hole) => hole.y + hole.height));
    const bottomTop = Math.min(1, ...sprockets.bottom.map((hole) => hole.y));
    setRegions((items) => items.map((item) => {
      const ys = item.corners.map((corner) => corner.y);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const nextY0 = Math.max(y0, topBottom);
      const nextY1 = Math.min(y1, bottomTop);
      if (nextY1 - nextY0 < 0.02) return item;
      return { ...item, corners: item.corners.map((corner) => ({ x: corner.x, y: Math.max(nextY0, Math.min(nextY1, corner.y)) })) as Quad };
    }));
  }

  function deleteRegion(regionId: string, event: React.PointerEvent<SVGGElement>) {
    event.preventDefault();
    event.stopPropagation();
    setRegions((items) => items.filter((item) => item.id !== regionId));
    setSelected((items) => { const next = new Set(items); next.delete(regionId); return next; });
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(regions.map((region) => ({ frameId: region.frameId, corners: region.corners })));
    } catch (error) {
      // BUG-001：App.saveAssetFrames 负责向用户展示错误；这里记录并保持
      // 草稿状态，按钮恢复可再次保存。
      console.error('FilmLab: 分帧保存失败', error);
    } finally {
      setSaving(false);
    }
  }

  const frameNumbers = useMemo(() => new Map(frames.map((frame) => [frame.id, frame.frameNumber])), [frames]);

  return (
    <>
      <EditorShell
        activeTool="segment"
        context={editorContext}
        inspectorTitle="素材分帧"
        scopeLabel="当前素材"
        onToolChange={onToolChange}
        inspector={<div className="framer-inspector">
          <div className="context-intro"><ScanLine size={18} /><div><b>{asset.name}</b><span>{asset.width} × {asset.height} · {asset.kind === 'strip' ? '长条' : asset.kind === 'contact' ? '印样' : asset.kind === 'single' ? '单张' : '未分类'}</span></div></div>
          <div className="framer-mode-control">
            <button className={mode === 'select' ? 'active' : ''} onClick={() => setMode('select')}><MousePointer2 size={16} /><span>选择与移动</span></button>
            <button className={mode === 'add' ? 'active' : ''} onClick={() => setMode('add')}><ScanLine size={16} /><span>连续添加帧</span></button>
          </div>
          <div className="framer-suggestion-card">
            <div><b>自动建议</b><span>按素材排列生成分帧区域</span></div>
            <label>画面数量<BoundedNumberInput min={1} max={60} value={count} aria-label="自动分帧建议张数" onChange={setCount} /></label>
            <button className="button-secondary full" onClick={applySuggestions}><Grid2X2 size={15} />生成 {count} 张建议</button>
            <button className="button-secondary full" disabled={traditionalBusy} onClick={() => void detectTraditionalFrames()}>{traditionalBusy ? <LoaderCircle className="spin" size={15} /> : <ScanLine size={15} />}{traditionalBusy ? '正在分析画面…' : '传统分析建议'}</button>
          </div>
          <div className="framer-suggestion-card">
            <div><b>齿孔检测</b><span>识别透光齿孔，辅助吸附边界</span></div>
            <button className="button-secondary full" disabled={sprocketBusy} onClick={() => void detectSprockets()}>{sprocketBusy ? <LoaderCircle className="spin" size={15} /> : <ScanLine size={15} />}{sprockets ? `重新检测（上 ${sprockets.top.length} · 下 ${sprockets.bottom.length}）` : '检测齿孔'}</button>
            {sprockets && (sprockets.top.length + sprockets.bottom.length) > 0 && <button className="button-secondary full" onClick={snapRegionsToSprockets}><Maximize2 size={15} />吸附区域到齿孔之间</button>}
            {sprockets && sprockets.top.length + sprockets.bottom.length === 0 && <p className="framer-note">未检测到明显齿孔（适用于透光翻拍，长条上下边缘需入画）。</p>}
          </div>
          <div className="context-stat"><span>已有区域</span><b>{regions.length}</b></div>
          <div className="context-stat"><span>已选择</span><b>{selected.size}</b></div>
          <button className="button-secondary full danger-outline" disabled={!selected.size} onClick={deleteSelected}><Trash2 size={15} />删除选中 {selected.size || ''}</button>
          <div className="framer-inspector-spacer" />
          <button className="button-primary full" disabled={saving || !regions.length} onClick={() => void save()}><Check size={15} />{saving ? '正在生成…' : `保存 ${regions.length} 帧并调整`}</button>
        </div>}
        canvas={<div
          ref={stageRef}
          className={`framer-stage ${mode === 'add' ? 'is-adding' : ''}`}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
          onAuxClick={(event) => event.preventDefault()}
        >
          <div ref={mediaRef} className="framer-media" style={{
            width: naturalSize.width,
            height: naturalSize.height,
            transform: `translate(-50%, -50%) translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
          }}>
            <img src={asset.previewUrl} alt={asset.name} draggable={false} onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
            <svg viewBox={`0 0 ${naturalSize.width} ${naturalSize.height}`}>
              {sprockets && [...sprockets.top, ...sprockets.bottom].map((hole, index) => (
                <rect key={`hole-${index}`} className="sprocket-overlay" x={hole.x * naturalSize.width} y={hole.y * naturalSize.height} width={Math.max(1, hole.width * naturalSize.width)} height={Math.max(1, hole.height * naturalSize.height)} />
              ))}
              {regions.map((region, index) => {
                const points = region.corners.map((corner) => `${corner.x * naturalSize.width},${corner.y * naturalSize.height}`).join(' ');
                const centerX = region.corners.reduce((sum, point) => sum + point.x, 0) / 4 * naturalSize.width;
                const centerY = region.corners.reduce((sum, point) => sum + point.y, 0) / 4 * naturalSize.height;
                const isSelected = selected.has(region.id);
                const controlX = Math.max(...region.corners.map((corner) => corner.x)) * naturalSize.width;
                const controlY = Math.min(...region.corners.map((corner) => corner.y)) * naturalSize.height;
                return <g key={region.id} className={isSelected ? 'selected' : ''}>
                  <polygon points={points} strokeWidth={2 / view.zoom} onPointerDown={(event) => handleRegionPointerDown(region, event)} />
                  <text x={centerX} y={centerY} fontSize={22 / view.zoom} textAnchor="middle" dominantBaseline="middle">{region.frameId ? frameNumbers.get(region.frameId) : index + 1}</text>
                  {isSelected && region.corners.map((corner, cornerIndex) => <circle
                    key={cornerIndex}
                    cx={corner.x * naturalSize.width}
                    cy={corner.y * naturalSize.height}
                    r={8 / view.zoom}
                    strokeWidth={2 / view.zoom}
                    onPointerDown={(event) => handleCornerPointerDown(region, cornerIndex, event)}
                  />)}
                  {isSelected && <g className="frame-delete-control" transform={`translate(${controlX - 58 / view.zoom} ${controlY + 8 / view.zoom})`} onPointerDown={(event) => deleteRegion(region.id, event)}>
                    <rect width={52 / view.zoom} height={22 / view.zoom} rx={7 / view.zoom} />
                    <text x={26 / view.zoom} y={11 / view.zoom} fontSize={10 / view.zoom} textAnchor="middle" dominantBaseline="middle">删除 ×</text>
                  </g>}
                </g>;
              })}
            </svg>
          </div>
          <div className="framer-zoom">
            <button onClick={() => setView((current) => ({ ...current, zoom: Math.max(.05, current.zoom * .8) }))}><Minus size={14} /></button>
            <b>{Math.round(view.zoom * 100)}%</b>
            <button onClick={() => setView((current) => ({ ...current, zoom: Math.min(8, current.zoom * 1.25) }))}><Plus size={14} /></button>
            <button onClick={fitView}><Maximize2 size={14} /></button>
          </div>
          {magnifier && (() => {
            const magnifierScale = Math.max(view.zoom * 5, 1.8);
            const size = 146;
            return <div className="framer-magnifier" style={{ left: magnifier.left, top: magnifier.top, width: size, height: size }}>
              <div className="magnifier-image" style={{
                backgroundImage: `url("${asset.previewUrl}")`,
                backgroundSize: `${naturalSize.width * magnifierScale}px ${naturalSize.height * magnifierScale}px`,
                backgroundPosition: `${size / 2 - magnifier.point.x * naturalSize.width * magnifierScale}px ${size / 2 - magnifier.point.y * naturalSize.height * magnifierScale}px`,
              }} />
              <span className="magnifier-crosshair" />
              <b>角 {magnifier.cornerIndex + 1} · {Math.round(magnifierScale / Math.max(.01, view.zoom) * 100)}%</b>
            </div>;
          })()}
          <div className={`framer-hint ${mode === 'add' ? 'adding' : ''}`}>{mode === 'add' ? '连续添加模式 · 每次拖出一帧 · 完成后点“选择”或按 Esc' : '双指移动 · 捏合缩放 · Shift 多选 · 拖帧体移动 · 拖四角校正'}</div>
        </div>}
        filmstrip={<div className="framer-source-strip">
          {assets.map((item) => <button key={item.id} className={item.id === asset.id ? 'active' : ''} onClick={() => onSelectAsset(item)}><img src={item.previewUrl} draggable={false} alt="" /><span><b>{item.name}</b><small>{item.frameCount} 帧</small></span></button>)}
        </div>}
      />
      {suggestionConfirmOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSuggestionConfirmOpen(false)}>
        <section className="compact-confirm glass-surface-strong" role="alertdialog" aria-modal="true" aria-labelledby="framer-confirm-title" aria-describedby="framer-confirm-description">
          <div className="modal-heading"><div><p className="eyebrow">AUTO FRAME</p><h2 id="framer-confirm-title">替换当前分帧区域？</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setSuggestionConfirmOpen(false)}><X size={17} /></button></div>
          <p className="modal-intro" id="framer-confirm-description">自动建议会替换画面上尚未保存的 {regions.length} 个区域。原始文件不会被修改。</p>
          <div className="compact-confirm-actions"><button autoFocus className="button-secondary" onClick={() => setSuggestionConfirmOpen(false)}>保留当前区域</button><button className="button-primary" onClick={replaceWithSuggestions}>替换为 {count} 张建议</button></div>
        </section>
      </div>}
    </>
  );
}
