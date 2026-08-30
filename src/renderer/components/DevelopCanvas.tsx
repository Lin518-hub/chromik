import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { FilmBaseSample } from '../../core/density';
import type { DustCandidate } from '../../core/dust-detect';
import { orientNormalizedPoint, quadToCrop, unorientNormalizedPoint } from '../../core/geometry';
import { serializeCubeLut, type CubeLut } from '../../core/cube';
import { decodeDevelopProxy, describeDevelopProxy } from '../../core/develop-proxy';
import type { WaveformData } from '../../core/histogram';
import type { CropRect, EditRecipe, FrameSummary, Point, Quad, RGB } from '../../shared/types';
import { calculateFitZoom, zoomAroundPoint, type ViewTransform } from '../viewport';
import { recordLocalTiming } from '../local-telemetry';

type AutoInvertResult = { baseRgb: RGB; baseRgbLinear: RGB; low: RGB; high: RGB; clippedRatio: number; shadowCorrection: RGB; midCorrection: RGB; highlightCorrection: RGB; confidence: number; baseConfidence: number; baseStatus: string; anchorStatus: string };
type AutoCropResult = { crop: CropRect; confidence: number };
type AnalysisResult = ({ kind: 'invert' } & AutoInvertResult)
  | ({ kind: 'crop' | 'film-region' } & AutoCropResult)
  | ({ kind: 'sample' } & FilmBaseSample)
  | { kind: 'dust'; candidates: DustCandidate[] };

export interface DevelopCanvasHandle {
  autoInvert(options?: { reestimateBase?: boolean; baseRgb?: RGB; baseRgbLinear?: RGB; analysisRegion?: CropRect }): Promise<AutoInvertResult | null>;
  autoCrop(): Promise<AutoCropResult | null>;
  autoFilmRegion(): Promise<AutoCropResult | null>;
  detectDustSpots(): Promise<DustCandidate[]>;
  /** Terminates the current CPU analysis immediately, then reloads the proxy worker. */
  cancelAnalysis(): void;
}

interface DevelopCanvasProps {
  frame: FrameSummary;
  recipe: EditRecipe;
  compare: boolean;
  negativeWorkflow: boolean;
  filmTypeUnknown: boolean;
  systemGestures: boolean;
  sampling: boolean;
  onSample: (sample: FilmBaseSample) => void;
  onHistogram: (bins: [number[], number[], number[]]) => void;
  onWaveform?: (waveform: WaveformData) => void;
  onReadyChange: (ready: boolean) => void;
  geometryEditing: boolean;
  onCornersChange: (corners: Quad) => void;
  lut?: CubeLut;
  samplingHint?: string;
  dustRemoval?: boolean;
  spots?: EditRecipe['spots'];
  onSpotsChange?: (spots: NonNullable<EditRecipe['spots']>) => void;
  dustBrushSize?: number;
  splitCompare?: boolean;
  /** BUG-003：全分辨率检查失败的用户可见提示（此前仅 console.error）。 */
  onProofError?: (message: string) => void;
  /** Calibration-only ROI. It limits statistics but never changes photo geometry. */
  analysisRegion?: CropRect;
  analysisRegionEditing?: boolean;
  onAnalysisRegionChange?: (region: CropRect) => void;
}

interface RenderRequest {
  type: 'render';
  requestId: number;
  sourceVersion: number;
  recipe: EditRecipe;
  compare: boolean;
  geometryEditing: boolean;
  showFullSource: boolean;
  rawSource: boolean;
  cameraRaw: boolean;
  rawDisplayTransform: 'camera-raw-neutral' | 'camera-raw-legacy-lift';
  interactive: boolean;
  /** 反馈③：空闲升级档位（约 1600px 长边），比全分辨率快数倍。 */
  idle?: boolean;
  splitCompare?: boolean;
  lut?: ReturnType<typeof serializeCubeLut>;
  validateGpu?: boolean;
}

interface WorkerResponse {
  type: 'rendered' | 'analysis' | 'error';
  requestId: number;
  sourceVersion: number;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  pixels?: ArrayBuffer;
  histogram?: [number[], number[], number[]];
  waveform?: WaveformData;
  analysis?: AnalysisResult;
  message?: string;
  backend?: 'gpu-webgl2' | 'cpu-reference';
  durationMs?: number;
  gpuValidation?: { average: number; p99: number; maximum: number; passed: boolean };
}

interface FullResolutionProof {
  url: string;
  width: number;
  height: number;
}

interface PanSession {
  pointerId: number;
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
}

interface CropMoveSession {
  pointerId: number;
  start: Point;
  corners: Quad;
}

const DEFAULT_TRANSFORM: ViewTransform = { zoom: 1, x: 0, y: 0 };
const CAMERA_RAW_FORMATS = new Set(['3FR', 'ARW', 'CR2', 'CR3', 'DCR', 'DNG', 'ERF', 'FFF', 'KDC', 'MEF', 'MOS', 'MRW', 'NEF', 'NRW', 'ORF', 'PEF', 'RAF', 'RAW', 'RW2', 'SR2', 'SRF', 'X3F']);

export const DevelopCanvas = forwardRef<DevelopCanvasHandle, DevelopCanvasProps>(function DevelopCanvas(
  { frame, recipe, compare, negativeWorkflow, filmTypeUnknown, systemGestures, sampling, onSample, onHistogram, onWaveform, onReadyChange, geometryEditing, onCornersChange, lut, dustRemoval, spots, onSpotsChange, dustBrushSize, splitCompare, analysisRegion, analysisRegionEditing = false, onAnalysisRegionChange, onProofError },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<{ width: number; height: number } | null>(null);
  // PERF-01：交互代理 1080p 起步，连续慢帧后自动降回 720（30fps 目标）；
  // QA 可用 FILMLAB_QA_INTERACTIVE_EDGE 固定档位做 fps 基准。
  const interactiveEdgeRef = useRef(window.filmLab.qaInteractiveEdge ?? 1080);
  const interactiveFrameTimesRef = useRef<number[]>([]);
  const rawDisplayTransformRef = useRef<'camera-raw-neutral' | 'camera-raw-legacy-lift'>('camera-raw-neutral');
  const proxySizeRef = useRef<{ width: number; height: number } | null>(null);
  const fullProofRef = useRef<FullResolutionProof | undefined>(undefined);
  const proofRequestRef = useRef(0);
  const workerRef = useRef<Worker | undefined>(undefined);
  const sourceVersionRef = useRef(0);
  const requestIdRef = useRef(0);
  const workerBusyRef = useRef(false);
  const pendingRenderRef = useRef<RenderRequest | undefined>(undefined);
  const idleUpgradeTimerRef = useRef<number | undefined>(undefined);
  const lastRenderKeyRef = useRef('');
  const lastLutRef = useRef<CubeLut | undefined>(undefined);
  const serializedLutCacheRef = useRef<{ lut: CubeLut; serialized: ReturnType<typeof serializeCubeLut> } | undefined>(undefined);
  const analysisResolversRef = useRef(new Map<number, (result: AnalysisResult | null) => void>());
  const onHistogramRef = useRef(onHistogram);
  const onWaveformRef = useRef(onWaveform);
  const onReadyChangeRef = useRef(onReadyChange);
  const onProofErrorRef = useRef(onProofError);
  const panSessionRef = useRef<PanSession | undefined>(undefined);
  const didPanRef = useRef(false);
  const dragCornerRef = useRef<number | undefined>(undefined);
  const cropMoveRef = useRef<CropMoveSession | undefined>(undefined);
  const fitModeRef = useRef(true);
  const userZoomedRef = useRef(false);
  const latestCornersRef = useRef<Quad | undefined>(undefined);
  const cornerFrameRef = useRef<number | undefined>(undefined);
  const [imageVersion, setImageVersion] = useState(0);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [viewTransform, setViewTransform] = useState<ViewTransform>(DEFAULT_TRANSFORM);
  const [dragCorner, setDragCorner] = useState<number>();
  const [isPanning, setIsPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [fullProof, setFullProof] = useState<FullResolutionProof>();
  const [proofLoading, setProofLoading] = useState(false);
  const [interactiveAdjusting, setInteractiveAdjusting] = useState(false);
  const [workerEpoch, setWorkerEpoch] = useState(0);

  onHistogramRef.current = onHistogram;
  onWaveformRef.current = onWaveform;
  onReadyChangeRef.current = onReadyChange;
  onProofErrorRef.current = onProofError;

  const postRender = useCallback((request: RenderRequest) => {
    const worker = workerRef.current;
    if (!worker) {
      pendingRenderRef.current = request;
      return;
    }
    workerBusyRef.current = true;
    worker.postMessage(request);
  }, [workerEpoch]);

  const queueRender = useCallback((request: RenderRequest) => {
    setProcessing(true);
    if (workerBusyRef.current) pendingRenderRef.current = request;
    else postRender(request);
  }, [postRender, workerEpoch]);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/preview.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === 'analysis' || (response.type === 'error' && analysisResolversRef.current.has(response.requestId))) {
        const resolve = analysisResolversRef.current.get(response.requestId);
        analysisResolversRef.current.delete(response.requestId);
        // The source may have been swapped (different asset/frame) while the
        // analysis ran; dropping the stale result prevents applying frame A's
        // base/anchors/crop to frame B.
        const stale = response.sourceVersion !== sourceVersionRef.current;
        resolve?.(!stale && response.type === 'analysis' ? response.analysis ?? null : null);
        return;
      }

      workerBusyRef.current = false;
      const isCurrentSource = response.sourceVersion === sourceVersionRef.current;
      if (isCurrentSource && (response.type === 'error' || !response.pixels || !response.width || !response.height)) {
        console.error('FilmLab preview worker failed', response.message ?? '未知错误');
        setProcessing(false);
      } else if (isCurrentSource && response.pixels && response.width && response.height) {
        // Paint every completed frame before chasing the newest queued value. This keeps
        // sliders visually live while still collapsing obsolete work to a single request.
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = response.width;
          canvas.height = response.height;
          const context = canvas.getContext('2d');
          context?.putImageData(new ImageData(new Uint8ClampedArray(response.pixels), response.width, response.height), 0, 0);
          if (response.backend) canvas.dataset.previewBackend = response.backend;
          if (response.gpuValidation) canvas.dataset.gpuValidation = JSON.stringify(response.gpuValidation);
          if (response.durationMs !== undefined) {
            canvas.dataset.previewDurationMs = response.durationMs.toFixed(2);
            if (response.backend === 'gpu-webgl2') {
              canvas.dataset.lastGpuDurationMs = response.durationMs.toFixed(2);
              canvas.dataset.gpuFrameCount = String(Number(canvas.dataset.gpuFrameCount ?? 0) + 1);
              canvas.dataset.minGpuDurationMs = String(Math.min(Number(canvas.dataset.minGpuDurationMs ?? Number.POSITIVE_INFINITY), response.durationMs));
              canvas.dataset.maxGpuDurationMs = String(Math.max(Number(canvas.dataset.maxGpuDurationMs ?? 0), response.durationMs));
            }
            recordLocalTiming(`preview.${response.backend ?? 'unknown'}`, response.durationMs);
            // 自适应档位：连续 10 帧平均超过 48ms（约 <21fps）时，后续画面
            // 以 720p 交互代理加载，优先满足 30fps 拖动目标。
            const frameTimes = interactiveFrameTimesRef.current;
            frameTimes.push(response.durationMs);
            if (frameTimes.length > 10) frameTimes.shift();
            if (frameTimes.length >= 10 && frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length > 48) {
              if (interactiveEdgeRef.current !== 720) {
                interactiveEdgeRef.current = 720;
                interactiveFrameTimesRef.current = [];
              }
            }
          }
          if (!fullProofRef.current) setDisplaySize({ width: response.displayWidth ?? response.width, height: response.displayHeight ?? response.height });
          if (response.histogram) onHistogramRef.current(response.histogram);
          if (response.waveform) onWaveformRef.current?.(response.waveform);
          onReadyChangeRef.current(true);
        }
      }
      const pending = pendingRenderRef.current;
      if (pending) {
        pendingRenderRef.current = undefined;
        postRender(pending);
      } else {
        setProcessing(false);
      }
    };
    const pending = pendingRenderRef.current;
    if (pending) {
      pendingRenderRef.current = undefined;
      postRender(pending);
    }
    return () => {
      worker.terminate();
      workerRef.current = undefined;
      workerBusyRef.current = false;
      for (const resolve of analysisResolversRef.current.values()) resolve(null);
      analysisResolversRef.current.clear();
    };
  }, [postRender]);

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();
    onReadyChange(false);
    setProcessing(true);
    sourceRef.current = null;
    proxySizeRef.current = null;
    fullProofRef.current = undefined;
    setFullProof(undefined);
    setProofLoading(false);
    proofRequestRef.current += 1;
    lastRenderKeyRef.current = '';
    fitModeRef.current = true;
    userZoomedRef.current = false;
    void (async () => {
      try {
        const response = await fetch(frame.developPreviewUrl, { signal: abortController.signal });
        if (!response.ok) throw new Error(`开发代理读取失败（${response.status}）`);
        rawDisplayTransformRef.current = response.headers.get('X-Chromik-Raw-Display') === 'camera-raw-legacy-lift'
          ? 'camera-raw-legacy-lift'
          : 'camera-raw-neutral';
        const proxy = decodeDevelopProxy(await response.arrayBuffer());
        if (cancelled) return;
        sourceRef.current = { width: proxy.width, height: proxy.height };
        proxySizeRef.current = { width: proxy.width, height: proxy.height };
        const sourceVersion = sourceVersionRef.current + 1;
        sourceVersionRef.current = sourceVersion;
        const workerPixels = proxy.data;
        workerRef.current?.postMessage({
          type: 'source',
          sourceVersion,
          width: proxy.width,
          height: proxy.height,
          descriptor: describeDevelopProxy(proxy),
          pixels: workerPixels.buffer,
          // PERF-01：默认 1080p 交互代理；实测连续慢帧后自动降回 720。
          interactiveEdge: interactiveEdgeRef.current,
        }, [workerPixels.buffer]);
        setDisplaySize({ width: proxy.width, height: proxy.height });
        setImageVersion((value) => value + 1);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        console.error('FilmLab proxy canvas failed', error);
        onReadyChange(false);
        setProcessing(false);
      }
    })();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [frame.developPreviewUrl, frame.id, onReadyChange, workerEpoch]);

  useEffect(() => {
    if (!fullProofRef.current) return;
    fullProofRef.current = undefined;
    setFullProof(undefined);
    proofRequestRef.current += 1;
    userZoomedRef.current = false;
    fitModeRef.current = true;
    const proxySize = proxySizeRef.current;
    if (proxySize) setDisplaySize(proxySize);
  }, [recipe]);

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'range') setInteractiveAdjusting(true);
    };
    const finish = () => setInteractiveAdjusting(false);
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
    };
  }, []);

  useEffect(() => {
    if (!sourceRef.current || imageVersion === 0) return;
    const showFullSource = geometryEditing || sampling || Boolean(analysisRegion);
    const renderKey = JSON.stringify(showFullSource
      ? {
          sourceVersion: sourceVersionRef.current,
          compare,
          geometryEditing,
          sampling,
          interactiveAdjusting,
          splitCompare,
          geometry: geometryEditing ? recipe.geometry : undefined,
          baseRgb: recipe.baseRgb,
          density: recipe.density,
          grade: recipe.grade,
        }
      : { sourceVersion: sourceVersionRef.current, compare, geometryEditing, interactiveAdjusting, splitCompare, recipe });
    if (lastRenderKeyRef.current === renderKey && lastLutRef.current === lut) return;
    lastRenderKeyRef.current = renderKey;
    lastLutRef.current = lut;
    // Cache the serialized LUT by object identity: re-serializing a 3D LUT on
    // every slider tick would flood the worker with hundreds of KB per frame.
    let serializedLut: ReturnType<typeof serializeCubeLut> | undefined;
    if (lut) {
      if (!serializedLutCacheRef.current || serializedLutCacheRef.current.lut !== lut) {
        serializedLutCacheRef.current = { lut, serialized: serializeCubeLut(lut) };
      }
      serializedLut = serializedLutCacheRef.current.serialized;
    } else {
      serializedLutCacheRef.current = undefined;
    }
    queueRender({
      type: 'render',
      requestId: ++requestIdRef.current,
      sourceVersion: sourceVersionRef.current,
      recipe,
      compare,
      geometryEditing,
      showFullSource,
      rawSource: sampling,
      cameraRaw: CAMERA_RAW_FORMATS.has(frame.format.toUpperCase()),
      rawDisplayTransform: rawDisplayTransformRef.current,
      interactive: interactiveAdjusting,
      splitCompare,
      lut: serializedLut,
      validateGpu: window.filmLab.qaGpuValidation,
    });
    if (!interactiveAdjusting) {
      // 反馈③/⑧：程序化变更（自动校准/片基取样/预设等）先立即出交互档位
      // 的快速反馈，空闲 350ms 后再升级到高清档位。此前每次变更都直接跑
      // 全分辨率 CPU 渲染（数秒），表现为“点击没反应、卡顿后才更新”，
      // 拖动滑块时又会被在途的全分辨率渲染饿死，看起来像滑块无效。
      window.clearTimeout(idleUpgradeTimerRef.current);
      idleUpgradeTimerRef.current = window.setTimeout(() => {
        queueRender({
          type: 'render',
          requestId: ++requestIdRef.current,
          sourceVersion: sourceVersionRef.current,
          recipe,
          compare,
          geometryEditing,
          showFullSource,
          rawSource: sampling,
          cameraRaw: CAMERA_RAW_FORMATS.has(frame.format.toUpperCase()),
          rawDisplayTransform: rawDisplayTransformRef.current,
          interactive: false,
          idle: true,
          splitCompare,
          lut: serializedLut,
          validateGpu: window.filmLab.qaGpuValidation,
        });
      }, 350);
    }
  }, [analysisRegion, compare, frame.format, geometryEditing, imageVersion, interactiveAdjusting, lut, queueRender, recipe, sampling, splitCompare]);

  const fitView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !displaySize.width || !displaySize.height) return;
    const zoom = calculateFitZoom(stage.clientWidth, stage.clientHeight, displaySize.width, displaySize.height);
    fitModeRef.current = true;
    userZoomedRef.current = false;
    setViewTransform({ zoom, x: 0, y: 0 });
  }, [displaySize.height, displaySize.width]);

  const showActualSize = useCallback(() => {
    fitModeRef.current = false;
    userZoomedRef.current = true;
    if (fullProofRef.current) {
      setViewTransform({ zoom: 1, x: 0, y: 0 });
      return;
    }
    const requestId = ++proofRequestRef.current;
    setProofLoading(true);
    const proofRecipe: EditRecipe = analysisRegion ? {
      ...recipe,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      geometry: {
        corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        rotation90: 0,
        straighten: 0,
        lensDistortion: 0,
        flipX: false,
        flipY: false,
      },
    } : geometryEditing ? {
      ...recipe,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      geometry: {
        ...recipe.geometry,
        corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      },
    } : recipe;
    void window.filmLab.renderProofPreview(frame.id, proofRecipe).then((proof) => {
      if (requestId !== proofRequestRef.current) return;
      fullProofRef.current = proof;
      setFullProof(proof);
      setDisplaySize({ width: proof.width, height: proof.height });
      setViewTransform({ zoom: 1, x: 0, y: 0 });
    }).catch((error) => {
      if (requestId === proofRequestRef.current) {
        console.error('FilmLab full-resolution proof failed', error);
        // BUG-003：失败必须有用户可见的提示，而不是按钮静默复位。
        onProofErrorRef.current?.(`全分辨率检查图生成失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }).finally(() => {
      if (requestId === proofRequestRef.current) setProofLoading(false);
    });
  }, [analysisRegion, frame.id, geometryEditing, recipe]);

  useEffect(() => {
    // The 3072px develop proxy is for responsive editing, not pixel-level
    // focus inspection. Once an explicit user zoom reaches 1 CSS pixel per
    // proxy pixel, switch to the processed full-resolution RAW proof instead
    // of enlarging the proxy into visible blocks.
    if (!userZoomedRef.current || viewTransform.zoom < 0.995 || fullProofRef.current || proofLoading) return;
    if (geometryEditing || sampling || analysisRegion) return;
    showActualSize();
  }, [analysisRegion, geometryEditing, proofLoading, sampling, showActualSize, viewTransform.zoom]);

  useEffect(() => {
    if (fitModeRef.current) fitView();
  }, [displaySize, fitView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (fitModeRef.current) fitView();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitView]);

  const zoomBy = useCallback((factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    fitModeRef.current = false;
    userZoomedRef.current = true;
    setViewTransform((current) => zoomAroundPoint(
      current,
      current.zoom * factor,
      { x: stage.clientWidth / 2, y: stage.clientHeight / 2 },
      { width: stage.clientWidth, height: stage.clientHeight },
    ));
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      if (!displaySize.width) return;
      event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      fitModeRef.current = false;
      const preciseTrackpad = systemGestures && event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        && !event.ctrlKey
        && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 80);
      if (preciseTrackpad) {
        setViewTransform((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
        return;
      }
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
      const factor = Math.exp(-event.deltaY * deltaScale * (event.ctrlKey ? .008 : .0015));
      userZoomedRef.current = true;
      setViewTransform((current) => zoomAroundPoint(
        current,
        current.zoom * factor,
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        { width: bounds.width, height: bounds.height },
      ));
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [displaySize.width, systemGestures]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => target instanceof HTMLElement
      && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName);
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isEditable(event.target)) {
        event.preventDefault();
        setSpacePressed(true);
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === '0') {
        event.preventDefault();
        fitView();
      } else if (event.key === '1') {
        event.preventDefault();
        showActualSize();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.25);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomBy(0.8);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePressed(false);
    };
    const blur = () => setSpacePressed(false);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [fitView, showActualSize, zoomBy]);

  const requestAnalysis = useCallback((kind: 'invert' | 'crop' | 'film-region' | 'sample' | 'dust', options: { reestimateBase?: boolean; baseRgb?: RGB; baseRgbLinear?: RGB; analysisRegion?: CropRect; normalizedX?: number; normalizedY?: number } = {}): Promise<AnalysisResult | null> => {
    if (!sourceRef.current || !workerRef.current) return Promise.resolve(null);
    const requestId = ++requestIdRef.current;
    return new Promise((resolve) => {
      analysisResolversRef.current.set(requestId, resolve);
      workerRef.current?.postMessage({
        type: 'analyze',
        requestId,
        sourceVersion: sourceVersionRef.current,
        kind,
        recipe,
        reestimateBase: options.reestimateBase,
        baseRgbOverride: options.baseRgb,
        baseRgbLinearOverride: options.baseRgbLinear,
        analysisRegion: options.analysisRegion,
        normalizedX: options.normalizedX,
        normalizedY: options.normalizedY,
      });
    });
  }, [recipe]);

  useImperativeHandle(ref, () => ({
    async autoInvert(options) {
      const result = await requestAnalysis('invert', options);
      return result?.kind === 'invert' ? result : null;
    },
    async autoCrop() {
      const result = await requestAnalysis('crop');
      return result?.kind === 'crop' ? result : null;
    },
    async autoFilmRegion() {
      const result = await requestAnalysis('film-region');
      return result?.kind === 'film-region' ? result : null;
    },
    async detectDustSpots() {
      const result = await requestAnalysis('dust');
      return result?.kind === 'dust' ? result.candidates : [];
    },
    cancelAnalysis() {
      // Dedicated Web Workers cannot service a cancellation message while a
      // synchronous pixel scan is running. Terminating it is immediate and
      // also releases its proxy buffer; the epoch effects rebuild the worker
      // and re-transfer the one canonical proxy without touching user edits.
      try { workerRef.current?.terminate(); }
      catch { /* already exited */ }
      workerRef.current = undefined;
      workerBusyRef.current = false;
      pendingRenderRef.current = undefined;
      // Wrap each resolve so a downstream Promise rejection cannot crash
      // the main React render path while cancellation is in flight.
      for (const resolve of analysisResolversRef.current.values()) {
        try { resolve(null); }
        catch (handlerError) { console.warn('FilmLab: 分析回调取消时抛错', handlerError); }
      }
      analysisResolversRef.current.clear();
      try { onReadyChangeRef.current(false); }
      catch (handlerError) { console.warn('FilmLab: ready 信号派发失败', handlerError); }
      setProcessing(true);
      setWorkerEpoch((current) => current + 1);
    },
  }), [requestAnalysis]);

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 1 && !(event.button === 0 && spacePressed)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      startX: viewTransform.x,
      startY: viewTransform.y,
    };
    didPanRef.current = false;
    fitModeRef.current = false;
    setIsPanning(true);
  }

  function pointInMedia(event: { clientX: number; clientY: number }) {
    const bounds = mediaRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
    return geometryEditing ? unorientNormalizedPoint(point, recipe.geometry) : point;
  }

  function emitCorners(corners: Quad) {
    latestCornersRef.current = corners;
    if (cornerFrameRef.current !== undefined) return;
    cornerFrameRef.current = requestAnimationFrame(() => {
      cornerFrameRef.current = undefined;
      if (latestCornersRef.current) {
        if (analysisRegionEditing && onAnalysisRegionChange) onAnalysisRegionChange(quadToCrop(latestCornersRef.current));
        else onCornersChange(latestCornersRef.current);
      }
    });
  }

  useEffect(() => () => {
    if (cornerFrameRef.current !== undefined) cancelAnimationFrame(cornerFrameRef.current);
    cornerFrameRef.current = undefined;
    latestCornersRef.current = undefined;
  }, [frame.id]);

  // 反馈③：卸载时清理空闲升级定时器，避免向已销毁的 worker 发消息。
  useEffect(() => () => {
    if (idleUpgradeTimerRef.current !== undefined) window.clearTimeout(idleUpgradeTimerRef.current);
  }, []);

  function handleStagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panSessionRef.current;
    if (pan?.pointerId === event.pointerId) {
      const dx = event.clientX - pan.clientX;
      const dy = event.clientY - pan.clientY;
      // 6px is large enough to ignore trackpad jitter and prevents a tap
      // that wiggles by a pixel or two from cancelling the next click.
      if (Math.abs(dx) + Math.abs(dy) > 6) didPanRef.current = true;
      setViewTransform((current) => ({ ...current, x: pan.startX + dx, y: pan.startY + dy }));
      return;
    }
    const cropMove = cropMoveRef.current;
    if ((geometryEditing || analysisRegionEditing) && cropMove?.pointerId === event.pointerId) {
      const point = pointInMedia(event);
      if (!point) return;
      const dx = point.x - cropMove.start.x;
      const dy = point.y - cropMove.start.y;
      const minX = Math.min(...cropMove.corners.map((corner) => corner.x));
      const maxX = Math.max(...cropMove.corners.map((corner) => corner.x));
      const minY = Math.min(...cropMove.corners.map((corner) => corner.y));
      const maxY = Math.max(...cropMove.corners.map((corner) => corner.y));
      const constrainedX = Math.max(-minX, Math.min(1 - maxX, dx));
      const constrainedY = Math.max(-minY, Math.min(1 - maxY, dy));
      emitCorners(cropMove.corners.map((corner) => ({ x: corner.x + constrainedX, y: corner.y + constrainedY })) as Quad);
      return;
    }
    const cornerIndex = dragCornerRef.current;
    if ((!geometryEditing && !analysisRegionEditing) || cornerIndex === undefined) return;
    const point = pointInMedia(event);
    if (!point) return;
    const bounds = analysisRegionEditing && analysisRegion ? analysisRegion : quadToCrop(recipe.geometry.corners);
    let left = bounds.x;
    let top = bounds.y;
    let right = bounds.x + bounds.width;
    let bottom = bounds.y + bounds.height;
    if (cornerIndex === 0 || cornerIndex === 3 || cornerIndex === 7) left = Math.min(point.x, right - .01);
    if (cornerIndex === 1 || cornerIndex === 2 || cornerIndex === 5) right = Math.max(point.x, left + .01);
    if (cornerIndex === 0 || cornerIndex === 1 || cornerIndex === 4) top = Math.min(point.y, bottom - .01);
    if (cornerIndex === 2 || cornerIndex === 3 || cornerIndex === 6) bottom = Math.max(point.y, top + .01);
    emitCorners([
      { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
    ]);
  }

  function finishPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (panSessionRef.current?.pointerId === event.pointerId) {
      panSessionRef.current = undefined;
      setIsPanning(false);
    }
    if (dragCornerRef.current !== undefined) {
      dragCornerRef.current = undefined;
      setDragCorner(undefined);
    }
    if (cropMoveRef.current?.pointerId === event.pointerId) cropMoveRef.current = undefined;
  }

  function handleCornerPointerDown(index: number, event: React.PointerEvent<SVGRectElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragCornerRef.current = index;
    setDragCorner(index);
    stageRef.current?.setPointerCapture(event.pointerId);
  }

  function handleCropMovePointerDown(event: React.PointerEvent<SVGPolygonElement>) {
    if (event.button !== 0 || (!geometryEditing && !analysisRegionEditing)) return;
    const point = pointInMedia(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current?.setPointerCapture(event.pointerId);
    const corners = analysisRegionEditing && analysisRegion
      ? ([
          { x: analysisRegion.x, y: analysisRegion.y },
          { x: analysisRegion.x + analysisRegion.width, y: analysisRegion.y },
          { x: analysisRegion.x + analysisRegion.width, y: analysisRegion.y + analysisRegion.height },
          { x: analysisRegion.x, y: analysisRegion.y + analysisRegion.height },
        ] as Quad)
      : recipe.geometry.corners.map((corner) => ({ ...corner })) as Quad;
    cropMoveRef.current = { pointerId: event.pointerId, start: point, corners };
  }

  function handleSampleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (didPanRef.current) {
      didPanRef.current = false;
      return;
    }
    if (!canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const localX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const localY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    if (dustRemoval && onSpotsChange) {
      const current = spots ?? [];
      const hitIndex = current.findIndex((spot) => Math.hypot(spot.x - localX, spot.y - localY) <= Math.max(spot.r * 2, 0.02));
      if (hitIndex >= 0) {
        onSpotsChange(current.filter((_, index) => index !== hitIndex));
      } else {
        onSpotsChange([...current, { x: localX, y: localY, r: dustBrushSize ?? 0.012 }]);
      }
      return;
    }
    if (!sampling || geometryEditing || !sourceRef.current) return;
    void requestAnalysis('sample', { normalizedX: localX, normalizedY: localY }).then((result) => {
      if (result?.kind === 'sample') onSample({ rgb: result.rgb, linearRgb: result.linearRgb });
    });
  }

  const sourceOverlayCorners: Quad = analysisRegion
    ? [
        { x: analysisRegion.x, y: analysisRegion.y },
        { x: analysisRegion.x + analysisRegion.width, y: analysisRegion.y },
        { x: analysisRegion.x + analysisRegion.width, y: analysisRegion.y + analysisRegion.height },
        { x: analysisRegion.x, y: analysisRegion.y + analysisRegion.height },
      ]
    : recipe.geometry.corners;
  const overlayCorners: Quad = geometryEditing && !analysisRegion
    ? sourceOverlayCorners.map((point) => orientNormalizedPoint(point, recipe.geometry)) as Quad
    : sourceOverlayCorners;
  const polygonPoints = overlayCorners
    .map((corner) => `${corner.x * displaySize.width},${corner.y * displaySize.height}`)
    .join(' ');
  const cropHandles = [
    ...overlayCorners,
    { x: (overlayCorners[0].x + overlayCorners[1].x) / 2, y: (overlayCorners[0].y + overlayCorners[1].y) / 2 },
    { x: (overlayCorners[1].x + overlayCorners[2].x) / 2, y: (overlayCorners[1].y + overlayCorners[2].y) / 2 },
    { x: (overlayCorners[2].x + overlayCorners[3].x) / 2, y: (overlayCorners[2].y + overlayCorners[3].y) / 2 },
    { x: (overlayCorners[3].x + overlayCorners[0].x) / 2, y: (overlayCorners[3].y + overlayCorners[0].y) / 2 },
  ];
  const gridLines = [1 / 3, 2 / 3].flatMap((fraction) => {
    const [tl, tr, br, bl] = overlayCorners;
    const top = { x: tl.x + (tr.x - tl.x) * fraction, y: tl.y + (tr.y - tl.y) * fraction };
    const bottom = { x: bl.x + (br.x - bl.x) * fraction, y: bl.y + (br.y - bl.y) * fraction };
    const left = { x: tl.x + (bl.x - tl.x) * fraction, y: tl.y + (bl.y - tl.y) * fraction };
    const right = { x: tr.x + (br.x - tr.x) * fraction, y: tr.y + (br.y - tr.y) * fraction };
    return [
      `M${top.x * displaySize.width} ${top.y * displaySize.height}L${bottom.x * displaySize.width} ${bottom.y * displaySize.height}`,
      `M${left.x * displaySize.width} ${left.y * displaySize.height}L${right.x * displaySize.width} ${right.y * displaySize.height}`,
    ];
  });

  return (
    <div
      ref={stageRef}
      className={`develop-stage ${sampling ? 'is-sampling' : ''} ${geometryEditing ? 'is-geometry-editing' : ''} ${analysisRegion ? 'has-analysis-region' : ''} ${analysisRegionEditing ? 'is-analysis-region-editing' : ''} ${isPanning ? 'is-panning' : ''} ${spacePressed ? 'space-pan-ready' : ''}`}
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onAuxClick={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={mediaRef}
        className="preview-media"
        style={{
          width: displaySize.width,
          height: displaySize.height,
          transform: `translate(-50%, -50%) translate3d(${viewTransform.x}px, ${viewTransform.y}px, 0) scale(${viewTransform.zoom})`,
        }}
      >
        <canvas ref={canvasRef} onClick={handleSampleClick} style={fullProof ? { display: 'none' } : undefined} />
        {fullProof && <img className="full-resolution-proof" src={fullProof.url} draggable={false} alt="全分辨率检查预览" />}
        {(geometryEditing || sampling || analysisRegion) && displaySize.width > 0 && (
          <svg className={`geometry-overlay ${analysisRegion ? 'analysis-region-overlay' : sampling ? 'sampling-overlay' : 'crop-overlay'}`} viewBox={`0 0 ${displaySize.width} ${displaySize.height}`} aria-label={analysisRegion ? '胶片校准识别区域' : sampling ? '完整素材片基取样范围' : '照片裁切控制层'}>
            <path className="crop-shade" fillRule="evenodd" d={`M0 0H${displaySize.width}V${displaySize.height}H0Z M${polygonPoints.replaceAll(' ', 'L')}Z`} />
            <polygon className="crop-area" points={polygonPoints} strokeWidth={2 / viewTransform.zoom} onPointerDown={handleCropMovePointerDown} />
            {geometryEditing && gridLines.map((path, index) => <path key={index} className="crop-grid-line" d={path} strokeWidth={1 / viewTransform.zoom} />)}
            {(geometryEditing || analysisRegionEditing) && cropHandles.map((corner, index) => (
              <rect
                key={index}
                className={dragCorner === index ? 'active' : ''}
                x={corner.x * displaySize.width - 5 / viewTransform.zoom}
                y={corner.y * displaySize.height - 5 / viewTransform.zoom}
                width={10 / viewTransform.zoom}
                height={10 / viewTransform.zoom}
                rx={1.5 / viewTransform.zoom}
                strokeWidth={2.5 / viewTransform.zoom}
                onPointerDown={(event) => handleCornerPointerDown(index, event)}
              />
            ))}
          </svg>
        )}
        {dustRemoval && displaySize.width > 0 && (spots ?? []).map((spot, index) => (
          <svg key={index} className="dust-overlay" viewBox={`0 0 ${displaySize.width} ${displaySize.height}`} aria-label="除尘标记">
            <circle
              className="dust-spot"
              cx={spot.x * displaySize.width}
              cy={spot.y * displaySize.height}
              r={Math.max(5 / viewTransform.zoom, spot.r * displaySize.width)}
              strokeWidth={1.5 / viewTransform.zoom}
            />
          </svg>
        ))}
      </div>

      <div className="preview-navigation" aria-label="预览缩放控制">
        <button title="缩小（Ctrl/Cmd+-）" aria-label="缩小" onClick={() => zoomBy(0.8)}><Minus size={14} /></button>
        <button className="zoom-value" disabled={proofLoading} title="生成并按原始像素 100% 检查（Ctrl/Cmd+1）" onClick={showActualSize}>{proofLoading ? '原图…' : `${Math.round(viewTransform.zoom * 100)}%`}</button>
        <button title="放大（Ctrl/Cmd++）" aria-label="放大" onClick={() => zoomBy(1.25)}><Plus size={14} /></button>
        <span />
        <button title="适合窗口（Ctrl/Cmd+0）" aria-label="适合窗口" onClick={fitView}><Maximize2 size={14} /></button>
      </div>
      <div className="preview-hud">
        <span>{(CAMERA_RAW_FORMATS.has(frame.format.toUpperCase()) && (compare || sampling || !recipe.density.enabled))
          ? '相机 RAW · 相机矩阵 / sRGB 显示（处理数据保持线性）'
          : splitCompare
          ? '原片（左） | 调整后（右）'
          : sampling
          ? '完整原始素材 · 请点击片基边缘'
          : processing
          ? '正在更新预览…'
          : compare
            ? (filmTypeUnknown ? '原始胶片' : negativeWorkflow ? '原始负片' : '原始正片')
            : filmTypeUnknown
              ? '原始胶片 · 等待识别片种'
              : negativeWorkflow
              ? (recipe.density.enabled ? '密度转换已启用 · sRGB 预览' : '原始负片 · 等待整卷校准')
              : '正片 · sRGB 预览'}</span>
        <span>{fullProof ? '全分辨率检查' : '16 位开发代理'} · {displaySize.width} × {displaySize.height}{fullProof ? '' : ' · 放大到 100% 自动载入原图'} · 双指移动 / 捏合缩放 / 中键拖动</span>
      </div>
      {geometryEditing && <div className="sampling-tip">拖动裁切框、边线或控制点 · 框外会被移除 · 中键移动</div>}
      {analysisRegionEditing && <div className="sampling-tip">仅框选用于识别的胶片区域 · 不会裁切或改变照片几何</div>}
    </div>
  );
});
