import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Aperture, Check, ChevronRight, ClipboardPaste, Copy, Crop, Download, FolderOpen, ImagePlus,
  Images, Info, LoaderCircle, LocateFixed, Play, RefreshCw, RotateCcw, Save,
  Sparkles, TriangleAlert, X, Undo2, Redo2,
  RotateCw, FlipHorizontal2, FlipVertical2, ScanLine, Plus, Trash2, Pencil,
  Film, Files, Grid2X2, List, ChevronLeft, Search, Star, DatabaseBackup,
  Link2, Unlink2, Monitor, MousePointer2, ShieldCheck,
  Palette,
} from 'lucide-react';
import { createDefaultRecipe, createRecipeForFilmType, identityCurve, rectToQuad, upgradeRecipeToCurrent } from '../shared/defaults';
import { quadToCrop } from '../core/geometry';
import { deserializeCubeLut, type CubeLut } from '../core/cube';
import type { WaveformData } from '../core/histogram';
import type {
  AssetKind, AssetSummary, BackupInfo, BuiltinLook, ContactSheetConfig, EditRecipe, ExportFormat, ExportProgress,
  FilmType, FrameRegionInput, FrameSummary, ImportDuplicate, ImportRecognition, ImportResult, PasteScope, RawImportJob, RGB, RecipePreset, RollCalibration, RollInput, RollSummary,
} from '../shared/types';
import { DevelopCanvas, type DevelopCanvasHandle } from './components/DevelopCanvas';
import { ManualFramer } from './components/ManualFramer';
import { Histogram } from './components/Histogram';
import { RangeControl } from './components/RangeControl';
import { CurveEditor } from './components/CurveEditor';
import { InfoTip } from './components/InfoTip';
import { FilmCalibration } from './components/FilmCalibration';
import { ViewErrorBoundary } from './components/ViewErrorBoundary';
import { recordLocalTiming } from './local-telemetry';
import { ShortcutHelp } from './components/ShortcutHelp';
import { ExportPreview } from './components/ExportPreview';
import { BoundedNumberInput } from './components/BoundedNumberInput';
import { VirtualFilmstrip } from './components/VirtualFilmstrip';
import { AppShell } from './components/AppShell';
import { EditorShell } from './components/EditorShell';
import { CustomSelect } from './components/CustomSelect';
import { AutocompleteInput } from './components/AutocompleteInput';
import { CustomDatePicker, todayString } from './components/CustomDatePicker';
import { VirtualPhotoGrid } from './components/VirtualPhotoGrid';
import { CAMERA_SUGGESTIONS, DEVELOPMENT_SUGGESTIONS, LENS_SUGGESTIONS } from './data/roll-suggestions';
import { editorToolDefinition, type EditorToolId } from './navigation';

type ViewName = 'library' | 'calibrate' | 'segment' | 'develop';
type FrameTool = Extract<EditorToolId, 'adjust' | 'crop' | 'dust'>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type AdjustSection = 'basic' | 'tone' | 'color' | 'style' | 'curves' | 'advanced' | 'presets';
type SettingsSection = 'import' | 'interaction' | 'appearance' | 'export' | 'backup' | 'about';
/** BUG-014：按画面保存的撤销/重做历史，切帧与刷新不再清空。 */
interface FrameHistory {
  undo: EditRecipe[];
  redo: EditRecipe[];
}

const SETTINGS_SECTIONS = [
  ['import', '导入识别', Sparkles],
  ['interaction', '操作动效', MousePointer2],
  ['appearance', '外观材质', Palette],
  ['export', '导出默认', Download],
  ['backup', '数据备份', DatabaseBackup],
  ['about', '关于与隐私', Aperture],
] as const;

/** UI-02：设置搜索的别名词典（分类名之外的常见说法）。 */
const SETTINGS_SECTION_HINTS: Record<SettingsSection, string> = {
  import: '识别 片种 胶片 OCR 素材 反相 元数据',
  interaction: '动效 手势 缩放 触控板 动画 灵敏度',
  appearance: '外观 主题 模糊 玻璃 材质 高亮',
  export: '格式 JPEG PNG TIFF DNG 命名 覆盖 颜色 质量 分辨率',
  backup: '备份 恢复 缓存 重定位 原片 磁盘 数据库',
  about: '关于 隐私 版本 版权 许可 声明',
};

function settingsSectionMatches(section: (typeof SETTINGS_SECTIONS)[number], query: string): boolean {
  const id = section[0] as SettingsSection;
  return section[1].includes(query) || SETTINGS_SECTION_HINTS[id].includes(query);
}

interface AppSettings {
  autoDetectFilmType: boolean;
  motionLevel: 'full' | 'reduced' | 'off';
  materialLevel: 'soft' | 'balanced' | 'rich';
  interfaceDensity: 'comfortable' | 'compact';
  showTooltips: boolean;
  checkerboard: boolean;
  defaultExportFormat: ExportFormat;
  defaultContactStyle: ContactSheetConfig['style'];
  autoOpenExportFolder: boolean;
  defaultExportDirectory: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  autoDetectFilmType: true,
  motionLevel: 'full',
  materialLevel: 'balanced',
  interfaceDensity: 'comfortable',
  showTooltips: true,
  checkerboard: true,
  defaultExportFormat: 'jpeg',
  defaultContactStyle: 'classic',
  autoOpenExportFolder: false,
  defaultExportDirectory: '',
};

function loadSettings(): AppSettings {
  try {
    const stored = JSON.parse(localStorage.getItem('chromik-settings') ?? '{}') as Partial<AppSettings> & { animations?: boolean };
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      motionLevel: stored.motionLevel ?? (stored.animations === false ? 'off' : DEFAULT_SETTINGS.motionLevel),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const FILM_TYPE_LABELS: Record<FilmType, string> = {
  color_negative: '彩色负片',
  color_slide: '彩色反转片',
  bw_negative: '黑白负片',
  bw_slide: '黑白反转片',
  unknown: '自动识别',
};

const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  strip: '长条多张', contact: '印样多张', single: '单张', unknown: '未分类',
};

const LOOK_LABELS: Record<BuiltinLook, string> = {
  neutral: '自然',
  warm_print: '暖调相纸',
  classic_color: '经典彩色',
  cool_slide: '清透反转',
  silver_bw: '银盐黑白',
};

function emptyRollInput(): RollInput {
  return { name: '', filmType: 'unknown', camera: '', lens: '', filmStock: '', development: '', shotDate: todayString(), notes: '' };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function SlidingSegment<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
  label?: string;
}) {
  const index = Math.max(0, options.findIndex(([candidate]) => candidate === value));
  const edge = index === 0 ? 'left' : index === options.length - 1 ? 'right' : 'middle';
  return <div className="sliding-segment" data-edge={edge} role="group" aria-label={label} style={{ '--segment-index': index, '--segment-count': options.length } as CSSProperties}>
    <span className="sliding-segment-indicator" aria-hidden="true" />
    {options.map(([candidate, text]) => <button key={candidate} className={candidate === value ? 'active' : ''} aria-pressed={candidate === value} onClick={() => onChange(candidate)}>{text}</button>)}
  </div>;
}

interface ConfirmDialogState {
  title: string;
  detail: string;
  confirmLabel: string;
  action: () => Promise<void>;
  tone?: 'danger' | 'warning';
  eyebrow?: string;
}

interface RecognitionConflictState {
  rollId: string;
  current: RollSummary;
  proposed: Partial<Pick<RollInput, 'filmType' | 'filmStock' | 'iso'>>;
  sourceName: string;
}

interface BlockingProgressState {
  title: string;
  detail: string;
  percent: number;
  previewUrl?: string;
}

function disabledReasonFor(button: HTMLButtonElement): string {
  const explicit = button.dataset.disabledReason;
  if (explicit) return explicit;
  const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.trim();
  if (/撤销/.test(label)) return '当前没有可以撤销的操作';
  if (/重做/.test(label)) return '当前没有可以重做的操作';
  if (/对比|原图/.test(label)) return '请先选择一张照片并等待预览完成';
  if (/导出|接触印样/.test(label)) return '当前范围内没有可导出的处理后画面';
  if (/删除|移除|清除/.test(label)) return '请先选择要移除的项目';
  if (/保存|完成/.test(label)) return '当前内容尚未达到可保存条件';
  if (/识别|判断|校准|采样/.test(label)) return '请先选择可读取的原始素材并完成必要步骤';
  if (/分帧/.test(label)) return '请先选择需要分帧的长条或印样素材';
  return '当前条件不满足，完成所需选择后即可使用';
}

function DisabledHintLayer() {
  const [hint, setHint] = useState<{ text: string; x: number; y: number; pressed: boolean; below: boolean }>();
  // Measure the topbar height so the popover never paints under the app chrome.
  const topbarThresholdRef = useRef(74);
  useEffect(() => {
    topbarThresholdRef.current = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 74;
  }, []);
  useEffect(() => {
    const locate = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest('button:disabled') : null;
      if (!(target instanceof HTMLButtonElement)) return setHint(undefined);
      const rect = target.getBoundingClientRect();
      const below = rect.top < (topbarThresholdRef.current + 8);
      setHint({ text: disabledReasonFor(target), x: Math.min(window.innerWidth - 170, Math.max(170, rect.left + rect.width / 2)), y: below ? rect.bottom + 9 : rect.top - 9, pressed: event.type === 'pointerdown', below });
    };
    const clear = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('button:disabled')) return;
      setHint(undefined);
    };
    document.addEventListener('pointermove', locate, true);
    document.addEventListener('pointerdown', locate, true);
    document.addEventListener('pointerout', clear, true);
    return () => {
      document.removeEventListener('pointermove', locate, true);
      document.removeEventListener('pointerdown', locate, true);
      document.removeEventListener('pointerout', clear, true);
    };
  }, []);
  return hint ? createPortal(<div className={`disabled-hint-popover ${hint.pressed ? 'pressed' : ''} ${hint.below ? 'below' : ''}`} role="status" aria-live="polite" style={{ left: hint.x, top: hint.y }}>{hint.text}</div>, document.body) : null;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [appInfo, setAppInfo] = useState<{ version: string; packaged: boolean } | undefined>(undefined);
  const [recoveryIssues, setRecoveryIssues] = useState(0);
  useEffect(() => {
    void window.filmLab.getAppInfo().then(setAppInfo).catch(() => undefined);
    // DATA-01：损坏配方回退的可观测性（设置→数据备份 展示）。
    void window.filmLab.getRecoveryIssues().then((summary) => setRecoveryIssues(summary.count)).catch(() => undefined);
  }, []);
  useEffect(() => {
    // REL-03：启动更新检查（本地 version.json 清单），只提示不自动下载。
    return window.filmLab.onUpdateAvailable((update) => {
      showToast(`发现新版本 ${update.version}${update.notes ? `：${update.notes}` : ''}，可到下载页获取`, 'normal', update.url ? {
        label: '打开下载页',
        run: () => { void window.filmLab.openReleaseUrl(update.url!); },
      } : undefined);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState<ViewName>('library');
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rolls, setRolls] = useState<RollSummary[]>([]);
  const [activeRollId, setActiveRollId] = useState<string>();
  const [selectedRollIds, setSelectedRollIds] = useState<Set<string>>(new Set());
  const [rollContextMenu, setRollContextMenu] = useState<{ x: number; y: number; rollId: string }>();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [libraryMode, setLibraryMode] = useState<'assets' | 'frames'>('frames');
  const [libraryLayoutMode, setLibraryLayoutMode] = useState<'grid' | 'list'>('grid');
  const [libraryThumbnailSize, setLibraryThumbnailSize] = useState(190);
  const [libraryTransitioning, setLibraryTransitioning] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [selectedLibraryFrameIds, setSelectedLibraryFrameIds] = useState<Set<string>>(new Set());
  const [segmentAssetId, setSegmentAssetId] = useState<string>();
  const [rollEditorOpen, setRollEditorOpen] = useState(false);
  const [rollEditorMode, setRollEditorMode] = useState<'create' | 'edit'>('create');
  const [rollDraft, setRollDraft] = useState<RollInput>(emptyRollInput());
  const [frames, setFrames] = useState<FrameSummary[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<string>();
  const [recipe, setRecipe] = useState<EditRecipe>(createDefaultRecipe());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [blockingProgress, setBlockingProgress] = useState<BlockingProgressState>();
  const [mergingHdr, setMergingHdr] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [compare, setCompare] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [histogram, setHistogram] = useState<[number[], number[], number[]] | null>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [geometryEditing, setGeometryEditing] = useState(false);
  const [dustRemoval, setDustRemoval] = useState(false);
  const [dustRadius, setDustRadius] = useState(0.012);
  const [dustDetecting, setDustDetecting] = useState(false);
  const [splitCompare, setSplitCompare] = useState(false);
  // BUG-014：撤销/重做按 frameId 分片保存，切帧与图库刷新不再清空历史。
  const [histories, setHistories] = useState<Map<string, FrameHistory>>(() => new Map());
  const [curveChannel, setCurveChannel] = useState<'rgb' | 'red' | 'green' | 'blue'>('rgb');
  const [copiedGrade, setCopiedGrade] = useState<EditRecipe['grade']>();
  const [adjustSections, setAdjustSections] = useState<Set<AdjustSection>>(() => new Set(['basic']));
  const [luts, setLuts] = useState<Array<{ id: string; title: string; type: '1d' | '3d'; size: number }>>([]);
  const [activeLut, setActiveLut] = useState<CubeLut>();
  const lutCacheRef = useRef(new Map<string, CubeLut>());
  const [toast, setToast] = useState<{ message: string; tone: 'normal' | 'error'; action?: { label: string; run: () => void } }>();
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>();
  const [dialogBusy, setDialogBusy] = useState(false);
  const [importReview, setImportReview] = useState<{ rollId: string; items: ImportRecognition[] }>();
  const [duplicateImport, setDuplicateImport] = useState<{ id: string; items: ImportDuplicate[] }>();
  const [recognitionConflict, setRecognitionConflict] = useState<RecognitionConflictState>();
  const [automaticRecognitionStatus, setAutomaticRecognitionStatus] = useState<'idle' | 'running' | 'matched' | 'unmatched'>('idle');
  const [exportDirectoryPrompt, setExportDirectoryPrompt] = useState<'export' | 'contact'>();
  const [rememberExportDirectory, setRememberExportDirectory] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('import');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [presets, setPresets] = useState<RecipePreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [starFilter, setStarFilter] = useState(false);
  const [pasteScopeOpen, setPasteScopeOpen] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState<'relocate' | 'cache'>();
  const [exportDirectory, setExportDirectory] = useState(settings.defaultExportDirectory);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(settings.defaultExportFormat);
  const [exportQuality, setExportQuality] = useState(92);
  const [exportBitDepth, setExportBitDepth] = useState<8 | 16>(8);
  const [preserveOriginalSize, setPreserveOriginalSize] = useState(true);
  const [exportWidth, setExportWidth] = useState(6000);
  const [exportHeight, setExportHeight] = useState(4000);
  const [exportLockAspect, setExportLockAspect] = useState(true);
  const [exportSharpening, setExportSharpening] = useState(20);
  const [exportBorderPadding, setExportBorderPadding] = useState(0);
  const [exportColorSpace, setExportColorSpace] = useState<'srgb' | 'p3'>('srgb');
  const [exportAllowUpscale, setExportAllowUpscale] = useState(false);
  const [exportConflict, setExportConflict] = useState<'rename' | 'skip'>('rename');
  const [exportSelection, setExportSelection] = useState<Set<string>>(new Set());
  const [exportFrames, setExportFrames] = useState<FrameSummary[]>([]);
  const [exportRollIds, setExportRollIds] = useState<Set<string>>(new Set());
  const [exportRangeLabel, setExportRangeLabel] = useState('当前胶卷');
  const [exportPreviewId, setExportPreviewId] = useState<string>();
  const [exportProgress, setExportProgress] = useState<ExportProgress>();
  const [contactConfig, setContactConfig] = useState<ContactSheetConfig>({
    style: settings.defaultContactStyle, resolution: 'best', columns: 4, showFileName: true, showMetadata: true, title: '', format: 'jpeg',
  });
  const developRef = useRef<DevelopCanvasHandle>(null);
  const rollEditorRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const continuousEditRef = useRef(false);
  const continuousUndoCapturedRef = useRef(false);
  const recipeRef = useRef(recipe);
  const recipeDirtyRef = useRef(false);
  const recipeCacheRef = useRef(new Map<string, EditRecipe>());
  const refreshTokenRef = useRef(0);
  const activeRollIdRef = useRef(activeRollId);
  const selectedFrameIdRef = useRef(selectedFrameId);
  const lastActedProgressRef = useRef<ExportProgress | undefined>(undefined);
  const importAbortRef = useRef<AbortController | undefined>(undefined);
  // Mount-once refresh with StrictMode-safe guard. The ref survives the
  // dev-only mount→cleanup→mount cycle so we never load rolls twice or
  // race the half-edited recipe persistence of the first pass.
  const initialRefreshRef = useRef(false);

  const selectedFrame = useMemo(
    () => frames.find((frame) => frame.id === selectedFrameId),
    [frames, selectedFrameId],
  );
  const activeHistory = histories.get(selectedFrameId ?? '') ?? { undo: [], redo: [] };
  const undoStack = activeHistory.undo;
  const redoStack = activeHistory.redo;
  const activeRoll = rolls.find((roll) => roll.id === activeRollId);
  const segmentAsset = assets.find((asset) => asset.id === segmentAssetId);
  const segmentFrames = useMemo(
    () => frames.filter((frame) => frame.assetId === segmentAssetId),
    [frames, segmentAssetId],
  );
  const selectedFrameAsset = assets.find((asset) => asset.id === selectedFrame?.assetId);
  const negativeWorkflow = Boolean(activeRoll?.filmType === 'color_negative' || activeRoll?.filmType === 'bw_negative');
  const filmTypeUnknown = activeRoll?.filmType === 'unknown';
  const developTool: FrameTool = geometryEditing ? 'crop' : dustRemoval ? 'dust' : 'adjust';
  const activeEditorTool: EditorToolId = view === 'calibrate' ? 'calibrate' : view === 'segment' ? 'segment' : developTool;
  const editorActive = view !== 'library';
  const editorContext = useMemo(() => ({
    hasRoll: Boolean(activeRoll),
    hasAssets: assets.length > 0,
    hasFrames: frames.length > 0,
  }), [activeRoll, assets.length, frames.length]);
  const editorIdentity = useMemo(() => {
    if (!activeRoll) return [];
    if (view === 'calibrate') return [activeRoll.name, '整卷校准'];
    if (view === 'segment') return [activeRoll.name, segmentAsset?.name ?? '原始素材'];
    return [activeRoll.name, selectedFrameAsset?.name ?? '素材', selectedFrame?.name ?? '当前照片'];
  }, [activeRoll, segmentAsset?.name, selectedFrame?.name, selectedFrameAsset?.name, view]);

  const showToast = useCallback((message: string, tone: 'normal' | 'error' = 'normal', action?: { label: string; run: () => void }) => {
    setToast({ message, tone, action });
  }, []);

  function switchLibraryMode(nextMode: 'assets' | 'frames') {
    if (nextMode === libraryMode || libraryTransitioning) return;
    setLibraryTransitioning(true);
    window.setTimeout(() => {
      setLibraryMode(nextMode);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => setLibraryTransitioning(false)));
    }, 120);
  }

  function toggleAdjustSection(section: AdjustSection) {
    setAdjustSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  function rollToInput(roll: RollSummary, changes: Partial<RollInput> = {}): RollInput {
    return {
      name: roll.name, filmType: roll.filmType, camera: roll.camera, lens: roll.lens,
      filmStock: roll.filmStock, iso: roll.iso, development: roll.development,
      shotDate: roll.shotDate, notes: roll.notes, ...changes,
    };
  }

  async function applyRecognizedMetadata(conflict: RecognitionConflictState) {
    setDialogBusy(true);
    try {
      const updated = await window.filmLab.updateRoll(conflict.rollId, rollToInput(conflict.current, conflict.proposed));
      if (activeRollIdRef.current === conflict.rollId) await refresh(conflict.rollId);
      else setRolls((current) => current.map((roll) => roll.id === updated.id ? updated : roll));
      setRecognitionConflict(undefined);
      setAutomaticRecognitionStatus('matched');
      showToast('已采用新素材自动识别到的胶片信息');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setDialogBusy(false);
    }
  }

  async function recognizeImportedMetadata(rollId: string, importedItems: ImportRecognition[]) {
    if (!settings.autoDetectFilmType || !importedItems.length) return;
    setAutomaticRecognitionStatus('running');
    try {
      const current = (await window.filmLab.listRolls()).find((roll) => roll.id === rollId);
      if (!current) return;
      const candidates = importedItems.slice(0, 3);
      const [filmResults, edgeResults] = await Promise.all([
        Promise.allSettled(candidates.map((item) => window.filmLab.detectFilmType(rollId, item.id, false))),
        Promise.allSettled(candidates.map((item) => window.filmLab.recognizeFilmEdge(rollId, item.id, false))),
      ]);
      const bestFilm = filmResults
        .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof window.filmLab.detectFilmType>>> => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter((result) => result.filmType !== 'unknown' && result.confidence >= 0.55)
        .sort((left, right) => right.confidence - left.confidence)[0];
      const bestEdge = edgeResults
        .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof window.filmLab.recognizeFilmEdge>>> => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter((result) => Object.keys(result.detected).length > 0)
        .sort((left, right) => (Object.keys(right.detected).length - Object.keys(left.detected).length) || right.confidence - left.confidence)[0];
      const proposed: RecognitionConflictState['proposed'] = {};
      if (bestFilm) proposed.filmType = bestFilm.filmType;
      if (bestEdge?.detected.filmType) proposed.filmType = bestEdge.detected.filmType;
      if (bestEdge?.detected.filmStock) proposed.filmStock = bestEdge.detected.filmStock;
      if (bestEdge?.detected.iso) proposed.iso = bestEdge.detected.iso;
      if (!Object.keys(proposed).length) {
        setAutomaticRecognitionStatus('unmatched');
        // AUTO-06：失败提示带下一步操作，而不是只报错。
        showToast('没有可靠识别到胶片类型或片基文字，胶卷信息保持不变。可尝试重新识别，或手动编辑胶卷信息', 'error', {
          label: '手动编辑胶卷',
          run: () => { setView('library'); openEditRoll(current); },
        });
        return;
      }
      const conflicts = (proposed.filmType && current.filmType !== 'unknown' && proposed.filmType !== current.filmType)
        || (proposed.filmStock && current.filmStock && proposed.filmStock.toLowerCase() !== current.filmStock.toLowerCase())
        || (proposed.iso && current.iso && proposed.iso !== current.iso);
      if (conflicts) {
        setRecognitionConflict({ rollId, current, proposed, sourceName: candidates[0]?.name ?? '新素材' });
        setAutomaticRecognitionStatus('matched');
        return;
      }
      const updated = await window.filmLab.updateRoll(rollId, rollToInput(current, proposed));
      if (activeRollIdRef.current === rollId) await refresh(rollId);
      else setRolls((items) => items.map((roll) => roll.id === updated.id ? updated : roll));
      setAutomaticRecognitionStatus('matched');
      const label = proposed.filmStock || (proposed.filmType ? FILM_TYPE_LABELS[proposed.filmType] : '胶片信息');
      showToast(`已自动识别：${label}${proposed.iso ? ` · ISO ${proposed.iso}` : ''}`);
    } catch (error) {
      setAutomaticRecognitionStatus('unmatched');
      showToast(`自动识别未完成：${error instanceof Error ? error.message : String(error)}`, 'error', {
        label: '重试识别',
        run: () => { void recognizeImportedMetadata(rollId, importedItems); },
      });
    }
  }

  const refresh = useCallback(async (preferredRollId?: string) => {
    const token = ++refreshTokenRef.current;
    try {
      const dirtyFrameId = selectedFrameIdRef.current;
      if (dirtyFrameId && recipeDirtyRef.current) {
        await window.filmLab.saveRecipe(dirtyFrameId, recipeRef.current);
        if (token !== refreshTokenRef.current) return;
        recipeDirtyRef.current = false;
      }
      const nextRolls = await window.filmLab.listRolls();
      if (token !== refreshTokenRef.current) return;
      const rollId = preferredRollId && nextRolls.some((roll) => roll.id === preferredRollId)
        ? preferredRollId
        : activeRollIdRef.current && nextRolls.some((roll) => roll.id === activeRollIdRef.current)
          ? activeRollIdRef.current
          : nextRolls[0]?.id;
      setRolls(nextRolls);
      activeRollIdRef.current = rollId;
      setActiveRollId(rollId);
      const [nextAssets, nextFrames] = rollId
        ? await Promise.all([window.filmLab.listAssets(rollId), window.filmLab.listFrames(rollId)])
        : [[], []];
      if (token !== refreshTokenRef.current) return;
      setAssets(nextAssets);
      setFrames(nextFrames);
      recipeCacheRef.current = new Map(nextFrames.map((frame) => [frame.id, frame.recipe]));
      const selected = nextFrames.find((frame) => frame.id === selectedFrameIdRef.current) ?? nextFrames[0];
      setSelectedFrameId(selected?.id);
      const nextRecipe = selected?.recipe ?? createDefaultRecipe();
      recipeRef.current = nextRecipe;
      setRecipe(nextRecipe);
      recipeDirtyRef.current = false;
      setSelectedAssetIds(new Set());
      setSelectedLibraryFrameIds(new Set());
      setSelectedRollIds(rollId ? new Set([rollId]) : new Set());
      // BUG-014：刷新不再清空撤销历史；只裁剪已不属于当前图库的画面，
      // 避免 Map 随编辑过的画面数量无界增长。
      setHistories((current) => {
        const kept = new Set(nextFrames.map((frame) => frame.id));
        const next = new Map<string, FrameHistory>();
        for (const [frameId, history] of current) if (kept.has(frameId)) next.set(frameId, history);
        return next;
      });
      return { rolls: nextRolls, assets: nextAssets, frames: nextFrames };
    } catch (error) {
      if (token !== refreshTokenRef.current) return;
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return undefined;
    } finally {
      if (token !== refreshTokenRef.current) return;
      setLoading(false);
    }
  }, [showToast]);

  // Mount-once refresh with StrictMode-safe guard.
  useEffect(() => {
    if (initialRefreshRef.current) return;
    initialRefreshRef.current = true;
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { activeRollIdRef.current = activeRollId; }, [activeRollId]);
  useEffect(() => { selectedFrameIdRef.current = selectedFrameId; }, [selectedFrameId]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), toast.action ? 12_000 : 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    void window.filmLab.listPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== 'backup') return;
    void window.filmLab.listBackups().then(setBackups).catch(() => setBackups([]));
  }, [settingsOpen, settingsSection, backupsOpen]);

  function deepCopyGrade(grade: EditRecipe['grade']): EditRecipe['grade'] {
    return {
      ...grade,
      printerLights: [...grade.printerLights] as RGB,
      vignette: { ...grade.vignette },
      cmy: { ...grade.cmy },
      curves: {
        rgb: grade.curves.rgb.map((point) => ({ ...point })),
        red: grade.curves.red.map((point) => ({ ...point })),
        green: grade.curves.green.map((point) => ({ ...point })),
        blue: grade.curves.blue.map((point) => ({ ...point })),
      },
    };
  }

  function mergeGradeForPaste(current: EditRecipe['grade'], source: EditRecipe['grade'], scope: PasteScope): EditRecipe['grade'] {
    switch (scope) {
      case 'all': return deepCopyGrade(source);
      case 'exposure': return { ...current, exposureEv: source.exposureEv };
      case 'color': return {
        ...current,
        temperature: source.temperature,
        tint: source.tint,
        saturation: source.saturation,
        vibrance: source.vibrance,
        printerLights: [...source.printerLights] as RGB,
        cmy: { ...source.cmy },
        blackAndWhite: source.blackAndWhite,
      };
      case 'style': return { ...current, look: source.look, lookStrength: source.lookStrength, lutId: source.lutId };
      case 'curves': return { ...current, curves: deepCopyGrade(source).curves };
    }
  }

  async function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    try {
      const preset = await window.filmLab.savePreset(name, recipe.grade);
      setPresets((current) => [...current, preset]);
      setPresetName('');
      showToast(`已保存预设「${preset.name}」`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function applyPreset(preset: RecipePreset) {
    updateRecipe((current) => ({ ...current, grade: deepCopyGrade(preset.grade) }));
    showToast(`已应用预设「${preset.name}」`);
  }

  async function deletePreset(presetId: string) {
    try {
      await window.filmLab.deletePreset(presetId);
      setPresets((current) => current.filter((preset) => preset.id !== presetId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function toggleFrameStar(frame: FrameSummary) {
    try {
      const updated = await window.filmLab.setFrameMeta(frame.id, { starred: !frame.starred });
      setFrames((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function toggleRollStar(roll: RollSummary) {
    try {
      const updated = await window.filmLab.setRollMeta(roll.id, { starred: !roll.starred });
      setRolls((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function runPaste(scope: PasteScope) {
    const ids = [...selectedLibraryFrameIds];
    if (!ids.length || !selectedFrame) return;
    try {
      const { updated } = await window.filmLab.pasteRecipeToFrames(ids, recipe, scope);
      const targetIds = new Set(ids);
      const appliedAt = Date.now();
      const currentFrameId = selectedFrameIdRef.current;
      // BUG-005：粘贴落到当前帧时同样入撤销栈，否则 ⌘/Ctrl+Z 会跳过本次粘贴。
      const currentTarget = frames.find((frame) => frame.id === currentFrameId && targetIds.has(frame.id));
      if (currentTarget) pushFrameHistory(currentFrameId, currentTarget.recipe, true);
      const nextFrames = frames.map((frame) => {
        if (!targetIds.has(frame.id)) return frame;
        const nextRecipe = { ...frame.recipe, grade: mergeGradeForPaste(frame.recipe.grade, recipe.grade, scope), updatedAt: appliedAt };
        recipeCacheRef.current.set(frame.id, nextRecipe);
        if (frame.id === currentFrameId) {
          recipeRef.current = nextRecipe;
          setRecipe(nextRecipe);
          recipeDirtyRef.current = false;
        }
        return { ...frame, recipe: nextRecipe };
      });
      setFrames(nextFrames);
      setPasteScopeOpen(false);
      showToast(`已粘贴到 ${updated} 张画面`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function createBackup() {
    setBackupBusy(true);
    try {
      const info = await window.filmLab.createBackup(JSON.stringify(settings));
      setBackups((current) => [info, ...current]);
      showToast(`备份完成：${info.path.split(/[\\/]/).at(-1)}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBackupBusy(false);
    }
  }

  async function performRestoreBackup(info: BackupInfo) {
    try {
      const result = await window.filmLab.restoreBackup(info.path);
      if (result.ok && result.settingsJson) {
        try {
          localStorage.setItem('chromik-settings', result.settingsJson);
          setSettings(loadSettings());
        } catch { /* keep current settings if an old backup contains invalid JSON */ }
      }
      if (result.ok) {
        // BUG-033：恢复替换了图库数据库，渲染层所有配方缓存与撤销历史
        // 立即重建，否则下一次保存会把旧配方写回新库、覆盖恢复结果。
        recipeCacheRef.current = new Map();
        recipeDirtyRef.current = false;
        setHistories(new Map());
        await refresh();
      }
      showToast(result.ok ? (result.message ?? '备份已恢复，建议重启应用') : (result.message ?? '恢复失败'), result.ok ? 'normal' : 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function restoreBackup(info: BackupInfo) {
    setConfirmDialog({
      title: '恢复这个备份？',
      detail: `将使用“${info.path.split(/[\\/]/).at(-1)}”替换当前图库数据库。原始照片不会被修改，建议先为当前状态创建一份新备份。`,
      confirmLabel: '确认恢复',
      tone: 'warning',
      eyebrow: 'DATA BACKUP',
      action: () => performRestoreBackup(info),
    });
  }

  async function relocateMissingSources() {
    setMaintenanceBusy('relocate');
    try {
      const result = await window.filmLab.relocateMissingSources();
      if (result.cancelled) return;
      if (result.matched) await refresh(activeRollId);
      showToast(result.unmatched.length
        ? `已重定位 ${result.matched} 个原片引用；${result.unmatched.length} 个仍需手动处理`
        : `已校验并重定位 ${result.matched} 个原片引用`, result.unmatched.length ? 'error' : 'normal');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setMaintenanceBusy(undefined);
    }
  }

  async function cleanRebuildableCache() {
    setMaintenanceBusy('cache');
    try {
      const result = await window.filmLab.cleanRebuildableCache();
      showToast(`${result.message}（${result.removedFiles} 个文件，${formatBytes(result.reclaimedBytes)}）`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setMaintenanceBusy(undefined);
    }
  }

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('reduce-motion', settings.motionLevel === 'off');
    root.classList.toggle('motion-reduced', settings.motionLevel === 'reduced');
    root.classList.toggle('material-soft', settings.materialLevel === 'soft');
    root.classList.toggle('material-rich', settings.materialLevel === 'rich');
    root.classList.toggle('density-compact', settings.interfaceDensity === 'compact');
    root.classList.toggle('hide-info-tips', !settings.showTooltips);
    root.classList.toggle('canvas-solid', !settings.checkerboard);
    // Debounced: persistence is the slow path, toggling classes is not.
    const handle = window.setTimeout(() => {
      localStorage.setItem('chromik-settings', JSON.stringify(settings));
    }, 220);
    return () => window.clearTimeout(handle);
  }, [settings]);

  useEffect(() => {
    if (!settings.defaultExportDirectory) return;
    window.filmLab.authorizeExportDirectory(settings.defaultExportDirectory).then((available) => {
      if (available) setExportDirectory(settings.defaultExportDirectory);
      else setSettings((current) => current.defaultExportDirectory === settings.defaultExportDirectory ? { ...current, defaultExportDirectory: '' } : current);
    }).catch((error: unknown) => {
      console.warn('Chromik: 默认导出目录授权失败', error);
    });
  }, [settings.defaultExportDirectory]);

  // Persist the in-flight recipe before the window closes. The renderer
  // can be torn down at any time (cmd-Q, app.quit, reload) without firing
  // a frame-switch first; without this hook the user loses the most
  // recent edit and may not notice for a long time.
  useEffect(() => {
    const flush = () => {
      if (!selectedFrameIdRef.current || !recipeDirtyRef.current) return;
      void window.filmLab.saveRecipe(selectedFrameIdRef.current, recipeRef.current).catch(() => undefined);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  useEffect(() => {
    recipeRef.current = recipe;
  }, [recipe]);

  useEffect(() => {
    void window.filmLab.listLuts().then(setLuts).catch(() => setLuts([]));
  }, []);

  useEffect(() => {
    const lutId = recipe.grade.lutId;
    if (!lutId) {
      setActiveLut(undefined);
      return;
    }
    const cached = lutCacheRef.current.get(lutId);
    if (cached) {
      setActiveLut(cached);
      return;
    }
    let cancelled = false;
    void window.filmLab.loadLut(lutId)
      .then((plain) => {
        const lut = deserializeCubeLut(plain);
        lutCacheRef.current.set(lutId, lut);
        if (!cancelled) setActiveLut(lut);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveLut(undefined);
        showToast(`LUT「${lutId}」加载失败，已停用`, 'error');
        updateRecipe((current) => current.grade.lutId === lutId
          ? { ...current, grade: { ...current.grade, lutId: undefined } }
          : current);
      });
    return () => { cancelled = true; };
  }, [recipe.grade.lutId]);

  useEffect(() => {
    if (!settingsOpen) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('.settings-page')?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [settingsOpen]);

  useEffect(() => {
    const dialogOpen = settingsOpen
      || exportOpen
      || Boolean(recognitionConflict)
      || Boolean(duplicateImport)
      || Boolean(importReview)
      || Boolean(exportDirectoryPrompt)
      || Boolean(confirmDialog);
    if (!dialogOpen) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (settingsOpen) { setSettingsOpen(false); return; }
      if (exportOpen) {
        if (exportProgress?.status !== 'running') setExportOpen(false);
        return;
      }
      if (recognitionConflict) { setRecognitionConflict(undefined); return; }
      if (duplicateImport) { setDuplicateImport(undefined); return; }
      if (importReview) { setImportReview(undefined); return; }
      if (exportDirectoryPrompt) { setExportDirectoryPrompt(undefined); return; }
      if (confirmDialog && !dialogBusy) { setConfirmDialog(undefined); return; }
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [
    exportOpen,
    settingsOpen,
    exportProgress?.status,
    recognitionConflict,
    duplicateImport,
    importReview,
    exportDirectoryPrompt,
    confirmDialog,
    dialogBusy,
  ]);

  useEffect(() => {
    const closeMenu = () => setRollContextMenu(undefined);
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    window.addEventListener('click', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', keyDown);
    return () => { window.removeEventListener('click', closeMenu); window.removeEventListener('blur', closeMenu); window.removeEventListener('keydown', keyDown); };
  }, []);

  useEffect(() => {
    if (!rollEditorOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The autoFocus on the name input is reliable, but if it failed (e.g.
    // because the field is disabled), drop focus to the first focusable
    // element so screen-reader users land somewhere predictable.
    const focusInitial = () => {
      const focusable = rollEditorRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)') ?? [];
      const explicit = document.activeElement;
      if (focusable.length && (!explicit || !rollEditorRef.current?.contains(explicit))) {
        (focusable[0] as HTMLElement).focus();
      }
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setRollEditorOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(rollEditorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keyDown);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [rollEditorOpen]);

  useEffect(() => {
    const unsubscribe = window.filmLab.onExportProgress((progress) => setExportProgress(progress));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!exportProgress || exportProgress.status !== 'completed') {
      lastActedProgressRef.current = exportProgress;
      return;
    }
    if (!settings.autoOpenExportFolder || !exportProgress.outputDirectory) return;
    if (lastActedProgressRef.current === exportProgress) return;
    lastActedProgressRef.current = exportProgress;
    void window.filmLab.showInFolder(exportProgress.outputDirectory);
  }, [exportProgress, settings.autoOpenExportFolder]);

  useEffect(() => {
    const start = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('input[type="range"], .crop-overlay, .curve-editor')) return;
      continuousEditRef.current = true;
      continuousUndoCapturedRef.current = false;
    };
    const finish = () => {
      continuousEditRef.current = false;
      continuousUndoCapturedRef.current = false;
    };
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerdown', start, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
    };
  }, []);

  useEffect(() => {
    if (!selectedFrameId || !recipeDirtyRef.current) return;
    setSaveState('saving');
    const frameId = selectedFrameId;
    // BUG-004：记录“本次发送”的配方对象引用。保存返回时只有它仍是
    // 最新编辑才能清除 dirty；此前用 updatedAt 与最新值比较，在途期间
    // 的新编辑会被误判为“已保存”，随后切帧/关窗/刷新静默丢失最后一步。
    const savedRecipe = recipe;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await window.filmLab.saveRecipe(frameId, savedRecipe);
        if (recipeRef.current === savedRecipe) {
          recipeDirtyRef.current = false;
          setSaveState('saved');
          setFrames((current) => current.map((frame) => frame.id === frameId
            ? { ...frame, recipe: { ...recipeRef.current, updatedAt: result.savedAt } }
            : frame));
        }
        // 否则存在更新的编辑，其自身的防抖保存负责落盘并清 dirty。
      } catch {
        setSaveState('error');
      }
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [recipe, selectedFrameId]);

  const onHistogram = useCallback((bins: [number[], number[], number[]]) => setHistogram(bins), []);
  const onWaveform = useCallback((next: WaveformData) => setWaveform(next), []);
  const onReadyChange = useCallback((ready: boolean) => setPreviewReady(ready), []);

  async function selectRoll(rollId: string) {
    if (rollId === activeRollId) return;
    const token = ++refreshTokenRef.current;
    try {
      if (selectedFrameId) await window.filmLab.saveRecipe(selectedFrameId, recipe);
      if (token !== refreshTokenRef.current) return;
      const [nextAssets, nextFrames] = await Promise.all([
        window.filmLab.listAssets(rollId), window.filmLab.listFrames(rollId),
      ]);
      if (token !== refreshTokenRef.current) return;
      activeRollIdRef.current = rollId;
      setActiveRollId(rollId);
      setAssets(nextAssets);
      setFrames(nextFrames);
      recipeCacheRef.current = new Map(nextFrames.map((frame) => [frame.id, frame.recipe]));
      setSelectedFrameId(nextFrames[0]?.id);
      const nextRecipe = nextFrames[0]?.recipe ?? createDefaultRecipe();
      recipeRef.current = nextRecipe;
      setRecipe(nextRecipe);
      recipeDirtyRef.current = false;
      setSelectedAssetIds(new Set());
      setSelectedLibraryFrameIds(new Set());
      setSelectedRollIds(new Set([rollId]));
      setView('library');
    } catch (error) {
      if (token !== refreshTokenRef.current) return;
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (token !== refreshTokenRef.current) return;
      setLoading(false);
    }
  }

  function handleRollClick(rollId: string, event: React.MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      setSelectedRollIds((current) => {
        const next = new Set(current);
        if (next.has(rollId) && next.size > 1) next.delete(rollId); else next.add(rollId);
        return next;
      });
      return;
    }
    setSelectedRollIds(new Set([rollId]));
    void selectRoll(rollId);
  }

  function openRollContextMenu(rollId: string, event: React.MouseEvent) {
    event.preventDefault();
    if (!selectedRollIds.has(rollId)) setSelectedRollIds(new Set([rollId]));
    setRollContextMenu({ x: event.clientX, y: event.clientY, rollId });
  }

  function selectFrame(frame: FrameSummary) {
    if (selectedFrameId === frame.id) {
      // 反馈⑦：同帧也要重新装载最新配方——整卷校准等操作会更新 frames 与
      // recipeCache 里的配方，早退会让大画布停留在去色罩之前的旧配方上。
      const latest = recipeCacheRef.current.get(frame.id) ?? frame.recipe;
      if (latest !== recipeRef.current) {
        recipeRef.current = latest;
        setRecipe(latest);
        recipeDirtyRef.current = false;
      }
      return;
    }
    if (selectedFrameId) {
      const outgoingRecipe = recipeRef.current;
      recipeCacheRef.current.set(selectedFrameId, outgoingRecipe);
      setFrames((current) => current.map((item) => item.id === selectedFrameId ? { ...item, recipe: outgoingRecipe } : item));
      if (recipeDirtyRef.current) void window.filmLab.saveRecipe(selectedFrameId, outgoingRecipe).catch(() => setSaveState('error'));
    }
    const nextRecipe = recipeCacheRef.current.get(frame.id) ?? frame.recipe;
    setSelectedFrameId(frame.id);
    recipeRef.current = nextRecipe;
    setRecipe(nextRecipe);
    recipeDirtyRef.current = false;
    setCompare(false);
    setGeometryEditing(false);
    // BUG-014：历史按帧分片，切帧不再清空（refresh 只裁剪不存在的画面）。
  }

  function openDevelop(frame = selectedFrame) {
    if (!frame) return;
    if (frame.status !== 'ready') {
      showToast('原图已移动或无法读取，请先使用“重新定位原图”恢复文件', 'error');
      return;
    }
    selectFrame(frame);
    setDustRemoval(false);
    setView('develop');
  }

  function selectEditorTool(tool: EditorToolId) {
    if (!editorToolDefinition(tool).isAvailable(editorContext)) return;
    if (tool === 'calibrate') {
      setView('calibrate');
      return;
    }
    if (tool === 'segment') {
      const target = segmentAsset ?? assets[0];
      if (target) openFramer(target);
      return;
    }
    if (!selectedFrame) return;
    if (view !== 'develop') openDevelop(selectedFrame);
    selectDevelopTool(tool);
  }

  function selectDevelopTool(tool: FrameTool) {
    setGeometryEditing(tool === 'crop');
    setDustRemoval(tool === 'dust');
  }

  /** BUG-014：向指定画面的撤销栈压入快照（最多保留 60 步）。 */
  function pushFrameHistory(frameId: string | undefined, undoEntry: EditRecipe, clearRedo: boolean) {
    if (!frameId) return;
    setHistories((current) => {
      const next = new Map(current);
      const history = next.get(frameId) ?? { undo: [], redo: [] };
      next.set(frameId, {
        undo: [...history.undo.slice(-59), undoEntry],
        redo: clearRedo ? [] : history.redo,
      });
      return next;
    });
  }

  function updateRecipe(updater: (current: EditRecipe) => EditRecipe) {
    const current = recipeRef.current;
    const next = { ...updater(current), updatedAt: Date.now() };
    const captureUndo = !continuousEditRef.current || !continuousUndoCapturedRef.current;
    if (captureUndo) {
      pushFrameHistory(selectedFrameId, current, true);
      if (continuousEditRef.current) continuousUndoCapturedRef.current = true;
    }
    recipeRef.current = next;
    if (selectedFrameId) recipeCacheRef.current.set(selectedFrameId, next);
    recipeDirtyRef.current = true;
    setRecipe(next);
  }

  function undo() {
    const frameId = selectedFrameId;
    const previous = undoStack.at(-1);
    if (!frameId || !previous) return;
    const restored = { ...previous, updatedAt: Date.now() };
    const currentForRedo = recipeRef.current;
    setHistories((current) => {
      const next = new Map(current);
      const history = next.get(frameId) ?? { undo: [], redo: [] };
      next.set(frameId, {
        undo: history.undo.slice(0, -1),
        redo: [...history.redo.slice(-59), currentForRedo],
      });
      return next;
    });
    recipeRef.current = restored;
    recipeCacheRef.current.set(frameId, restored);
    recipeDirtyRef.current = true;
    setRecipe(restored);
  }

  function redo() {
    const frameId = selectedFrameId;
    const next = redoStack.at(-1);
    if (!frameId || !next) return;
    const restored = { ...next, updatedAt: Date.now() };
    const currentForUndo = recipeRef.current;
    setHistories((current) => {
      const nextMap = new Map(current);
      const history = nextMap.get(frameId) ?? { undo: [], redo: [] };
      nextMap.set(frameId, {
        undo: [...history.undo.slice(-59), currentForUndo],
        redo: history.redo.slice(0, -1),
      });
      return nextMap;
    });
    recipeRef.current = restored;
    recipeCacheRef.current.set(frameId, restored);
    recipeDirtyRef.current = true;
    setRecipe(restored);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      if (!selectedFrameId) return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [recipe, histories, selectedFrameId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === 'g') {
        event.preventDefault();
        setSplitCompare((value) => !value);
      } else if (key === 's') {
        event.preventDefault();
        const frameId = selectedFrameId;
        if (frameId && recipeDirtyRef.current) {
          // BUG-004：与自动保存相同的引用守卫，避免在途期间的新编辑被误清 dirty。
          const savedRecipe = recipeRef.current;
          void window.filmLab.saveRecipe(frameId, savedRecipe).then((result) => {
            if (recipeRef.current !== savedRecipe) return;
            recipeDirtyRef.current = false;
            setSaveState('saved');
            setFrames((current) => current.map((frame) => frame.id === frameId ? { ...frame, recipe: { ...recipeRef.current, updatedAt: result.savedAt } } : frame));
          }).catch(() => setSaveState('error'));
        }
      } else if (key === '[' || key === ']') {
        event.preventDefault();
        if (!frames.length) return;
        const currentIndex = frames.findIndex((frame) => frame.id === selectedFrameId);
        if (currentIndex < 0) return;
        const nextIndex = (currentIndex + (key === ']' ? 1 : -1) + frames.length) % frames.length;
        selectFrame(frames[nextIndex]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frames, selectedFrameId]);

  async function completeImport(result: ImportResult, rollId: string) {
      const abortController = new AbortController();
      importAbortRef.current = abortController;
      setBlockingProgress({ title: '正在生成预览', detail: result.rawImports?.length ? '准备解码相机 RAW…' : '分析素材结构与画面边界…', percent: 24 });
      let importedCount = result.imported;
      const importErrors = [...result.errors];
      const importedAssets = [...(result.importedAssets ?? [])];
      const failedRawJobs: RawImportJob[] = [];
      if (result.rawImports?.length) {
        const [{ decodeRawImport }, { commitRawImportTransfer }] = await Promise.all([
          import('./raw-import'), import('./raw-transfer'),
        ]);
        for (const [rawIndex, rawJob] of result.rawImports.entries()) {
          if (abortController.signal.aborted) break;
          let embeddedPreviewUrl: string | undefined;
          try {
            const rawTotalStartedAt = performance.now();
            const rawSpan = 58 / result.rawImports.length;
            const rawStart = 24 + rawIndex * rawSpan;
            const stagePercent = (fraction: number) => rawStart + rawSpan * fraction;
            setBlockingProgress({ title: `正在解码 RAW（${rawIndex + 1}/${result.rawImports.length}）`, detail: `${rawJob.name} · 读取原始感光数据`, percent: rawStart });
            const rawReadStartedAt = performance.now();
            const rawResponse = await fetch(rawJob.readUrl, { signal: abortController.signal });
            if (!rawResponse.ok) throw new Error(`RAW 原始文件读取失败（${rawResponse.status}）`);
            const buffer = await rawResponse.arrayBuffer();
            recordLocalTiming('raw.read', performance.now() - rawReadStartedAt);
            setBlockingProgress({ title: `正在解码 RAW（${rawIndex + 1}/${result.rawImports.length}）`, detail: `${rawJob.name} · 去马赛克、相机白平衡与浮点色彩转换`, percent: rawStart + 9 });
            const rawDecodeStartedAt = performance.now();
            const decoded = await decodeRawImport(buffer, {
              signal: abortController.signal,
              onStage: (stage, elapsedMs) => {
                const details = {
                  opened: '已打开 RAW，正在读取嵌入预览',
                  thumbnail: '嵌入预览已就绪，正在执行 16 位去马赛克',
                  pixels: '16 位像素已生成，正在读取相机元数据',
                  metadata: '元数据已读取，正在执行浮点相机色彩矩阵',
                  color: '浮点色彩转换完成，正在写入线性代理',
                } as const;
                const stageFraction = { opened: .12, thumbnail: .22, pixels: .52, metadata: .58, color: .62 } as const;
                setBlockingProgress({
                  title: `正在解码 RAW（${rawIndex + 1}/${result.rawImports!.length}）`,
                  detail: `${rawJob.name} · ${details[stage]} · ${Math.max(.1, elapsedMs / 1000).toFixed(1)} 秒`,
                  percent: stagePercent(stageFraction[stage]),
                  previewUrl: embeddedPreviewUrl,
                });
                console.info(`CHROMIK_RAW_DECODE ${JSON.stringify({ name: rawJob.name, stage, elapsedMs: Math.round(elapsedMs) })}`);
              },
              onEmbeddedPreview: (preview) => {
                if (preview.format !== 'jpeg') return;
                const jpegBytes = preview.data.buffer.slice(preview.data.byteOffset, preview.data.byteOffset + preview.data.byteLength) as ArrayBuffer;
                embeddedPreviewUrl = URL.createObjectURL(new Blob([jpegBytes], { type: 'image/jpeg' }));
                setBlockingProgress({ title: `正在解码 RAW（${rawIndex + 1}/${result.rawImports!.length}）`, detail: `${rawJob.name} · 已读取嵌入预览，正在生成 16 位线性代理`, percent: stagePercent(.22), previewUrl: embeddedPreviewUrl });
              },
            });
            recordLocalTiming('raw.decode', performance.now() - rawDecodeStartedAt);
            setBlockingProgress({ title: `正在生成预览（${rawIndex + 1}/${result.rawImports.length}）`, detail: `${rawJob.name} · 等待安全传输 16 位像素`, percent: stagePercent(.64), previewUrl: embeddedPreviewUrl });
            const rawCommitStartedAt = performance.now();
            const committed = await commitRawImportTransfer(rollId, rawJob.sourcePath, decoded, {
              signal: abortController.signal,
              onProgress: (stage, elapsedMs) => {
                const details = {
                  validated: '16 位像素已安全传入缓存进程',
                  proxy: '线性开发代理已缩放',
                  analysis: '同源分析预览已生成',
                  display: '显示补偿预览已生成',
                  encoded: '无损主缓存已编码',
                  written: '缓存已原子写入磁盘',
                  recognition: '正在识别素材结构',
                  database: '素材与代理已安全入库',
                } as const;
                const fractions = { validated: .68, proxy: .75, analysis: .81, display: .86, encoded: .90, written: .93, recognition: .96, database: .99 } as const;
                setBlockingProgress({
                  title: `正在生成预览（${rawIndex + 1}/${result.rawImports!.length}）`,
                  detail: `${rawJob.name} · ${details[stage]} · ${Math.max(.1, elapsedMs / 1000).toFixed(1)} 秒`,
                  percent: stagePercent(fractions[stage]),
                  previewUrl: embeddedPreviewUrl,
                });
                console.info(`CHROMIK_RAW_CACHE ${JSON.stringify({ name: rawJob.name, stage, elapsedMs: Math.round(elapsedMs) })}`);
              },
            });
            recordLocalTiming('raw.commit', performance.now() - rawCommitStartedAt);
            recordLocalTiming('raw.total', performance.now() - rawTotalStartedAt);
            if (committed.errors.length) {
              console.warn(`CHROMIK_RAW_COMMIT_ERROR ${JSON.stringify({ name: rawJob.name, errors: committed.errors.map((item) => item.message) })}`);
              failedRawJobs.push(rawJob);
            }
            importedCount += committed.imported;
            importErrors.push(...committed.errors);
            importedAssets.push(...(committed.importedAssets ?? []));
          } catch (error) {
            if (abortController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) break;
            console.warn(`CHROMIK_RAW_COMMIT_ERROR ${JSON.stringify({ name: rawJob.name, errors: [error instanceof Error ? error.message : String(error)] })}`);
            importErrors.push({ path: rawJob.sourcePath, message: error instanceof Error ? error.message : String(error) });
            failedRawJobs.push(rawJob);
          } finally {
            if (embeddedPreviewUrl) URL.revokeObjectURL(embeddedPreviewUrl);
          }
        }
      }
      if (abortController.signal.aborted) {
        showToast('已取消 RAW 导入；未完成的素材没有写入图库');
        return;
      }
      if (!result.cancelled && result.rollId && importedCount > 0) {
        setBlockingProgress({ title: '正在完成导入', detail: '刷新图库并准备自动识别…', percent: 90 });
        await refresh(result.rollId);
        setView('library');
        if (importedAssets.length) setImportReview({ rollId: result.rollId, items: importedAssets });
        showToast(`已添加 ${importedCount} 个原始素材，正在后台自动识别胶片信息${importErrors.length ? `；${importErrors.length} 个失败` : ''}`,
          importErrors.length ? 'error' : 'normal', failedRawJobs.length ? {
            label: `重试失败 RAW（${failedRawJobs.length}）`,
            run: () => void retryRawImports(rollId, failedRawJobs),
          } : undefined);
        void recognizeImportedMetadata(result.rollId, importedAssets);
        setBlockingProgress({ title: '导入完成', detail: `已生成 ${importedCount} 个原始素材预览`, percent: 100 });
      } else if (!result.cancelled && importErrors.length) {
        showToast(`没有成功导入：${importErrors[0].message}`, 'error', failedRawJobs.length ? {
          label: `重试 RAW（${failedRawJobs.length}）`,
          run: () => void retryRawImports(rollId, failedRawJobs),
        } : undefined);
      }
  }

  async function retryRawImports(rollId: string, failedJobs: RawImportJob[]) {
    setToast(undefined);
    setImporting(true);
    setBlockingProgress({ title: '正在重试 RAW', detail: '重新授权原始文件并准备解码…', percent: 8 });
    try {
      const rawImports = await window.filmLab.retryRawImports(rollId, failedJobs.map((job) => job.sourcePath));
      await completeImport({ cancelled: false, rollId, imported: 0, errors: [], rawImports }, rollId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      importAbortRef.current = undefined;
      setImporting(false);
      window.setTimeout(() => setBlockingProgress(undefined), 260);
    }
  }

  async function importAssets() {
    if (!activeRollId) return showToast('请先创建胶卷', 'error');
    setImporting(true);
    setBlockingProgress({ title: '正在导入原始素材', detail: '读取文件并检查格式…', percent: 5 });
    const progressTimer = window.setInterval(() => setBlockingProgress((current) => current && current.percent < 20
      ? { ...current, percent: current.percent + 1 }
      : current), 220);
    try {
      const result = await window.filmLab.importAssets(activeRollId);
      if (result.pendingDuplicates) {
        setDuplicateImport(result.pendingDuplicates);
        setBlockingProgress(undefined);
        return;
      }
      await completeImport(result, activeRollId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      window.clearInterval(progressTimer);
      importAbortRef.current = undefined;
      setImporting(false);
      window.setTimeout(() => setBlockingProgress(undefined), 260);
    }
  }

  async function resolveDuplicateImport(policy: 'skip' | 'reference') {
    if (!duplicateImport || !activeRollId) return;
    const pending = duplicateImport;
    setDuplicateImport(undefined);
    setImporting(true);
    setBlockingProgress({ title: '正在继续导入', detail: policy === 'skip' ? '跳过已存在的原片…' : '为重复原片创建新的图库引用…', percent: 12 });
    try {
      const result = await window.filmLab.resolveDuplicateImport(pending.id, policy);
      await completeImport(result, activeRollId);
      if (policy === 'skip' && result.imported === 0 && !result.rawImports?.length) showToast(`已跳过 ${pending.items.length} 个重复原片`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      importAbortRef.current = undefined;
      setImporting(false);
      window.setTimeout(() => setBlockingProgress(undefined), 260);
    }
  }

  async function confirmImportedAssets() {
    if (!importReview) return;
    setDialogBusy(true);
    try {
      await Promise.all(importReview.items.map((item) => window.filmLab.updateAssetKind(item.id, item.kind)));
      const refreshed = await refresh(importReview.rollId);
      const finalItems = importReview.items;
      setImportReview(undefined);
      if (finalItems.length === 1) {
        const item = finalItems[0];
        if (item.kind === 'single') {
          // 反馈①：导入单张后先进入整卷校准，而不是直接进调整界面。
          const targetFrame = refreshed?.frames.find((frame) => frame.assetId === item.id);
          if (targetFrame) {
            setSelectedFrameId(targetFrame.id);
            recipeRef.current = targetFrame.recipe;
            setRecipe(targetFrame.recipe);
            recipeDirtyRef.current = false;
          }
          setView('calibrate');
        } else {
          const targetAsset = refreshed?.assets.find((asset) => asset.id === item.id);
          if (targetAsset) openFramer(targetAsset);
          else setView('library');
        }
      } else if (finalItems.every((item) => item.kind === 'single')) {
        // 反馈①：多张单张素材同样先进整卷校准（校准面板可切换素材）。
        const firstItem = finalItems[0];
        const targetFrame = refreshed?.frames.find((frame) => frame.assetId === firstItem.id) ?? refreshed?.frames[0];
        if (targetFrame) {
          setSelectedFrameId(targetFrame.id);
          recipeRef.current = targetFrame.recipe;
          setRecipe(targetFrame.recipe);
          recipeDirtyRef.current = false;
        }
        setView('calibrate');
      } else {
        setLibraryMode(finalItems.every((item) => item.kind === 'single') ? 'frames' : 'assets');
        setView('library');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setDialogBusy(false);
    }
  }

  function openCreateRoll() {
    setRollEditorMode('create');
    setRollDraft(emptyRollInput());
    setRollEditorOpen(true);
  }

  function openEditRoll(targetRoll = activeRoll) {
    if (!targetRoll) return;
    setRollEditorMode('edit');
    setRollDraft({
      name: targetRoll.name,
      filmType: targetRoll.filmType,
      camera: targetRoll.camera,
      lens: targetRoll.lens,
      filmStock: targetRoll.filmStock,
      iso: targetRoll.iso,
      development: targetRoll.development,
      shotDate: targetRoll.shotDate,
      notes: targetRoll.notes,
    });
    setRollEditorOpen(true);
  }

  async function saveRoll() {
    if (!rollDraft.name.trim()) return showToast('请填写胶卷名称', 'error');
    try {
      const roll = rollEditorMode === 'create'
        ? await window.filmLab.createRoll(rollDraft)
        : await window.filmLab.updateRoll(activeRollId!, rollDraft);
      setRollEditorOpen(false);
      await refresh(roll.id);
      setLibraryMode('frames');
      showToast(rollEditorMode === 'create' ? '胶卷已创建，可以添加原始素材' : '胶卷信息已保存');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function performDeleteRoll(rollId: string) {
    const result = await window.filmLab.deleteRoll(rollId);
    if (!result.cancelled && result.deleted) {
      setRollContextMenu(undefined);
      await refresh(rollId === activeRollId ? undefined : activeRollId);
      showToast('胶卷已从图库移除');
    }
  }

  function deleteRoll(rollId: string) {
    const roll = rolls.find((item) => item.id === rollId);
    if (!roll) return showToast('找不到要移除的胶卷', 'error');
    setConfirmDialog({
      title: '移除胶卷？',
      detail: `“${roll.name}”中的 ${roll.assetCount} 个原始素材和 ${roll.frameCount} 个处理后画面会从图库移除。磁盘上的原始文件不会被删除。`,
      confirmLabel: '移除胶卷',
      action: () => performDeleteRoll(rollId),
    });
  }

  async function editRollFromContext(rollId: string) {
    const targetRoll = rolls.find((roll) => roll.id === rollId);
    if (!targetRoll) return;
    if (rollId !== activeRollId) await selectRoll(rollId);
    setRollContextMenu(undefined);
    openEditRoll(targetRoll);
  }

  async function performDeleteSelectedAssets() {
    const result = await window.filmLab.deleteAssets([...selectedAssetIds]);
    if (!result.cancelled) {
      await refresh(activeRollId);
      showToast(`已移除 ${result.deleted} 个原始素材`);
    }
  }

  function deleteSelectedAssets() {
    if (!selectedAssetIds.size) return showToast('请先选择要移除的原始素材', 'error');
    setConfirmDialog({
      title: '移除原始素材？',
      detail: `将移除 ${selectedAssetIds.size} 个原始素材及由它们生成的处理后画面。磁盘上的原始文件不会被删除。`,
      confirmLabel: '确认移除',
      action: performDeleteSelectedAssets,
    });
  }

  async function performMergeSelectedHdr() {
    if (!activeRollId || selectedAssetIds.size < 2) return;
    setMergingHdr(true);
    try {
      const result = await window.filmLab.mergeHdrAssets(activeRollId, [...selectedAssetIds]);
      if (result.asset) {
        await refresh(activeRollId);
        showToast(`HDR 合成完成：${result.asset.name}，已加入原始素材`);
      } else {
        showToast(result.message ?? 'HDR 合成未产生结果', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setMergingHdr(false);
    }
  }

  function mergeSelectedHdr() {
    if (selectedAssetIds.size < 2) return;
    // P1-06：HDR 属实验功能且会同时读取多张全分辨率 16 位图，
    // 合并前明确告知内存风险，不在无警告的情况下静默执行。
    setConfirmDialog({
      title: '合成 HDR？（实验功能）',
      detail: `将合并所选 ${selectedAssetIds.size} 张不同曝光的素材。过程会同时读取全部原图的 16 位数据，张数多或像素高时可能占用数 GB 内存；建议先确认每张画面内容一致、曝光均匀分布。`,
      confirmLabel: '继续合成',
      action: performMergeSelectedHdr,
    });
  }

  async function performDeleteSelectedFrames() {
    const result = await window.filmLab.deleteFrames([...selectedLibraryFrameIds]);
    if (!result.cancelled) {
      await refresh(activeRollId);
      showToast(`已移除 ${result.deleted} 个处理后画面`);
    }
  }

  function deleteSelectedFrames() {
    if (!selectedLibraryFrameIds.size) return showToast('请先选择要移除的处理后画面', 'error');
    setConfirmDialog({
      title: '移除处理后画面？',
      detail: `将从图库移除 ${selectedLibraryFrameIds.size} 个处理后画面。原始素材和磁盘文件不会被删除。`,
      confirmLabel: '确认移除',
      action: performDeleteSelectedFrames,
    });
  }

  async function runConfirmedAction() {
    if (!confirmDialog) return;
    setDialogBusy(true);
    try {
      await confirmDialog.action();
      setConfirmDialog(undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setDialogBusy(false);
    }
  }

  function confirmRecipeAlgorithmUpgrade() {
    setConfirmDialog({
      title: '升级这张照片的处理算法？',
      detail: '当前照片保留了旧版 Chromik 5 数学以维持原有外观。升级会启用统一线性管线，画面可能轻微变化；原图不会被修改，且可立即撤销。',
      confirmLabel: '升级并检查外观',
      tone: 'warning',
      eyebrow: 'RECIPE COMPATIBILITY',
      action: async () => {
        updateRecipe((current) => upgradeRecipeToCurrent(current));
        showToast('已升级到 Chromik 6 线性处理；请检查画面，必要时可撤销');
      },
    });
  }

  function openFramer(asset: AssetSummary) {
    setSegmentAssetId(asset.id);
    setView('segment');
  }

  function openAssetWorkflow(asset: AssetSummary) {
    const existingFrame = frames.find((frame) => frame.assetId === asset.id);
    if (asset.kind === 'single' && existingFrame) openDevelop(existingFrame);
    else openFramer(asset);
  }

  async function saveAssetFrames(regions: FrameRegionInput[]) {
    if (!segmentAsset) return;
    // BUG-001：分帧保存失败必须向用户反馈并保留草稿，此前是静默失败。
    try {
      await window.filmLab.setAssetFrames(segmentAsset.id, regions);
    } catch (error) {
      showToast(`分帧保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    const refreshed = await refresh(segmentAsset.rollId);
    const firstFrame = refreshed?.frames.find((frame) => frame.assetId === segmentAsset.id);
    if (firstFrame) {
      setSelectedFrameId(firstFrame.id);
      setRecipe(firstFrame.recipe);
      recipeDirtyRef.current = false;
      setSegmentAssetId(segmentAsset.id);
      setView('calibrate');
      showToast(`已连续创建 ${regions.length} 张画面，接下来进行整卷胶片校准`);
    } else {
      setView('library');
      showToast('分帧已保存，但没有生成可调整的画面', 'error');
    }
  }

  async function autoCrop() {
    setAnalyzing(true);
    try {
      const result = await developRef.current?.autoCrop();
      if (!result) return;
      updateRecipe((current) => ({ ...current, crop: result.crop, geometry: { ...current.geometry, corners: rectToQuad(result.crop) } }));
      showToast(`已估算画面范围 · 置信度 ${Math.round(result.confidence * 100)}%`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function autoDetectDust() {
    if (!previewReady) return;
    setDustDetecting(true);
    try {
      const candidates = await developRef.current?.detectDustSpots();
      if (!candidates) return;
      if (!candidates.length) {
        showToast('未找到可信的灰尘候选点，可继续手动标记', 'error');
        return;
      }
      const existing = recipe.spots ?? [];
      const merged = [...existing];
      for (const candidate of candidates) {
        if (merged.some((spot) => Math.hypot(spot.x - candidate.x, spot.y - candidate.y) < Math.max(spot.r * 2, candidate.r * 2, 0.006))) continue;
        merged.push({ x: candidate.x, y: candidate.y, r: candidate.r });
      }
      updateRecipe((current) => ({ ...current, spots: merged.slice(0, 120) }));
      showToast(`传统检测建议 ${Math.min(candidates.length, Math.max(0, 120 - existing.length))} 个灰尘点，可在画面上删改`);
    } finally {
      setDustDetecting(false);
    }
  }

  function changeCrop(partial: Partial<EditRecipe['crop']>) {
    updateRecipe((current) => {
      const crop = { ...current.crop, ...partial };
      return { ...current, crop, geometry: { ...current.geometry, corners: rectToQuad(crop) } };
    });
  }

  function changeCorners(corners: EditRecipe['geometry']['corners']) {
    updateRecipe((current) => ({
      ...current,
      crop: quadToCrop(corners),
      geometry: { ...current.geometry, corners },
    }));
  }

  async function copyRecipeToRoll() {
    if (!selectedFrame) return;
    try {
      await window.filmLab.saveRecipe(selectedFrame.id, recipe);
      const { updated } = await window.filmLab.copyRecipeToRoll(selectedFrame.id);
      const synced: Pick<EditRecipe, 'grade'> = {
        grade: {
          ...recipe.grade,
          printerLights: [...recipe.grade.printerLights] as RGB,
          vignette: { ...recipe.grade.vignette },
          cmy: { ...recipe.grade.cmy },
          curves: {
            rgb: recipe.grade.curves.rgb.map((point) => ({ ...point })),
            red: recipe.grade.curves.red.map((point) => ({ ...point })),
            green: recipe.grade.curves.green.map((point) => ({ ...point })),
            blue: recipe.grade.curves.blue.map((point) => ({ ...point })),
          },
        },
      };
      setFrames((current) => current.map((frame) => frame.id === selectedFrame.id
        ? { ...frame, recipe: { ...recipe, updatedAt: Date.now() } }
        : { ...frame, recipe: { ...frame.recipe, ...synced, updatedAt: Date.now() } }));
      // Keep the per-frame recipe cache in sync with the state update above.
      // selectFrame prefers the cache; without this a later edit on another
      // frame would restore the pre-sync recipe and silently overwrite the
      // values just synced to the whole roll.
      const nextCache = new Map(recipeCacheRef.current);
      for (const frame of frames) {
        if (frame.rollId !== selectedFrame.rollId || frame.id === selectedFrame.id) continue;
        nextCache.set(frame.id, { ...frame.recipe, ...synced, updatedAt: Date.now() });
      }
      recipeCacheRef.current = nextCache;
      showToast(`已把当前照片的颜色参数应用到同卷 ${updated} 张画面；裁切、除尘与整卷校准保持不变`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function copyCurrentGrade() {
    setCopiedGrade(structuredClone(recipe.grade));
    showToast('已复制当前照片的颜色参数');
  }

  function pasteCurrentGrade() {
    if (!copiedGrade) return;
    updateRecipe((current) => ({ ...current, grade: structuredClone(copiedGrade) }));
    showToast('已粘贴颜色参数；裁切、除尘与整卷校准未改变');
  }

  async function importLuts() {
    try {
      const result = await window.filmLab.importLuts();
      if (!result.imported.length) return;
      setLuts(await window.filmLab.listLuts());
      showToast(`已导入 ${result.imported.length} 个 LUT`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function relocateFrame() {
    if (!selectedFrame) return;
    try {
      const result = await window.filmLab.relocateFrame(selectedFrame.id);
      if (result.frame) {
        setFrames((current) => current.map((frame) => frame.id === result.frame!.id ? result.frame! : frame));
        showToast('原图已重新定位，代理已重建');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function chooseExportDirectory(remember = false) {
    const directory = await window.filmLab.chooseExportDirectory();
    if (directory) {
      setExportDirectory(directory);
      if (remember) setSettings((current) => ({ ...current, defaultExportDirectory: directory }));
    }
    return directory;
  }

  async function resolveExportDirectoryPrompt() {
    if (!exportDirectoryPrompt) return;
    const intendedAction = exportDirectoryPrompt;
    const directory = await chooseExportDirectory(rememberExportDirectory);
    if (!directory) return;
    setExportDirectoryPrompt(undefined);
    setRememberExportDirectory(false);
    if (intendedAction === 'export') await startExport(directory);
    else await createContactSheet(directory);
  }

  function initializeExportDimensions(nextFrames: FrameSummary[]) {
    const first = nextFrames[0];
    if (!first) return;
    setExportWidth(first.width);
    setExportHeight(first.height);
    setExportPreviewId(first.id);
  }

  async function openExportForRolls(rollIds: string[]) {
    if (!rollIds.length) return;
    if (selectedFrameId) await window.filmLab.saveRecipe(selectedFrameId, recipe);
    const groups = await Promise.all(rollIds.map((rollId) => window.filmLab.listFrames(rollId)));
    const nextFrames = groups.flat();
    if (!nextFrames.length) return showToast('所选胶卷还没有处理后画面', 'error');
    setExportFrames(nextFrames);
    setExportRollIds(new Set(rollIds));
    setExportSelection(new Set(nextFrames.map((frame) => frame.id)));
    setExportRangeLabel(rollIds.length > 1 ? `${rollIds.length} 卷胶卷` : '整卷胶片');
    initializeExportDimensions(nextFrames);
    setRollContextMenu(undefined);
    setExportOpen(true);
  }

  async function openExportForFrames(frameIds: string[]) {
    if (!frameIds.length) return showToast('请先选择要导出的画面', 'error');
    if (selectedFrameId) await window.filmLab.saveRecipe(selectedFrameId, recipe);
    const fresh = activeRollId ? await window.filmLab.listFrames(activeRollId) : [];
    const nextFrames = fresh.filter((frame) => frameIds.includes(frame.id));
    if (!nextFrames.length) return;
    setExportFrames(nextFrames);
    setExportRollIds(new Set(nextFrames.map((frame) => frame.rollId)));
    setExportSelection(new Set(nextFrames.map((frame) => frame.id)));
    setExportRangeLabel(nextFrames.length === 1 ? '当前单张' : `所选 ${nextFrames.length} 张`);
    initializeExportDimensions(nextFrames);
    setExportOpen(true);
  }

  function changeExportWidth(width: number) {
    const safeWidth = Math.max(1, Math.min(100000, width));
    setExportWidth(safeWidth);
    if (exportLockAspect && exportFrames[0]) setExportHeight(Math.max(1, Math.round(safeWidth * exportFrames[0].height / exportFrames[0].width)));
  }

  function changeExportHeight(height: number) {
    const safeHeight = Math.max(1, Math.min(100000, height));
    setExportHeight(safeHeight);
    if (exportLockAspect && exportFrames[0]) setExportWidth(Math.max(1, Math.round(safeHeight * exportFrames[0].width / exportFrames[0].height)));
  }

  function applyExportPreset(preset: 'share' | 'archive' | 'edit') {
    if (preset === 'share') {
      setExportFormat('jpeg');
      setExportQuality(92);
      setExportBitDepth(8);
      setPreserveOriginalSize(false);
      setExportWidth(2048);
      setExportHeight(1365);
      setExportLockAspect(true);
      setExportSharpening(20);
      setExportColorSpace('srgb');
      showToast('已应用“分享”导出预设');
      return;
    }
    if (preset === 'archive') {
      setExportFormat('tiff');
      setExportBitDepth(16);
      setPreserveOriginalSize(true);
      setExportSharpening(0);
      setExportColorSpace('p3');
      showToast('已应用“高质量存档”预设');
      return;
    }
    setExportFormat('dng');
    setExportBitDepth(16);
    setPreserveOriginalSize(true);
    setExportSharpening(0);
    setExportColorSpace('srgb');
    showToast('已应用“继续修图”线性 DNG（实验）预设');
  }

  async function startExport(directoryOverride?: string) {
    const ids = [...exportSelection].filter((id) => exportFrames.some((frame) => frame.id === id));
    const directory = directoryOverride ?? exportDirectory;
    if (!directory) {
      setExportDirectoryPrompt('export');
      return;
    }
    if (ids.length === 0) return showToast('请至少选择一张画面', 'error');
    try {
      if (selectedFrame) await window.filmLab.saveRecipe(selectedFrame.id, recipe);
      const { jobId } = await window.filmLab.startExport(ids, {
        directory,
        format: exportFormat,
        quality: exportQuality,
        suffix: '_processed',
        bitDepth: exportFormat === 'jpeg' ? 8 : exportBitDepth,
        resizeMode: preserveOriginalSize ? 'original' : 'dimensions',
        width: exportWidth,
        height: exportHeight,
        lockAspect: exportLockAspect,
        allowUpscale: exportAllowUpscale,
        sharpening: exportSharpening,
        colorSpace: exportColorSpace,
        conflictPolicy: exportConflict,
        borderPadding: exportBorderPadding,
      });
      setExportProgress({ jobId, done: 0, total: ids.length, status: 'running', errors: [], outputDirectory: directory });
      showToast('后台导出已开始');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function createContactSheet(directoryOverride?: string) {
    const rollIds = exportRollIds.size ? [...exportRollIds] : activeRollId ? [activeRollId] : [];
    if (!rollIds.length) return;
    const directory = directoryOverride ?? exportDirectory;
    if (!directory) {
      setExportDirectoryPrompt('contact');
      return;
    }
    try {
      const { jobId, total } = await window.filmLab.createContactSheet(rollIds, directory, contactConfig);
      setExportProgress({ jobId, taskKind: 'contact-sheet', done: 0, total, status: 'running', errors: [], outputDirectory: directory, currentName: '正在准备接触印样代理…' });
      showToast(`接触印样已进入后台任务（${total} 张）`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function saveRollCalibration(calibration: RollCalibration) {
    if (!activeRollId) return;
    const result = await window.filmLab.saveRollCalibration(activeRollId, calibration);
    setRolls((current) => current.map((roll) => roll.id === activeRollId ? result.roll : roll));
    const updatedIds = new Set(result.updatedFrameIds);
    const currentFrameId = selectedFrameIdRef.current;
    const nextFrames = frames.map((frame) => {
      if (!updatedIds.has(frame.id)) return frame;
      const nextRecipe = { ...frame.recipe, baseRgb: calibration.baseRgb, baseRgbLinear: calibration.baseRgbLinear, density: { ...calibration.density }, updatedAt: calibration.updatedAt };
      recipeCacheRef.current.set(frame.id, nextRecipe);
      return { ...frame, recipe: nextRecipe };
    });
    setFrames(nextFrames);
    // BUG-006：校准继承同样要同步当前选中帧的实时配方（recipeRef/recipe）。
    // 此前只更新 frames/cache，selectFrame 对同帧早退，下一次任意编辑会用
    // 旧 density 生成新配方，把刚应用的整卷校准静默覆盖回去。
    if (currentFrameId && updatedIds.has(currentFrameId)) {
      const nextRecipe = nextFrames.find((frame) => frame.id === currentFrameId)?.recipe;
      if (nextRecipe) {
        recipeRef.current = nextRecipe;
        setRecipe(nextRecipe);
        recipeDirtyRef.current = false;
      }
    }
  }

  const saveLabel = saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : '已保存';
  const isExporting = exportProgress?.status === 'running';
  const closeExport = () => {
    if (isExporting) {
      showToast('正在导出，请等待当前任务完成后再返回', 'error');
      return;
    }
    setExportOpen(false);
  };
  const exportPreviewFrame = exportFrames.find((frame) => frame.id === exportPreviewId) ?? exportFrames[0];
  const exportPreviewRoll = rolls.find((roll) => roll.id === exportPreviewFrame?.rollId);
  const editorActions = editorActive ? <>
    <button className="icon-button editor-action-icon" aria-label="撤销" title="撤销 ⌘/Ctrl+Z" disabled={view !== 'develop' || !undoStack.length} onClick={undo}><Undo2 size={15} /></button>
    <button className="icon-button editor-action-icon" aria-label="重做" title="重做 ⇧⌘/Ctrl+Z" disabled={view !== 'develop' || !redoStack.length} onClick={redo}><Redo2 size={15} /></button>
    <span className="toolbar-divider" />
    <button className="button-primary compact" disabled={!activeRoll?.frameCount} onClick={() => view === 'develop' && selectedFrame ? void openExportForFrames([selectedFrame.id]) : activeRollId && void openExportForRolls([activeRollId])}><Download size={15} />导出</button>
  </> : undefined;

  return (
    <AppShell
      mode={editorActive ? 'editor' : 'library'}
      isMac={window.filmLab.platform === 'darwin'}
      appVersion={appInfo?.version}
      context={editorIdentity}
      statusText={selectedFrame ? saveLabel : undefined}
      statusTone={saveState === 'error' ? 'danger' : 'safe'}
      editorActions={editorActions}
      onBack={() => { setView('library'); setLibraryMode(frames.length ? 'frames' : 'assets'); }}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenHelp={() => setHelpOpen(true)}
    >
      <main className="main-area">
        <ViewErrorBoundary resetKey={view}>
        {view === 'library' && (
          <section className="library-layout view-enter">
            <aside className="panel glass-surface roll-sidebar">
              <div className="panel-title"><span>胶卷项目</span><div className="roll-project-actions"><button className="mini-add danger-button" disabled={!activeRollId} title="删除当前胶卷" onClick={() => activeRollId && void deleteRoll(activeRollId)}><Trash2 size={14} /></button><button className="mini-add" title="创建胶卷" onClick={openCreateRoll}><Plus size={14} /></button></div></div>
              <div className="panel-scroll roll-list">
                {rolls.map((roll) => (
                  <button key={roll.id} className={`roll-item ${roll.id === activeRollId ? 'selected' : ''} ${selectedRollIds.has(roll.id) ? 'batch-selected' : ''}`} onClick={(event) => handleRollClick(roll.id, event)} onContextMenu={(event) => openRollContextMenu(roll.id, event)}>
                    <span className="roll-icon"><Film size={15} /></span>
                    <span className="roll-copy"><b>{roll.name}</b><small>{FILM_TYPE_LABELS[roll.filmType]} · {roll.assetCount} 原始 / {roll.frameCount} 成片</small></span>
                    <button className={`roll-star ${roll.starred ? 'active' : ''}`} aria-label={roll.starred ? '取消标星' : '标星'} title={roll.starred ? '取消标星' : '标星'} onClick={(event) => { event.stopPropagation(); void toggleRollStar(roll); }}><Star size={13} fill={roll.starred ? 'currentColor' : 'none'} /></button>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              <div className="sidebar-actions">
                <button className="button-primary" onClick={openCreateRoll}><Plus size={16} />创建胶卷</button>
              </div>
            </aside>

            <section className="library-center">
              <div className="page-heading">
                <div><p className="eyebrow">ROLL LIBRARY</p><h1>{activeRoll?.name ?? '先创建一卷胶片'}</h1><p>{activeRoll ? `${FILM_TYPE_LABELS[activeRoll.filmType]} · 原始素材只读保存，分帧和调整均为非破坏参数。` : '胶卷是文件夹，也是原始素材、分帧结果和拍摄信息的统一容器。'}</p></div>
                {activeRoll && <div className="library-heading-actions"><button className="button-secondary" onClick={() => openEditRoll()}><Pencil size={15} />编辑胶卷</button></div>}
              </div>
              {loading ? (
                <div className="center-message"><LoaderCircle className="spin" /><span>正在读取图库…</span></div>
              ) : !activeRoll ? (
                <div className="empty-state glass-surface-strong">
                  <div className="empty-visual"><Aperture size={54} /></div>
                  <p className="eyebrow">START HERE</p>
                  <h2>建立第一卷胶片</h2>
                  <p>创建胶卷后添加长条、印样或单张原始素材。片种可以交给软件自动判断。</p>
                  <div className="empty-actions">
                    <button className="button-primary" onClick={openCreateRoll}><Plus size={17} />创建胶卷</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="library-commandbar glass-surface">
                    <div className="library-view-tabs sliding-segment" data-edge={libraryMode === 'frames' ? 'left' : 'right'} style={{ '--segment-index': libraryMode === 'frames' ? 0 : 1, '--segment-count': 2 } as CSSProperties}><span className="sliding-segment-indicator" aria-hidden="true" /><button className={libraryMode === 'frames' ? 'active' : ''} onClick={() => switchLibraryMode('frames')}><Images size={15} />处理后画面 <b>{frames.length}</b></button><button className={libraryMode === 'assets' ? 'active' : ''} onClick={() => switchLibraryMode('assets')}><Files size={15} />原始文件 <b>{assets.length}</b></button></div>
                    <div className="library-layout-toggle" role="group" aria-label="图库排列方式"><button className={libraryLayoutMode === 'grid' ? 'active' : ''} aria-label="缩略图模式" title="缩略图模式" onClick={() => setLibraryLayoutMode('grid')}><Grid2X2 size={15} /></button><button className={libraryLayoutMode === 'list' ? 'active' : ''} aria-label="详细列表模式" title="详细列表模式" onClick={() => setLibraryLayoutMode('list')}><List size={15} /></button></div>
                    <div className="library-search">
                      <Search size={13} />
                      <input value={searchQuery} placeholder={libraryMode === 'frames' ? '搜索帧号或名称…' : '搜索素材名称…'} onChange={(event) => setSearchQuery(event.target.value)} aria-label="图库搜索" />
                      {searchQuery && <button className="library-search-clear" aria-label="清除搜索" onClick={() => setSearchQuery('')}><X size={12} /></button>}
                    </div>
                    <button className={`button-secondary compact ${starFilter ? 'is-active' : ''}`} title="仅看已标星的项目" onClick={() => setStarFilter((value) => !value)}><Star size={14} />星标</button>
                    <span className="toolbar-spacer" />
                    {libraryMode === 'assets' ? <>
                      <button className="button-primary compact" disabled={importing} data-disabled-reason={importing ? '正在导入并生成预览，请稍候' : undefined} onClick={() => void importAssets()}><ImagePlus size={15} />{importing ? '正在识别…' : '添加原始素材'}</button>
                      {selectedAssetIds.size >= 2 && <button className="button-secondary compact" disabled={mergingHdr} title="将所选的多张不同曝光合并为一张 HDR 素材" onClick={() => void mergeSelectedHdr()}>{mergingHdr ? <LoaderCircle className="spin" size={15} /> : <Images size={15} />}合成 HDR</button>}
                      <button className="button-secondary compact danger-outline" disabled={!selectedAssetIds.size} onClick={() => void deleteSelectedAssets()}><Trash2 size={15} />移除 {selectedAssetIds.size || ''}</button>
                    </> : <>
                      <button className="button-secondary compact" onClick={() => setSelectedLibraryFrameIds(new Set(frames.map((frame) => frame.id)))}>全选</button>
                      {selectedLibraryFrameIds.size > 1 && <button className="button-secondary compact" title="把当前选中帧的调色应用到所选画面（不覆盖裁切/片基/除尘）" onClick={() => setPasteScopeOpen(true)}><ClipboardPaste size={14} />粘贴参数…</button>}
                      <button className="button-primary compact" onClick={() => void openExportForFrames(selectedLibraryFrameIds.size ? [...selectedLibraryFrameIds] : frames.map((frame) => frame.id))}><Download size={14} />{selectedLibraryFrameIds.size ? `导出所选 ${selectedLibraryFrameIds.size} 张` : '导出本卷'}</button>
                      <button className="button-secondary compact danger-outline" disabled={!selectedLibraryFrameIds.size} onClick={() => void deleteSelectedFrames()}><Trash2 size={15} />移除 {selectedLibraryFrameIds.size || ''}</button>
                    </>}
                  </div>
                  {libraryMode === 'assets' ? (
                    assets.length ? <VirtualPhotoGrid className={`asset-grid library-mode-content ${libraryTransitioning ? 'leaving' : ''}`} layoutMode={libraryLayoutMode} minimumColumnWidth={libraryThumbnailSize} gap={Math.round(8 + (libraryThumbnailSize - 140) / 18)} thumbnailHeightRatio={.625} metadataHeight={45} listItemHeight={Math.min(92, 78 + (libraryThumbnailSize - 140) * .08)} ariaLabel="原始素材虚拟图库" style={{ '--library-card-min': `${libraryThumbnailSize}px`, '--library-grid-gap': `${Math.round(8 + (libraryThumbnailSize - 140) / 18)}px` } as CSSProperties} itemKey={(asset) => asset.id} items={assets.filter((asset) => {
                      const query = searchQuery.trim().toLowerCase();
                      return !query || asset.name.toLowerCase().includes(query);
                    })} renderItem={(asset) => {
                      const checked = selectedAssetIds.has(asset.id);
                      return <div className={`photo-card asset-card ${checked ? 'selected' : ''}`} role="checkbox" aria-checked={checked} aria-label={`${asset.name}，${ASSET_KIND_LABELS[asset.kind]}`} tabIndex={0} onDoubleClick={() => openAssetWorkflow(asset)} onKeyDown={(event) => { if (event.key === 'Enter') openAssetWorkflow(asset); if (event.key === ' ') { event.preventDefault(); setSelectedAssetIds((current) => { const next = new Set(current); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next; }); } }} onClick={(event) => setSelectedAssetIds((current) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) { const next = new Set(current); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next; }
                        return new Set([asset.id]);
                      })}>
                        <div className="photo-thumb"><img src={asset.previewUrl} draggable={false} loading="lazy" decoding="async" alt={asset.name} /><span className="source-badge">{ASSET_KIND_LABELS[asset.kind]}</span><span className="frame-count-badge">{asset.frameCount} 帧</span><span className={`custom-check floating ${checked ? 'checked' : ''}`}>{checked && <Check size={13} />}</span></div>
                        <div className="photo-meta"><span>{asset.format}</span><b title={asset.name}>{asset.name}</b><button aria-label={`${asset.kind === 'single' && frames.some((frame) => frame.assetId === asset.id) ? '调整' : '分帧'} ${asset.name}`} onClick={(event) => { event.stopPropagation(); openAssetWorkflow(asset); }}>{asset.kind === 'single' && frames.some((frame) => frame.assetId === asset.id) ? <><Sparkles size={13} />调整</> : <><ScanLine size={13} />分帧</>}</button></div>
                        <div className="photo-list-details"><span><small>素材类型</small><b>{ASSET_KIND_LABELS[asset.kind]}</b></span><span><small>像素尺寸</small><b>{asset.width} × {asset.height}</b></span><span><small>文件</small><b>{asset.format.toUpperCase()} · {formatBytes(asset.fileSize)}</b></span><span><small>状态</small><b>{asset.status === 'ready' ? '原图就绪' : '需要重新定位'}</b></span></div>
                      </div>;
                    }} /> : <div className="empty-inline"><Files size={38} /><h3>胶卷中还没有原始素材</h3><p>添加后会自动识别长条、印样或单张；单张会直接进入调整，不再经过分帧。</p><button className="button-primary" onClick={() => void importAssets()}><FolderOpen size={16} />添加原始素材</button></div>
                  ) : (
                    frames.length ? <VirtualPhotoGrid className={`library-mode-content ${libraryTransitioning ? 'leaving' : ''}`} layoutMode={libraryLayoutMode} minimumColumnWidth={libraryThumbnailSize} gap={Math.round(8 + (libraryThumbnailSize - 140) / 18)} thumbnailHeightRatio={2 / 3} metadataHeight={41} listItemHeight={Math.min(92, 78 + (libraryThumbnailSize - 140) * .08)} ariaLabel="处理后画面虚拟图库" style={{ '--library-card-min': `${libraryThumbnailSize}px`, '--library-grid-gap': `${Math.round(8 + (libraryThumbnailSize - 140) / 18)}px` } as CSSProperties} itemKey={(frame) => frame.id} items={frames.filter((frame) => {
                      const query = searchQuery.trim().toLowerCase();
                      const queryMatch = !query || frame.name.toLowerCase().includes(query) || String(frame.frameNumber) === query;
                      return queryMatch && (!starFilter || frame.starred);
                    })} renderItem={(frame) => {
                      const checked = selectedLibraryFrameIds.has(frame.id);
                      return <div className={`photo-card ${checked ? 'selected' : ''}`} role="checkbox" aria-checked={checked} aria-label={`${frame.name}，第 ${frame.frameNumber} 帧`} tabIndex={0} onDoubleClick={() => openDevelop(frame)} onKeyDown={(event) => { if (event.key === 'Enter') openDevelop(frame); if (event.key === ' ') { event.preventDefault(); selectFrame(frame); setSelectedLibraryFrameIds((current) => { const next = new Set(current); if (next.has(frame.id)) next.delete(frame.id); else next.add(frame.id); return next; }); } }} onClick={(event) => {
                        selectFrame(frame);
                        setSelectedLibraryFrameIds((current) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey) { const next = new Set(current); if (next.has(frame.id)) next.delete(frame.id); else next.add(frame.id); return next; }
                          return new Set([frame.id]);
                        });
                      }}>
                        <div className="photo-thumb"><img src={frame.processedPreviewUrl} draggable={false} loading="lazy" decoding="async" alt={`${frame.name} 处理后画面`} />
                          <button className={`star-badge ${frame.starred ? 'active' : ''}`} aria-label={frame.starred ? '取消标星' : '标星'} title={frame.starred ? '取消标星' : '标星'} onClick={(event) => { event.stopPropagation(); void toggleFrameStar(frame); }}><Star size={13} fill={frame.starred ? 'currentColor' : 'none'} /></button>
                          {negativeWorkflow && frame.recipe.density.enabled && <span className="edit-badge"><Check size={11} />已反相</span>}
                          {frame.status !== 'ready' && <span className="missing-badge"><TriangleAlert size={11} />原图丢失</span>}
                          <span className={`custom-check floating ${checked ? 'checked' : ''}`}>{checked && <Check size={13} />}</span>
                        </div>
                        <div className="photo-meta"><span>{String(frame.frameNumber).padStart(2, '0')}</span><b title={frame.name}>{frame.name}</b><small>{frame.width}×{frame.height}</small></div>
                        <div className="photo-list-details"><span><small>帧号</small><b>#{frame.frameNumber}</b></span><span><small>像素尺寸</small><b>{frame.width} × {frame.height}</b></span><span><small>文件</small><b>{frame.format.toUpperCase()} · {formatBytes(frame.fileSize)}</b></span><span><small>处理状态</small><b>{frame.status === 'ready' ? (frame.recipe.density.enabled ? '已反相 · 可调整' : '可调整') : '原图丢失'}</b></span></div>
                      </div>;
                    }} /> : <div className={`empty-inline library-mode-content ${libraryTransitioning ? 'leaving' : ''}`}><ScanLine size={38} /><h3>还没有处理后画面</h3><p>切换到“原始文件”，双击素材进入非破坏分帧。</p><button className="button-secondary" onClick={() => switchLibraryMode('assets')}>查看原始文件</button></div>
                  )}
                </>
              )}
              {activeRoll && <div className="library-footer"><div className="library-view-options"><span>{libraryLayoutMode === 'grid' ? <Grid2X2 size={14} /> : <List size={14} />}{libraryLayoutMode === 'grid' ? '缩略图大小' : '列表密度'}</span><input type="range" min={140} max={300} step={10} value={libraryThumbnailSize} aria-label="调整图库项目大小和间距" onChange={(event) => setLibraryThumbnailSize(Number(event.target.value))} /><b>{libraryThumbnailSize}</b></div><div className="library-status"><span><b>{assets.length}</b> 个原始素材</span><span><b>{frames.length}</b> 个处理后画面</span><span>{FILM_TYPE_LABELS[activeRoll.filmType]}</span></div></div>}
            </section>

            <aside className="panel glass-surface inspector">
              <div className="panel-title"><span>胶卷信息</span>{activeRoll && <button className="text-button" onClick={() => openEditRoll()}><Pencil size={13} />编辑</button>}</div>
              {activeRoll ? <div className="inspector-body roll-inspector">
                <div className="roll-hero"><Film size={26} /><div><b>{activeRoll.name}</b><span>{FILM_TYPE_LABELS[activeRoll.filmType]}</span></div></div>
                {libraryMode === 'assets' && <><div className="info-list">
                  <div><span>胶卷型号</span><b>{activeRoll.filmStock || '未填写'}</b></div>
                  <div><span>感光度</span><b>{activeRoll.iso ? `ISO ${activeRoll.iso}` : '未填写'}</b></div>
                  <div><span>相机</span><b>{activeRoll.camera || '未填写'}</b></div>
                  <div><span>镜头</span><b>{activeRoll.lens || '未填写'}</b></div>
                  <div><span>冲洗/参数</span><b>{activeRoll.development || '未填写'}</b></div>
                  <div><span>拍摄日期</span><b>{activeRoll.shotDate || '未填写'}</b></div>
                </div>
                <div className="detection-actions">
                  {frames.length
                    ? <button className="button-primary full" onClick={() => setView('calibrate')}><Aperture size={16} />进入整卷校准</button>
                    : assets[0] && <button className="button-primary full" onClick={() => openFramer(assets[0])}><ScanLine size={16} />先分帧，再进行校准</button>}
                  <div className={`automatic-recognition-status ${automaticRecognitionStatus}`}>
                    {automaticRecognitionStatus === 'running' ? <LoaderCircle className="spin" size={15} /> : automaticRecognitionStatus === 'unmatched' ? <Info size={15} /> : <Sparkles size={15} />}
                    <span><b>{automaticRecognitionStatus === 'running' ? '正在自动识别新素材' : automaticRecognitionStatus === 'unmatched' ? '未得到可靠识别结果' : '导入时自动识别'}</b><small>{automaticRecognitionStatus === 'unmatched' ? '胶卷信息未被修改，可点击右上角“编辑”手动补充' : '片种、胶卷型号与 ISO 会在添加素材后自动更新'}</small></span>
                  </div>
                </div>
                {activeRoll.edgeText && <div className="edge-text"><small>上次识别文字</small><p>{activeRoll.edgeText}</p></div>}</>}
                {libraryMode === 'frames' && selectedFrame && <section className="selected-frame-summary"><div className="inspector-preview"><img src={selectedFrame.processedPreviewUrl} draggable={false} alt="当前处理后画面" /></div><div className="selected-frame-heading"><span>当前处理后画面</span><h3>{selectedFrame.name}</h3></div><div className="info-list compact-info"><div><span>帧号</span><b>#{selectedFrame.frameNumber}</b></div><div><span>尺寸</span><b>{selectedFrame.width} × {selectedFrame.height}</b></div><div><span>原始大小</span><b>{formatBytes(selectedFrame.fileSize)}</b></div></div><button className="button-primary full" onClick={() => openDevelop()}><Sparkles size={17} />进入调整照片</button></section>}
                <p className="privacy-note"><Info size={14} />片基识别与图像处理均在本机完成。</p>
              </div> : <div className="panel-placeholder">创建胶卷后填写拍摄信息</div>}
            </aside>
          </section>
        )}

        {view === 'calibrate' && activeRoll && assets.length > 0 && (
          <FilmCalibration
            roll={activeRoll}
            assets={assets}
            systemGestures
            editorContext={editorContext}
            preferredAssetId={selectedFrame?.assetId ?? segmentAssetId}
            onToolChange={selectEditorTool}
            onSave={saveRollCalibration}
            onEditRoll={() => openEditRoll()}
            onContinue={(asset) => {
              const target = frames.find((frame) => frame.assetId === asset.id) ?? frames[0];
              if (target) openDevelop(target);
              else openFramer(asset);
            }}
          />
        )}

        {view === 'segment' && segmentAsset && (
          <ManualFramer
            asset={segmentAsset}
            assets={assets}
            frames={segmentFrames}
            onSave={saveAssetFrames}
            systemGestures
            editorContext={editorContext}
            onSelectAsset={openFramer}
            onToolChange={selectEditorTool}
          />
        )}

        {view === 'develop' && selectedFrame && (
          <EditorShell
            activeTool={developTool}
            context={editorContext}
            inspectorTitle={developTool === 'crop' ? '裁切与几何' : developTool === 'dust' ? '除尘 / 擦灰' : '照片调整'}
            scopeLabel="当前照片"
            onToolChange={selectEditorTool}
            inspectorAction={developTool === 'adjust' ? <div className="inspector-title-actions"><button className={`text-button editor-compare ${compare || splitCompare ? 'is-active' : ''}`} title="按住看原片，点击切换分割对比" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onClick={() => setSplitCompare((value) => !value)}><Images size={13} />对比</button><button className="text-button" title="只重置影调、色彩、风格和曲线，保留分帧与裁切" onClick={() => updateRecipe((current) => ({ ...current, grade: createRecipeForFilmType(activeRoll?.filmType ?? 'unknown').grade }))}><RotateCcw size={13} />颜色重置</button></div> : undefined}
            canvas={<div className="preview-shell glass-surface">
                <DevelopCanvas
                  ref={developRef}
                  frame={selectedFrame}
                  recipe={recipe}
                  compare={compare}
                  negativeWorkflow={negativeWorkflow}
                  filmTypeUnknown={filmTypeUnknown}
                  systemGestures
                  sampling={false}
                  onSample={() => undefined}
                  onHistogram={onHistogram}
                  onWaveform={onWaveform}
                  onReadyChange={onReadyChange}
                  geometryEditing={geometryEditing}
                  onCornersChange={changeCorners}
                  lut={activeLut}
                  dustRemoval={dustRemoval}
                  spots={recipe.spots}
                  onSpotsChange={(spots) => updateRecipe((current) => ({ ...current, spots }))}
                  dustBrushSize={dustRadius}
                  splitCompare={splitCompare}
                  onProofError={(message) => showToast(message, 'error')}
                />
                {!previewReady && <div className="preview-loading"><LoaderCircle className="spin" />生成预览…</div>}
              </div>}
            filmstrip={<VirtualFilmstrip items={frames} itemKey={(frame) => frame.id} selectedIndex={frames.findIndex((frame) => frame.id === selectedFrame.id)} renderItem={(frame) => <button className={frame.id === selectedFrame.id ? 'selected' : ''} onClick={() => selectFrame(frame)}><img src={frame.processedPreviewUrl} loading="lazy" decoding="async" draggable={false} alt="" /><span>{String(frame.frameNumber).padStart(2, '0')}</span></button>} />}
            inspector={<>
                {developTool === 'crop' && <div className="context-inspector">
                  <div className="context-intro"><Crop size={18} /><div><b>在画面上裁切</b><span>拖动裁切框、边线和四角控制点，排除齿孔与多余片框。</span></div></div>
                  <div className="two-buttons"><button className={`button-secondary compact ${analyzing ? 'danger-outline' : ''}`} title={analyzing ? '取消自动边界分析' : '自动查找照片边界'} disabled={!previewReady && !analyzing} onClick={() => analyzing ? developRef.current?.cancelAnalysis() : void autoCrop()}>{analyzing ? <X size={14} /> : <LocateFixed size={14} />}{analyzing ? '取消边界分析' : '自动边界'}</button><button className="button-secondary compact" title="恢复完整画面" onClick={() => { const full = { x: 0, y: 0, width: 1, height: 1 }; updateRecipe((current) => ({ ...current, crop: full, geometry: { ...current.geometry, corners: rectToQuad(full) } })); }}><RotateCcw size={14} />恢复全图</button></div>
                  <details className="crop-numeric"><summary>精确数值</summary>
                    <RangeControl label="左" value={recipe.crop.x} min={0} max={Math.max(0, 1 - recipe.crop.width)} step={0.01} display={percent} onChange={(value) => changeCrop({ x: value })} />
                    <RangeControl label="上" value={recipe.crop.y} min={0} max={Math.max(0, 1 - recipe.crop.height)} step={0.01} display={percent} onChange={(value) => changeCrop({ y: value })} />
                    <RangeControl label="宽" value={recipe.crop.width} min={0.02} max={1 - recipe.crop.x} step={0.01} display={percent} onChange={(value) => changeCrop({ width: value })} />
                    <RangeControl label="高" value={recipe.crop.height} min={0.02} max={1 - recipe.crop.y} step={0.01} display={percent} onChange={(value) => changeCrop({ height: value })} />
                  </details>
                  <div className="panel-section context-section">
                    <h3 className="section-heading">方向与镜头</h3>
                    <RangeControl label="拉直" value={recipe.geometry.straighten} min={-10} max={10} step={0.1} display={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}°`} onChange={(value) => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, straighten: value } }))} onReset={() => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, straighten: 0 } }))} />
                    <RangeControl label="镜头畸变" value={recipe.geometry.lensDistortion} min={-100} max={100} step={1} display={(value) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`} onChange={(value) => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, lensDistortion: value } }))} onReset={() => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, lensDistortion: 0 } }))} />
                    <div className="geometry-buttons">
                      <button className="icon-button" aria-label="顺时针旋转" title="顺时针旋转" onClick={() => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, rotation90: ((current.geometry.rotation90 + 1) % 4) as 0 | 1 | 2 | 3 } }))}><RotateCw size={15} /></button>
                      <button className={`icon-button ${recipe.geometry.flipX ? 'is-active' : ''}`} aria-label="水平翻转" title="水平翻转" onClick={() => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, flipX: !current.geometry.flipX } }))}><FlipHorizontal2 size={15} /></button>
                      <button className={`icon-button ${recipe.geometry.flipY ? 'is-active' : ''}`} aria-label="垂直翻转" title="垂直翻转" onClick={() => updateRecipe((current) => ({ ...current, geometry: { ...current.geometry, flipY: !current.geometry.flipY } }))}><FlipVertical2 size={15} /></button>
                      <button className="icon-button" aria-label="重置几何" title="重置几何" onClick={() => updateRecipe((current) => ({ ...current, crop: { x: 0, y: 0, width: 1, height: 1 }, geometry: createDefaultRecipe().geometry }))}><RotateCcw size={15} /></button>
                    </div>
                  </div>
                  <button className="button-primary full" onClick={() => selectDevelopTool('adjust')}><Check size={15} />完成裁切</button>
                </div>}
                {developTool === 'dust' && <div className="context-inspector">
                  <div className="context-intro"><ScanLine size={18} /><div><b>自动建议 + 手动修正</b><span>先运行传统检测，再在画面上点击增删标记；修复会随预览实时更新。</span></div></div>
                  <button className={`button-secondary full ${dustDetecting ? 'danger-outline' : ''}`} disabled={!previewReady && !dustDetecting} onClick={() => dustDetecting ? developRef.current?.cancelAnalysis() : void autoDetectDust()}>{dustDetecting ? <X size={14} /> : <Sparkles size={14} />}{dustDetecting ? '取消灰尘分析' : '自动查找灰尘'}</button>
                  <RangeControl label="画笔大小" value={dustRadius} min={0.004} max={0.05} step={0.001} display={(value) => `${(value * 100).toFixed(1)}%`} onChange={setDustRadius} onReset={() => setDustRadius(0.012)} />
                  <div className="context-stat"><span>当前标记</span><b>{recipe.spots?.length ?? 0}</b></div>
                  <button className="button-secondary full danger-outline" disabled={!recipe.spots?.length} onClick={() => updateRecipe((current) => ({ ...current, spots: undefined }))}><Trash2 size={14} />清除全部标记</button>
                  <button className="button-primary full" onClick={() => selectDevelopTool('adjust')}><Check size={15} />完成除尘</button>
                </div>}
                {developTool === 'adjust' && <>
                {recipe.algorithmVersion === 'chromik-5' && <div className="recipe-compatibility"><Info size={15} /><span><b>旧版外观兼容模式</b><small>保持 Chromik 5 数学，不会因打开图库而自动改色。</small></span><button onClick={confirmRecipeAlgorithmUpgrade}>升级算法…</button></div>}
                <div className="adjust-accordion">
                <div className="adjust-accordion-actions"><button onClick={() => setAdjustSections(new Set(['basic', 'tone', 'color', 'style', 'curves', 'advanced', 'presets']))}>全部展开</button><button onClick={() => setAdjustSections(new Set())}>全部收起</button></div>
                <section className={`adjust-accordion-item ${adjustSections.has('presets') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('presets')} aria-controls="adjust-presets" onClick={() => toggleAdjustSection('presets')}><span>预设与批量</span><small>直方图、预设、复制/应用整卷</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-presets">
                  <div className="preset-panel">
                    <div className="section-heading"><Palette size={14} />预设</div>
                    <div className="preset-save-row">
                      <input value={presetName} placeholder="预设名称" maxLength={64} onChange={(event) => setPresetName(event.target.value)} aria-label="预设名称" />
                      <button className="button-secondary compact" disabled={!presetName.trim()} onClick={() => void savePreset()}>保存当前调色</button>
                    </div>
                    {presets.length ? <div className="preset-chips">{presets.map((preset) => (
                      <span key={preset.id} className="preset-chip">
                        <button className="preset-apply" title={`应用「${preset.name}」`} onClick={() => applyPreset(preset)}>{preset.name}</button>
                        <button className="preset-delete" aria-label={`删除预设 ${preset.name}`} onClick={() => void deletePreset(preset.id)}><X size={11} /></button>
                      </span>
                    ))}</div> : <p className="preset-empty">调好一卷的颜色后保存为预设，下一卷直接套用。</p>}
                  </div>
                  <div className="histogram-wrap"><Histogram bins={histogram} waveform={waveform} /><div className="histogram-labels"><span>阴影</span><span>中间调</span><span>高光</span></div></div>
                  <div className="recipe-actions"><button onClick={copyCurrentGrade}><Copy size={13} />复制参数</button><button disabled={!copiedGrade} onClick={pasteCurrentGrade}><ClipboardPaste size={13} />粘贴</button><button onClick={() => void copyRecipeToRoll()}><Images size={13} />应用整卷</button></div>
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('basic') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('basic')} aria-controls="adjust-basic" onClick={() => toggleAdjustSection('basic')}><span>基本</span><small>曝光、白平衡</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-basic">
                  <RangeControl label="曝光" value={recipe.grade.exposureEv} min={-3} max={3} step={0.05} display={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, exposureEv: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, exposureEv: 0 } }))} />
                  <RangeControl label="色温" value={recipe.grade.temperature} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, temperature: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, temperature: createRecipeForFilmType(activeRoll?.filmType ?? 'unknown').grade.temperature } }))} />
                  <RangeControl label="色调" value={recipe.grade.tint} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, tint: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, tint: 0 } }))} />
                  <label className="switch-line"><button className="switch" role="switch" aria-checked={recipe.grade.blackAndWhite} data-checked={recipe.grade.blackAndWhite} onClick={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, blackAndWhite: !current.grade.blackAndWhite } }))} aria-label="黑白模式" /><span>黑白模式</span></label>
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('tone') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('tone')} aria-controls="adjust-tone" onClick={() => toggleAdjustSection('tone')}><span>影调</span><small>明暗、对比、层次</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-tone">
                  <RangeControl label="对比度" value={recipe.grade.contrast} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, contrast: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, contrast: createRecipeForFilmType(activeRoll?.filmType ?? 'unknown').grade.contrast } }))} />
                  <RangeControl label="高光" value={recipe.grade.highlights} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, highlights: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, highlights: 0 } }))} />
                  <RangeControl label="阴影" value={recipe.grade.shadows} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, shadows: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, shadows: 0 } }))} />
                  <RangeControl label="Gamma" value={recipe.grade.gamma} min={0.5} max={2} step={0.02} display={(value) => value.toFixed(2)} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, gamma: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, gamma: 1 } }))} />
                  <RangeControl label="高光过渡" value={recipe.grade.highlightRolloff} min={0} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, highlightRolloff: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, highlightRolloff: 35 } }))} />
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('color') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('color')} aria-controls="adjust-color" onClick={() => toggleAdjustSection('color')}><span>颜色</span><small>饱和度、自然饱和度</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-color">
                  <RangeControl label="饱和度" value={recipe.grade.saturation} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, saturation: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, saturation: 0 } }))} />
                  <RangeControl label="自然饱和度" value={recipe.grade.vibrance} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, vibrance: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, vibrance: 0 } }))} />
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('style') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('style')} aria-controls="adjust-style" onClick={() => toggleAdjustSection('style')}><span>风格</span><small>预设、LUT、暗角</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-style">
                  <h3 className="section-heading">胶片风格 <InfoTip text="风格位于基础转换之后，用于塑造相纸暖调、经典彩色、反转片清透感或银盐黑白。" /></h3>
                  <div className="look-grid">{(Object.keys(LOOK_LABELS) as BuiltinLook[]).map((look) => <button key={look} className={recipe.grade.look === look ? 'active' : ''} onClick={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, look, blackAndWhite: look === 'silver_bw' ? true : current.grade.look === 'silver_bw' ? false : current.grade.blackAndWhite } }))}>{LOOK_LABELS[look]}</button>)}</div>
                  {recipe.grade.look !== 'neutral' && <RangeControl label="风格强度" value={recipe.grade.lookStrength} min={0} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, lookStrength: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, lookStrength: 100 } }))} />}
                  <RangeControl label="褪色" value={recipe.grade.fade} min={0} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, fade: value } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, fade: 0 } }))} />
                  <RangeControl label="暗角" value={recipe.grade.vignette.strength} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, vignette: { ...current.grade.vignette, strength: value } } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, vignette: { ...current.grade.vignette, strength: 0 } } }))} />
                  <div className="lut-picker"><label>LUT <InfoTip text="导入 .cube 格式的显示参考 LUT，在基础风格之后套用。" /></label><CustomSelect label="显示参考 LUT" value={recipe.grade.lutId ?? ''} options={[{ value: '', label: '不使用 LUT' }, ...luts.map((lut) => ({ value: lut.id, label: lut.title }))]} onChange={(lutId) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, lutId: lutId || undefined } }))} /><button className="button-secondary compact" onClick={() => void importLuts()}>导入 .cube</button></div>
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('curves') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('curves')} aria-controls="adjust-curves" onClick={() => toggleAdjustSection('curves')}><span>曲线</span><small>RGB 与分通道</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-curves">
                  <div className="curve-tabs">{(['rgb', 'red', 'green', 'blue'] as const).map((channel) => <button key={channel} className={curveChannel === channel ? 'active' : ''} onClick={() => setCurveChannel(channel)}>{channel === 'rgb' ? 'RGB' : channel === 'red' ? '红' : channel === 'green' ? '绿' : '蓝'}</button>)}</div>
                  <CurveEditor channel={curveChannel} points={recipe.grade.curves[curveChannel]} onChange={(points) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, curves: { ...current.grade.curves, [curveChannel]: points } } }))} />
                  <button className="text-button curve-reset" onClick={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, curves: { ...current.grade.curves, [curveChannel]: identityCurve() } } }))}><RotateCcw size={12} />复位当前曲线</button>
                  </div></div>
                </section>
                <section className={`adjust-accordion-item ${adjustSections.has('advanced') ? 'open' : ''}`}>
                  <button className="adjust-accordion-trigger" aria-expanded={adjustSections.has('advanced')} aria-controls="adjust-advanced" onClick={() => toggleAdjustSection('advanced')}><span>高级颜色</span><small>暗房灯光、CMYD</small><ChevronRight size={14} /></button>
                  <div className="adjust-accordion-reveal"><div className="adjust-accordion-content" id="adjust-advanced">
                  <h3 className="section-heading">Printer Lights <InfoTip text="模拟暗房彩色放大机的红、绿、蓝滤色调整，适合小步长校正偏色。" /></h3>
                  {(['R', 'G', 'B'] as const).map((label, channel) => <RangeControl key={label} label={label} value={recipe.grade.printerLights[channel]} min={-12} max={12} step={0.5} display={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`} onChange={(value) => updateRecipe((current) => { const printerLights = [...current.grade.printerLights] as RGB; printerLights[channel] = value; return { ...current, grade: { ...current.grade, printerLights } }; })} />)}
                  <h3 className="section-heading advanced-color-heading">CMYD 减色 <InfoTip text="青减少红、品红减少绿、黄减少蓝；密度控制整体明暗。" /></h3>
                  {(['cyan', 'magenta', 'yellow', 'density'] as const).map((key) => <RangeControl key={key} label={key === 'cyan' ? '青' : key === 'magenta' ? '品红' : key === 'yellow' ? '黄' : '密度'} value={recipe.grade.cmy[key]} min={-100} max={100} onChange={(value) => updateRecipe((current) => ({ ...current, grade: { ...current.grade, cmy: { ...current.grade.cmy, [key]: value } } }))} onReset={() => updateRecipe((current) => ({ ...current, grade: { ...current.grade, cmy: { ...current.grade.cmy, [key]: 0 } } }))} />)}
                  </div></div>
                </section>
                </div>
                </>}
              </>}
          />
        )}
        {exportOpen && createPortal(<div className={`overlay-backdrop export-overlay ${window.filmLab.platform === 'darwin' ? 'macos-overlay' : ''}`} onMouseDown={(event) => event.target === event.currentTarget && closeExport()}>
          <section className="overlay-sheet export-sheet glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
            <header className="overlay-heading export-heading"><button type="button" className="overlay-back-button" aria-label="返回" onPointerDown={(event) => event.stopPropagation()} onClick={closeExport}><ChevronLeft size={18} /><span>返回</span></button><span className="topbar-context-divider" /><div><p className="eyebrow">EXPORT</p><h2 id="export-dialog-title">导出</h2><span>{exportRangeLabel} · 预览、范围与输出设置</span></div></header>
          <section className="export-layout view-enter">
            <aside className="panel glass-surface export-settings">
              <div className="panel-title">预设与输出</div>
              <div className="panel-scroll export-settings-body">
                <div className="field-group export-filename"><label>文件名称</label><div className="read-only-field mono">原文件名_processed</div><small>保留原名并添加后缀，避免覆盖原始文件。</small></div>
                <div className="export-purpose">
                  <span>先选用途</span>
                  <div className="export-preset-grid">
                    <button onClick={() => applyExportPreset('share')}><b>分享</b><small>JPEG · 2048px · sRGB</small></button>
                    <button onClick={() => applyExportPreset('archive')}><b>高质量存档</b><small>16 位 TIFF · 原尺寸</small></button>
                    <button onClick={() => applyExportPreset('edit')}><b>继续修图</b><small>16 位线性 DNG · 实验</small></button>
                  </div>
                </div>
                <div className="field-group"><label>文件格式 <InfoTip text="JPEG 体积小，适合分享；PNG 适合无损 8/16 位保存；TIFF 适合后续专业修图或打印；线性 DNG 仍属实验输出，需在你的后期软件中检查兼容性（忽略分辨率与锐化设置）。" /></label><SlidingSegment value={exportFormat} options={([['jpeg', 'JPEG'], ['png', 'PNG'], ['tiff', 'TIFF'], ['dng', 'DNG 实验']] as const)} onChange={setExportFormat} label="导出文件格式" /></div>
                {exportFormat === 'jpeg' && <div className="field-group"><label>JPEG 质量 <b>{exportQuality}</b></label><input className="range-input" type="range" min="60" max="100" value={exportQuality} style={{ '--range-progress': `${(exportQuality - 60) / 40 * 100}%` } as React.CSSProperties} onChange={(event) => setExportQuality(Number(event.target.value))} /></div>}
                {exportFormat !== 'jpeg' && exportFormat !== 'dng' && <div className="field-group"><label>位深 <InfoTip text="16 位保留更多色调层次，适合继续修图；8 位文件更小，兼容性更好。" /></label><div className="segment-control two"><button className={exportBitDepth === 8 ? 'active' : ''} onClick={() => setExportBitDepth(8)}>8 位</button><button className={exportBitDepth === 16 ? 'active' : ''} onClick={() => setExportBitDepth(16)}>16 位</button></div></div>}
                {exportFormat === 'dng' && <div className="field-group"><label>位深</label><div className="read-only-field mono">16 位 · 线性 DNG（实验）</div><small>未承诺所有第三方软件一致解释；请先用单张验证。</small></div>}

                <div className="resolution-card">
                  <div className="resolution-heading"><span>分辨率</span><InfoTip text="“保留原始分辨率”会按分帧后的实际像素导出。关闭后可设置宽高；链接时保留比例并缩放到设定边界内。" /></div>
                  <label className="switch-line preserve-resolution"><button className="switch" role="switch" aria-checked={preserveOriginalSize} data-checked={preserveOriginalSize} onClick={() => setPreserveOriginalSize((value) => !value)} aria-label="保留原始分辨率" /><span>保留原始分辨率</span></label>
                  <div className={`resolution-fields ${preserveOriginalSize ? 'disabled' : ''}`}>
                    <label><span>宽</span><BoundedNumberInput min={1} max={100000} disabled={preserveOriginalSize} value={exportWidth} aria-label="导出宽度" onChange={changeExportWidth} /><small>px</small></label>
                    <button className={`resolution-link ${exportLockAspect ? 'active' : ''}`} disabled={preserveOriginalSize} title={exportLockAspect ? '已链接宽高比例' : '宽高可分别设置'} onClick={() => setExportLockAspect((value) => !value)}>{exportLockAspect ? <Link2 size={15} /> : <Unlink2 size={15} />}</button>
                    <label><span>高</span><BoundedNumberInput min={1} max={100000} disabled={preserveOriginalSize} value={exportHeight} aria-label="导出高度" onChange={changeExportHeight} /><small>px</small></label>
                  </div>
                  <div className="resolution-presets">
                    {[[6000, 4000, '高清'], [4000, 2667, '常用'], [2048, 1365, '分享']].map(([width, height, label]) => <button key={String(width)} disabled={preserveOriginalSize} onClick={() => { setExportWidth(Number(width)); setExportHeight(Number(height)); }}>{label}<small>{width}×{height}</small></button>)}
                  </div>
                </div>

                <details className="export-advanced">
                  <summary>详细输出设置 <small>锐化、色彩空间、重名与边框</small></summary>
                <div className="field-group"><label>输出锐化 <InfoTip text="补偿缩放和输出时的轻微清晰度损失。分享建议“屏幕”，需要继续修图时选“无”。" /></label><div className="segment-control three"><button className={exportSharpening === 0 ? 'active' : ''} onClick={() => setExportSharpening(0)}>无</button><button className={exportSharpening === 20 ? 'active' : ''} onClick={() => setExportSharpening(20)}>屏幕</button><button className={exportSharpening === 45 ? 'active' : ''} onClick={() => setExportSharpening(45)}>打印</button></div></div>
                <div className="field-group"><label>重名处理</label><div className="segment-control two"><button className={exportConflict === 'rename' ? 'active' : ''} onClick={() => setExportConflict('rename')}>自动编号</button><button className={exportConflict === 'skip' ? 'active' : ''} onClick={() => setExportConflict('skip')}>跳过</button></div></div>
                <div className="field-group"><label>边框留白 <InfoTip text="在导出画面四周加白色留白（像素）。可直接输入，也可按住数字左右拖动调整。" /></label><BoundedNumberInput className="border-padding-input" min={0} max={1000} step={1} scrubbable value={exportBorderPadding} aria-label="边框留白像素，左右拖动可调整" onChange={setExportBorderPadding} /></div>
                {!preserveOriginalSize && <label className="switch-line export-switch"><button className="switch" role="switch" aria-checked={exportAllowUpscale} data-checked={exportAllowUpscale} onClick={() => setExportAllowUpscale((value) => !value)} aria-label="允许放大较小画面" /><span>允许放大较小画面</span><InfoTip text="如果某张照片小于设定分辨率，开启后会对它插值放大。" /></label>}
                <div className="field-group"><label>输出色彩 <InfoTip text="sRGB 兼容性最好；Display P3 可在苹果设备和广色域屏幕上保留更鲜明的颜色。两种模式都会嵌入匹配的 ICC 配置文件。" /></label><div className="segment-control two"><button className={exportColorSpace === 'srgb' ? 'active' : ''} onClick={() => setExportColorSpace('srgb')}>sRGB</button><button className={exportColorSpace === 'p3' ? 'active' : ''} onClick={() => setExportColorSpace('p3')}>Display P3</button></div></div>
                </details>
                <div className="export-note"><Info size={15} /><span>导出使用当前已调整效果。PNG/TIFF 可保存 16 位，原始文件不会被覆盖。</span></div>
                <details className="contact-config-card">
                  <summary><Images size={14} /><span>接触印样</span><small>单独设置总览排版</small></summary>
                  <div className="contact-config-body">
                  <div className="section-heading">输出类型 <InfoTip text="将一卷中的处理后画面排版成一张总览。多卷导出时会每卷生成一张。" /></div>
                  <div className="field-group"><label>风格</label><div className="segment-control">
                    {(['classic', 'darkroom', 'minimal'] as ContactSheetConfig['style'][]).map((style) => <button key={style} className={contactConfig.style === style ? 'active' : ''} onClick={() => setContactConfig((current) => ({ ...current, style }))}>{style === 'classic' ? '经典' : style === 'darkroom' ? '暗房' : '极简'}</button>)}
                  </div></div>
                  <div className="field-group"><label>输出清晰度</label><SlidingSegment value={contactConfig.resolution} options={([['preview', '预览'], ['standard', '标准'], ['best', '最佳']] as const)} onChange={(resolution) => setContactConfig((current) => ({ ...current, resolution }))} label="接触印样输出清晰度" /></div>
                  <div className="contact-grid-two">
                    <label>列数<CustomSelect label="接触印样列数" value={contactConfig.columns} onChange={(columns) => setContactConfig((current) => ({ ...current, columns }))} options={([3, 4, 5, 6] as const).map((columns) => ({ value: columns, label: `${columns} 列` }))} /></label>
                    <label>格式<CustomSelect label="接触印样文件格式" value={contactConfig.format} onChange={(format) => setContactConfig((current) => ({ ...current, format }))} options={[{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }]} /></label>
                  </div>
                  <label className="contact-title">标题<input value={contactConfig.title} placeholder={activeRoll?.name || '胶卷名称'} onChange={(event) => setContactConfig((current) => ({ ...current, title: event.target.value }))} /></label>
                  <label className="switch-line"><button className="switch" role="switch" aria-checked={contactConfig.showFileName} data-checked={contactConfig.showFileName} onClick={() => setContactConfig((current) => ({ ...current, showFileName: !current.showFileName }))} aria-label="显示文件名" /><span>显示文件名</span></label>
                  <label className="switch-line"><button className="switch" role="switch" aria-checked={contactConfig.showMetadata} data-checked={contactConfig.showMetadata} onClick={() => setContactConfig((current) => ({ ...current, showMetadata: !current.showMetadata }))} aria-label="显示胶卷信息" /><span>显示胶卷信息</span></label>
                  </div>
                </details>
              </div>
            </aside>

            <section className="export-center">
              <div className="page-heading">
                <div><p className="eyebrow">EXPORT PREVIEW</p><h1>导出预览</h1><p>{exportRangeLabel} · 已选 {exportSelection.size}/{exportFrames.length} 张</p></div>
                <div className="selection-actions"><button onClick={() => setExportSelection(new Set(exportFrames.map((frame) => frame.id)))}>全选</button><button onClick={() => setExportSelection(new Set())}>清空</button></div>
              </div>
              {exportPreviewFrame && <ExportPreview frame={exportPreviewFrame} rollName={exportPreviewRoll?.name ?? '胶卷'} systemGestures />}
              <VirtualPhotoGrid className="export-list glass-surface" layoutMode="grid" minimumColumnWidth={150} gap={7} thumbnailHeightRatio={2 / 3} metadataHeight={42} listItemHeight={110} ariaLabel="导出画面虚拟列表" itemKey={(frame) => frame.id} items={exportFrames} renderItem={(frame) => {
                  const index = exportFrames.indexOf(frame);
                  const checked = exportSelection.has(frame.id);
                  const frameRoll = rolls.find((roll) => roll.id === frame.rollId);
                  return <div className={`export-row ${checked ? 'checked' : ''} ${frame.id === exportPreviewFrame?.id ? 'previewing' : ''}`} role="button" tabIndex={0} onClick={() => setExportPreviewId(frame.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExportPreviewId(frame.id); } }}>
                    <div className="export-row-thumb"><img src={frame.processedPreviewUrl} loading="lazy" decoding="async" draggable={false} alt="" /><button className="custom-check" aria-label={checked ? '从导出中取消选择' : '选择导出'} onClick={(event) => { event.stopPropagation(); setExportSelection((current) => { const next = new Set(current); if (next.has(frame.id)) next.delete(frame.id); else next.add(frame.id); return next; }); }}>{checked && <Check size={14} />}</button><span className="export-index">{String(index + 1).padStart(2, '0')}</span></div>
                    <span className="export-name"><b>{frame.name}</b><small>{frameRoll?.name ?? '胶卷'} · {frame.width} × {frame.height}</small></span>
                  </div>;
                }} />
            </section>

            <aside className="panel glass-surface export-summary">
              <div className="panel-title">导出范围</div>
              <div className="summary-body">
                <div className="export-range-choices">
                  {selectedFrame && <button className={exportRangeLabel === '当前单张' ? 'active' : ''} onClick={() => void openExportForFrames([selectedFrame.id])}><ImagePlus size={15} /><span><b>当前照片</b><small>{selectedFrame.name}</small></span></button>}
                  {selectedLibraryFrameIds.size > 0 && <button className={exportRangeLabel.startsWith('所选 ') ? 'active' : ''} onClick={() => void openExportForFrames([...selectedLibraryFrameIds])}><Check size={15} /><span><b>所选照片</b><small>{selectedLibraryFrameIds.size} 张</small></span></button>}
                  {activeRollId && <button className={exportRangeLabel === '整卷胶片' ? 'active' : ''} onClick={() => void openExportForRolls([activeRollId])}><Film size={15} /><span><b>当前胶卷</b><small>{activeRoll?.name}</small></span></button>}
                  {selectedRollIds.size > 1 && <button className={exportRangeLabel.endsWith('卷胶卷') ? 'active' : ''} onClick={() => void openExportForRolls([...selectedRollIds])}><Images size={15} /><span><b>多卷胶片</b><small>{selectedRollIds.size} 卷</small></span></button>}
                </div>
                <div className="summary-number"><b>{exportSelection.size}</b><span>张待导出</span></div>
                <div className="summary-lines"><div><span>导出范围</span><b>{exportRangeLabel}</b></div><div><span>格式</span><b>{exportFormat.toUpperCase()}</b></div><div><span>分辨率</span><b>{preserveOriginalSize ? '保留原尺寸' : `${exportWidth}×${exportHeight}`}</b></div><div><span>任务方式</span><b>逐张安全处理</b></div></div>
                {exportProgress && (
                  <div className={`progress-card ${exportProgress.status}`} role="status" aria-live="polite" aria-label={`导出进度 ${exportProgress.done}/${exportProgress.total}`}>
                    <div className="progress-head"><span>{exportProgress.status === 'running' ? (exportProgress.taskKind === 'contact-sheet' ? '正在生成接触印样' : '正在导出') : exportProgress.status === 'completed' ? (exportProgress.taskKind === 'contact-sheet' ? '接触印样完成' : '导出完成') : exportProgress.status === 'cancelled' ? '已取消' : '任务失败'}</span><b>{exportProgress.done}/{exportProgress.total}</b></div>
                    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={exportProgress.total} aria-valuenow={exportProgress.done}><span style={{ '--progress': exportProgress.total ? exportProgress.done / exportProgress.total : 0 } as React.CSSProperties} /></div>
                    <small>{exportProgress.currentName || (exportProgress.errors.length ? `${exportProgress.errors.length} 张失败${exportProgress.skipped ? ` · ${exportProgress.skipped} 张已跳过` : ''}` : exportProgress.skipped ? `已跳过 ${exportProgress.skipped} 张（重名）` : '文件已安全写入')}</small>
                    {exportProgress.status === 'completed' && exportDirectory && <button className="text-button" onClick={() => void window.filmLab.showInFolder(exportDirectory)}><FolderOpen size={14} />打开文件夹</button>}
                  </div>
                )}
                <div className="summary-spacer" />
                <div className="export-destination-inline"><button className="directory-picker" onClick={() => void chooseExportDirectory()}><FolderOpen size={17} /><span>{exportDirectory || '先选择导出文件夹'}</span></button>{exportDirectory && <button className="icon-button" title="清除本次导出位置" aria-label="清除导出位置" onClick={() => setExportDirectory('')}><X size={14} /></button>}</div>
                {isExporting ? <button className="button-secondary full danger-outline" onClick={() => exportProgress && void window.filmLab.cancelExport(exportProgress.jobId)}><X size={16} />{exportProgress.taskKind === 'contact-sheet' ? '取消并清理临时文件' : '立即停止并清理'}</button> : <button className="button-primary full" onClick={() => void startExport()}><Play size={17} />开始导出</button>}
                {!isExporting && <button className="button-secondary full" onClick={() => void createContactSheet()}><Images size={16} />生成接触印样</button>}
                <p className="privacy-note"><Save size={14} />新文件使用后缀保存，不覆盖任何已有文件。</p>
              </div>
            </aside>
          </section>
          </section>
        </div>, document.body)}

        {settingsOpen && createPortal(<div className={`overlay-backdrop settings-overlay ${window.filmLab.platform === 'darwin' ? 'macos-overlay' : ''}`} onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
          <section className="settings-dialog glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
            <header className="overlay-heading"><div><p className="eyebrow">PREFERENCES</p><h2 id="settings-dialog-title">设置</h2><span>外观、交互、导入与输出偏好</span></div><div className="overlay-heading-actions"><button className="button-secondary compact" onClick={() => { setSettings(DEFAULT_SETTINGS); setExportFormat(DEFAULT_SETTINGS.defaultExportFormat); setContactConfig((current) => ({ ...current, style: DEFAULT_SETTINGS.defaultContactStyle })); }}>恢复默认</button><button className="icon-button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div></header>
          <section className="settings-page view-enter">
            <div className="settings-search"><Search size={13} /><input value={settingsSearch} onChange={(event) => setSettingsSearch(event.target.value)} placeholder="搜索设置…（如：导出、动效、备份）" aria-label="搜索设置" /></div>
            <nav className="settings-nav" aria-label="设置分类">
              {SETTINGS_SECTIONS.filter((section) => !settingsSearch.trim() || settingsSectionMatches(section, settingsSearch.trim())).map(([id, label, Icon]) => <button key={id} className={settingsSection === id ? 'active' : ''} onClick={() => setSettingsSection(id)}><Icon size={17} /><span>{label}</span></button>)}
              {settingsSearch.trim() && !SETTINGS_SECTIONS.some((section) => settingsSectionMatches(section, settingsSearch.trim())) && <p className="settings-search-empty">没有匹配的设置分类，试试「导出」「动效」「备份」</p>}
            </nav>
            <div className="settings-grid">
              <section className={`settings-card import-settings-card ${settingsSection === 'import' ? 'active' : ''}`}>
                <div className="settings-card-icon"><Sparkles size={19} /></div><div className="settings-card-copy"><h2>导入与识别</h2><p>将原始素材放入胶卷时的自动处理。</p></div>
                <label className="settings-row"><div><b>自动判断胶片类型</b><span>尝试识别彩色/黑白以及负片/反转片，不确定时保留手动选择。</span></div><button className="switch" role="switch" aria-checked={settings.autoDetectFilmType} data-checked={settings.autoDetectFilmType} onClick={() => setSettings((current) => ({ ...current, autoDetectFilmType: !current.autoDetectFilmType }))} aria-label="自动判断胶片类型" /></label>
                <div className="settings-static-row"><div><b>素材结构自动识别</b><span>自动区分长条、接触印样和单张，并在导入后提供一次确认。</span></div><span className="settings-status-badge"><Check size={13} />已启用</span></div>
              </section>
              <section className={`settings-card interaction-settings-card ${settingsSection === 'interaction' ? 'active' : ''}`}>
                <div className="settings-card-icon"><MousePointer2 size={19} /></div><div className="settings-card-copy"><h2>操作与动态效果</h2><p>系统反馈、过渡动画与功能说明。</p></div>
                <div className="settings-choice"><label>动态效果</label><SlidingSegment value={settings.motionLevel} options={([['full', '完整'], ['reduced', '减弱'], ['off', '关闭']] as const)} onChange={(motionLevel) => setSettings((current) => ({ ...current, motionLevel }))} label="动态效果" /><p className="settings-choice-note">“减弱”保留状态反馈，但移除大幅位移和弹性缩放。</p></div>
                <label className="settings-row"><div><b>显示功能说明</b><span>显示界面中的 ⓘ 说明入口和悬停提示。</span></div><button className="switch" role="switch" aria-checked={settings.showTooltips} data-checked={settings.showTooltips} onClick={() => setSettings((current) => ({ ...current, showTooltips: !current.showTooltips }))} aria-label="显示功能说明" /></label>
              </section>
              <section className={`settings-card appearance-settings-card ${settingsSection === 'appearance' ? 'active' : ''}`}>
                <div className="settings-card-icon"><Palette size={19} /></div><div className="settings-card-copy"><h2>外观与材质</h2><p>毛玻璃强度、界面密度与画布背景。</p></div>
                <div className="settings-choice"><label>玻璃材质</label><SlidingSegment value={settings.materialLevel} options={([['soft', '轻盈'], ['balanced', '标准'], ['rich', '浓郁']] as const)} onChange={(materialLevel) => setSettings((current) => ({ ...current, materialLevel }))} label="玻璃材质" /></div>
                <div className="settings-choice"><label>界面密度</label><SlidingSegment value={settings.interfaceDensity} options={([['comfortable', '舒展'], ['compact', '紧凑']] as const)} onChange={(interfaceDensity) => setSettings((current) => ({ ...current, interfaceDensity }))} label="界面密度" /></div>
                <label className="settings-row"><div><b>透明区域棋盘格</b><span>关闭后，预览画布使用纯深色背景。</span></div><button className="switch" role="switch" aria-checked={settings.checkerboard} data-checked={settings.checkerboard} onClick={() => setSettings((current) => ({ ...current, checkerboard: !current.checkerboard }))} aria-label="透明区域棋盘格" /></label>
              </section>
              <section className={`settings-card export-defaults-card ${settingsSection === 'export' ? 'active' : ''}`}>
                <div className="settings-card-icon"><Download size={19} /></div><div className="settings-card-copy"><h2>导出默认值</h2><p>之后进入导出页面时优先使用的选项。</p></div>
                <div className="settings-choice"><label>默认文件格式</label><SlidingSegment value={settings.defaultExportFormat} options={([['jpeg', 'JPEG'], ['png', 'PNG'], ['tiff', 'TIFF']] as const)} onChange={(defaultExportFormat) => { setSettings((current) => ({ ...current, defaultExportFormat })); setExportFormat(defaultExportFormat); }} label="默认文件格式" /></div>
                <div className="settings-choice"><label>默认接触印样风格</label><SlidingSegment value={settings.defaultContactStyle} options={([['classic', '经典'], ['darkroom', '暗房'], ['minimal', '极简']] as const)} onChange={(defaultContactStyle) => { setSettings((current) => ({ ...current, defaultContactStyle })); setContactConfig((current) => ({ ...current, style: defaultContactStyle })); }} label="默认接触印样风格" /></div>
                <div className="settings-static-row default-directory-row"><div><b>默认导出文件夹</b><span>{settings.defaultExportDirectory || '尚未设置；可在导出时选择并保存为默认。'}</span></div><div className="settings-inline-actions"><button className="button-secondary compact" onClick={() => void chooseExportDirectory(true)}><FolderOpen size={14} />{settings.defaultExportDirectory ? '更改' : '选择'}</button>{settings.defaultExportDirectory && <button className="text-button" onClick={() => { setSettings((current) => ({ ...current, defaultExportDirectory: '' })); if (exportDirectory === settings.defaultExportDirectory) setExportDirectory(''); }}>清除</button>}</div></div>
                <label className="settings-row"><div><b>导出后自动打开文件夹</b><span>导出完成时自动在文件管理器中显示输出目录。</span></div><button className="switch" role="switch" aria-checked={settings.autoOpenExportFolder} data-checked={settings.autoOpenExportFolder} onClick={() => setSettings((current) => ({ ...current, autoOpenExportFolder: !current.autoOpenExportFolder }))} aria-label="导出后自动打开文件夹" /></label>
              </section>
              <section className={`settings-card backup-settings-card ${settingsSection === 'backup' ? 'active' : ''}`}>
                <div className="settings-card-icon"><DatabaseBackup size={19} /></div><div className="settings-card-copy"><h2>完整图库备份</h2><p>备份图库、配方、设置、预设、用户 LUT 和原片校验清单；原始照片仍留在原位置。</p></div>
                <div className="backup-section">
                  <div className="backup-overview"><div><b>保护本地图库</b><span>建议在大批导入、整理或版本升级前创建备份。</span></div><small>{backups.length ? `已有 ${backups.length} 个备份` : '还没有备份'}</small></div>
                  <div className="backup-actions">
                    <button className="button-primary compact" disabled={backupBusy} onClick={() => void createBackup()}>{backupBusy ? <LoaderCircle className="spin" size={14} /> : <DatabaseBackup size={14} />}{backupBusy ? '备份中…' : '立即备份'}</button>
                    <button className="button-secondary compact" onClick={() => setBackupsOpen((value) => !value)}>{backupsOpen ? '收起备份列表' : '查看备份'}</button>
                  </div>
                  {backupsOpen && (
                    backups.length ? <div className="backup-list">{backups.map((info) => (
                      <div key={info.path} className="backup-row">
                        <span title={info.path}>{info.path.split(/[\\/]/).at(-1)}</span>
                        <small>{new Date(info.createdAt).toLocaleString()} · {formatBytes(info.sizeBytes)}</small>
                        <button className="text-button danger" onClick={() => void restoreBackup(info)}>恢复</button>
                      </div>
                    ))}</div> : <p className="backup-empty">还没有备份。创建后会保存在 Chromik 的本地备份目录中。</p>
                  )}
                  {recoveryIssues > 0 && <p className="backup-caution recovery-note"><ShieldCheck size={13} />已自动修复 {recoveryIssues} 个损坏的配方记录（回退为默认参数）；图库未受影响，画面可重新调色。</p>}
                  <p className="backup-caution"><Info size={13} />恢复会替换图库、设置与用户 LUT，并自动保留恢复前数据库；原始照片不会被修改或删除。</p>
                </div>
                <div className="backup-section maintenance-section">
                  <div className="backup-overview"><div><b>原片与缓存维护</b><span>原片文件夹移动后可按名称、大小和内容哈希批量重定位；开发代理可安全清理并按需重建。</span></div><small>不修改原始照片</small></div>
                  <div className="backup-actions">
                    <button className="button-secondary compact" disabled={Boolean(maintenanceBusy)} onClick={() => void relocateMissingSources()}>{maintenanceBusy === 'relocate' ? <LoaderCircle className="spin" size={14} /> : <LocateFixed size={14} />}{maintenanceBusy === 'relocate' ? '正在校验…' : '批量重定位原片'}</button>
                    <button className="button-secondary compact" disabled={Boolean(maintenanceBusy)} onClick={() => void cleanRebuildableCache()}>{maintenanceBusy === 'cache' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{maintenanceBusy === 'cache' ? '正在清理…' : '清理可重建缓存'}</button>
                  </div>
                  <p className="backup-caution"><ShieldCheck size={13} />新导入素材使用首尾采样 SHA-256；无法唯一匹配时会保持缺失状态，不会把配方绑定到可疑文件。</p>
                </div>
              </section>
              <section className={`settings-card about-card ${settingsSection === 'about' ? 'active' : ''}`}>
                <div className="settings-card-icon"><Aperture size={19} /></div><div className="settings-card-copy"><h2>关于 Chromik 珂影</h2><p>专为胶片翻拍、扫描、分帧与本地非破坏处理设计。</p></div>
                <div className="about-product"><div className="about-mark"><Aperture size={24} /></div><div><b>Chromik 珂影</b><span>PREVIEW {appInfo?.version ?? ''} · {appInfo?.packaged ? 'Release Build' : 'Local Build'}</span></div></div>
                <div className="privacy-points"><span><Monitor size={15} /><b>本机处理</b></span><span><ShieldCheck size={15} /><b>原图只读</b></span><span><Save size={15} /><b>配方保存</b></span></div>
                <div className="about-lines"><div><span>处理方式</span><b>完全本地</b></div><div><span>数据原则</span><b>原图只读 · 配方保存</b></div><div><span>版权</span><b>© 2026 Chromik Contributors</b></div></div>
                <p className="about-note">独立实现，不包含或改写其他商业胶片软件的源码、预设、LUT 或专有色彩模型。</p>
                <p className="copyright-note">Copyright © 2026 Chromik Contributors.</p>
              </section>
            </div>
          </section>
          </section>
        </div>, document.body)}
        </ViewErrorBoundary>
      </main>

      {duplicateImport && createPortal(<div className="modal-backdrop chromik-dialog-backdrop">
        <section className="chromik-dialog duplicate-import-dialog glass-surface-strong" role="alertdialog" aria-modal="true" aria-labelledby="duplicate-import-title">
          <header><div className="dialog-symbol"><Copy size={22} /></div><div><p className="eyebrow">DUPLICATE CHECK</p><h2 id="duplicate-import-title">发现已导入的原片</h2><p>Chromik 按文件大小和内容哈希识别出 {duplicateImport.items.length} 个重复项。请选择是否仍在当前胶卷中建立引用。</p></div></header>
          <div className="import-review-list">
            {duplicateImport.items.slice(0, 8).map((item) => <article key={item.sourcePath} className="import-review-item">
              <div className="import-review-copy"><b title={item.sourcePath}>{item.name}</b><span title={item.existingPath}>已存在：{item.existingName}</span></div>
            </article>)}
            {duplicateImport.items.length > 8 && <p className="backup-empty">另有 {duplicateImport.items.length - 8} 个重复项</p>}
          </div>
          <div className="chromik-dialog-note"><ShieldCheck size={16} /><span>两种选择都不会复制、覆盖或修改磁盘上的原始照片。</span></div>
          <footer><button className="button-secondary" disabled={importing} onClick={() => void resolveDuplicateImport('skip')}>跳过重复项</button><button className="button-primary" disabled={importing} onClick={() => void resolveDuplicateImport('reference')}>仍然引用并导入</button></footer>
        </section>
      </div>, document.body)}

      {importReview && createPortal(<div className="modal-backdrop chromik-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !dialogBusy && setImportReview(undefined)}>
        <section className="chromik-dialog import-review-dialog glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="import-review-title">
          <header><div className="dialog-symbol"><Sparkles size={22} /></div><div><p className="eyebrow">IMPORT REVIEW</p><h2 id="import-review-title">已自动识别原始素材</h2><p>确认每个文件的结构。单张会直接进入调整，长条和印样才进入分帧。</p></div></header>
          <div className="import-review-list">
            {importReview.items.map((item) => <article key={item.id} className="import-review-item">
              <div className="import-review-copy"><b title={item.name}>{item.name}</b><span>{item.reason} · 可信度 {Math.round(item.confidence * 100)}%</span></div>
              <SlidingSegment value={item.kind === 'unknown' ? 'single' : item.kind} options={([['strip', '长条'], ['contact', '印样'], ['single', '单张']] as const)} label={`${item.name} 的素材类型`} onChange={(kind) => setImportReview((current) => current ? { ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, kind } : candidate) } : current)} />
            </article>)}
          </div>
          <div className="chromik-dialog-note"><Info size={16} /><span>这里只改变 Chromik 的处理方式，不会修改原始文件。</span></div>
          <footer><button className="button-secondary" disabled={dialogBusy} data-disabled-reason={dialogBusy ? '正在保存识别结果' : undefined} onClick={() => setImportReview(undefined)}>稍后处理</button><button className="button-primary" disabled={dialogBusy} data-disabled-reason={dialogBusy ? '正在创建画面预览，请稍候' : undefined} onClick={() => void confirmImportedAssets()}>{dialogBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认并继续</button></footer>
        </section>
      </div>, document.body)}

      {recognitionConflict && createPortal(<div className="modal-backdrop chromik-dialog-backdrop">
        <section className="chromik-dialog recognition-conflict-dialog glass-surface-strong" role="alertdialog" aria-modal="true" aria-labelledby="recognition-conflict-title">
          <header><div className="dialog-symbol"><Sparkles size={22} /></div><div><p className="eyebrow">AUTO RECOGNITION</p><h2 id="recognition-conflict-title">新素材与当前胶卷信息不一致</h2><p>“{recognitionConflict.sourceName}”得到了一组不同的可靠结果。Chromik 不会自动覆盖，请选择要保留的信息。</p></div></header>
          <div className="recognition-compare">
            <div><small>当前胶卷</small><b>{FILM_TYPE_LABELS[recognitionConflict.current.filmType]}</b><span>{recognitionConflict.current.filmStock || '型号未填写'}{recognitionConflict.current.iso ? ` · ISO ${recognitionConflict.current.iso}` : ''}</span></div>
            <ChevronRight size={18} />
            <div className="proposed"><small>新素材识别</small><b>{recognitionConflict.proposed.filmType ? FILM_TYPE_LABELS[recognitionConflict.proposed.filmType] : FILM_TYPE_LABELS[recognitionConflict.current.filmType]}</b><span>{recognitionConflict.proposed.filmStock || recognitionConflict.current.filmStock || '型号未识别'}{recognitionConflict.proposed.iso ? ` · ISO ${recognitionConflict.proposed.iso}` : ''}</span></div>
          </div>
          <footer><button className="button-secondary" disabled={dialogBusy} onClick={() => { setRecognitionConflict(undefined); showToast('已保留当前胶卷信息'); }}>保留当前</button><button className="button-primary" disabled={dialogBusy} onClick={() => void applyRecognizedMetadata(recognitionConflict)}>{dialogBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}使用新识别</button></footer>
        </section>
      </div>, document.body)}

      {exportDirectoryPrompt && createPortal(<div className="modal-backdrop chromik-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !dialogBusy && setExportDirectoryPrompt(undefined)}>
        <section className="chromik-dialog export-directory-dialog glass-surface-strong" role="alertdialog" aria-modal="true" aria-labelledby="export-directory-title">
          <header><div className="dialog-symbol"><FolderOpen size={22} /></div><div><p className="eyebrow">EXPORT LOCATION</p><h2 id="export-directory-title">先选择导出文件夹</h2><p>{exportDirectoryPrompt === 'export' ? '开始导出前，需要指定新文件的保存位置。' : '生成接触印样前，需要指定文件的保存位置。'}原始文件不会被覆盖。</p></div></header>
          <button className={`dialog-choice-row ${rememberExportDirectory ? 'selected' : ''}`} role="checkbox" aria-checked={rememberExportDirectory} onClick={() => setRememberExportDirectory((value) => !value)}><span className={`custom-check ${rememberExportDirectory ? 'checked' : ''}`}>{rememberExportDirectory && <Check size={13} />}</span><span><b>设为默认导出文件夹</b><small>以后打开导出面板时自动使用本次选择的位置，仍可随时更改。</small></span></button>
          <footer><button className="button-secondary" disabled={dialogBusy} onClick={() => setExportDirectoryPrompt(undefined)}>取消</button><button className="button-primary" disabled={dialogBusy} onClick={() => void resolveExportDirectoryPrompt()}>{dialogBusy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}选择文件夹并继续</button></footer>
        </section>
      </div>, document.body)}

      {confirmDialog && createPortal(<div className="modal-backdrop chromik-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !dialogBusy && setConfirmDialog(undefined)}>
        <section className="chromik-dialog confirm-dialog glass-surface-strong" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
          <header><div className={`dialog-symbol ${confirmDialog.tone === 'warning' ? 'warning' : 'danger'}`}>{confirmDialog.tone === 'warning' ? <DatabaseBackup size={21} /> : <Trash2 size={21} />}</div><div><p className="eyebrow">{confirmDialog.eyebrow ?? 'LIBRARY'}</p><h2 id="confirm-dialog-title">{confirmDialog.title}</h2><p>{confirmDialog.detail}</p></div></header>
          <footer><button autoFocus className="button-secondary" disabled={dialogBusy} data-disabled-reason={dialogBusy ? '正在处理，请稍候' : undefined} onClick={() => setConfirmDialog(undefined)}>取消</button><button className={confirmDialog.tone === 'warning' ? 'button-primary' : 'button-danger'} disabled={dialogBusy} data-disabled-reason={dialogBusy ? '正在处理，请稍候' : undefined} onClick={() => void runConfirmedAction()}>{dialogBusy ? <LoaderCircle className="spin" size={16} /> : confirmDialog.tone === 'warning' ? <DatabaseBackup size={16} /> : <Trash2 size={16} />}{confirmDialog.confirmLabel}</button></footer>
        </section>
      </div>, document.body)}

      {blockingProgress && createPortal(<div className="blocking-progress-backdrop" role="status" aria-live="polite" aria-atomic="true">
        <section className="blocking-progress-card glass-surface-strong">
          {blockingProgress.previewUrl && <img className="blocking-progress-preview" src={blockingProgress.previewUrl} alt="RAW 嵌入预览" />}
          <div className="blocking-progress-symbol"><LoaderCircle className="spin" size={25} /></div>
          <div className="blocking-progress-copy"><b>{blockingProgress.title}</b><span>{blockingProgress.detail}</span></div>
          <div className="blocking-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(blockingProgress.percent)}><i style={{ '--progress': blockingProgress.percent / 100 } as React.CSSProperties} /></div>
          <small>{Math.round(blockingProgress.percent)}%</small>
          {importing && <button className="text-button danger blocking-progress-cancel" onClick={() => { importAbortRef.current?.abort(); setBlockingProgress((current) => current ? { ...current, detail: '正在取消并清理未完成的缓存…' } : current); }}>取消导入</button>}
        </section>
      </div>, document.body)}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}

      {pasteScopeOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPasteScopeOpen(false)}>
          <section className="shortcut-help glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="paste-scope-title">
            <div className="modal-heading"><div><p className="eyebrow">PASTE SCOPE</p><h2 id="paste-scope-title">粘贴到所选 {selectedLibraryFrameIds.size} 张</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setPasteScopeOpen(false)}><X size={17} /></button></div>
            <p className="modal-intro">选择要同步的参数类别；裁切、片基与除尘不会被覆盖。</p>
            <div className="paste-scope-options">
              {([['all', '全部调色'], ['exposure', '仅曝光'], ['color', '颜色（色温/色调/饱和/灯光/CMY/黑白）'], ['style', '仅风格（风格/强度/LUT）'], ['curves', '仅曲线']] as Array<[PasteScope, string]>).map(([scope, label]) => (
                <button key={scope} className="paste-scope-option" onClick={() => void runPaste(scope)}>{label}</button>
              ))}
            </div>
          </section>
        </div>
      )}
      <DisabledHintLayer />

      {rollContextMenu && createPortal((() => {
        let menuNode: HTMLDivElement | null = null;
        const measure = () => {
          if (!menuNode) return;
          const rect = menuNode.getBoundingClientRect();
          if (rect.right > window.innerWidth) menuNode.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
          if (rect.bottom > window.innerHeight) menuNode.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
        };
        return <div ref={(node) => { menuNode = node; if (node) queueMicrotask(measure); }} className="roll-context-menu glass-surface-strong" style={{ left: Math.min(rollContextMenu.x, window.innerWidth - 238), top: Math.min(rollContextMenu.y, window.innerHeight - 230) }} onClick={(event) => {
          // Clicks anywhere inside the menu that aren't routed to a child
          // button should close it (mousedown on the backdrop relies on the
          // document-level click listener that would otherwise be preempted
          // by the menu's own click handler swallowing the event).
          if (event.target === event.currentTarget) setRollContextMenu(undefined);
        }}>
        <div className="context-menu-label">{selectedRollIds.size > 1 ? `已选 ${selectedRollIds.size} 卷胶片` : rolls.find((roll) => roll.id === rollContextMenu.rollId)?.name}</div>
        <button onClick={() => void editRollFromContext(rollContextMenu.rollId)}><Pencil size={15} />编辑胶卷信息</button>
        <button onClick={() => void openExportForRolls([rollContextMenu.rollId])}><Download size={15} />导出这一卷</button>
        {selectedRollIds.size > 1 && <button className="primary" onClick={() => void openExportForRolls([...selectedRollIds])}><Images size={15} />导出所选 {selectedRollIds.size} 卷</button>}
        <div className="context-menu-separator" />
        <button className="danger" onClick={() => void deleteRoll(rollContextMenu.rollId)}><Trash2 size={15} />删除这卷胶片…</button>
        <small>按 ⌘/Ctrl 点击可多选胶卷</small>
        </div>;
      })(), document.body)}

      {rollEditorOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setRollEditorOpen(false)}>
          <section ref={rollEditorRef} className="roll-editor glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="roll-editor-title" aria-describedby="roll-editor-description">
            <div className="modal-heading"><div><p className="eyebrow">ROLL PROFILE</p><h2 id="roll-editor-title">{rollEditorMode === 'create' ? '创建胶卷' : '编辑胶卷信息'}</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setRollEditorOpen(false)}><X size={17} /></button></div>
            <p id="roll-editor-description" className="modal-intro">片种可保持“自动识别”。加入原始素材后，软件会尝试判断负片/反转片与彩色/黑白，你也可随时手动更正。</p>
            <div className="roll-form-grid">
              <label className="span-two">胶卷名称<input autoFocus value={rollDraft.name} placeholder="例如：杭州夜景 01" onChange={(event) => setRollDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <label>片种<CustomSelect label="胶卷片种" value={rollDraft.filmType} onChange={(filmType) => setRollDraft((current) => ({ ...current, filmType }))} options={(Object.entries(FILM_TYPE_LABELS) as Array<[FilmType, string]>).map(([value, label]) => ({ value, label }))} /></label>
              <label>胶卷型号<input value={rollDraft.filmStock} placeholder="Portra 400 / Provia 100F" onChange={(event) => setRollDraft((current) => ({ ...current, filmStock: event.target.value }))} /></label>
              <label>ISO<input type="number" min="1" max="12800" value={rollDraft.iso ?? ''} placeholder="400" onChange={(event) => setRollDraft((current) => ({ ...current, iso: event.target.value ? Number(event.target.value) : undefined }))} /></label>
              <label>相机<AutocompleteInput value={rollDraft.camera ?? ''} suggestions={CAMERA_SUGGESTIONS} placeholder="搜索或输入相机" label="相机" onChange={(camera) => setRollDraft((current) => ({ ...current, camera }))} /></label>
              <label>镜头<AutocompleteInput value={rollDraft.lens ?? ''} suggestions={LENS_SUGGESTIONS} placeholder="搜索或输入镜头" label="镜头" onChange={(lens) => setRollDraft((current) => ({ ...current, lens }))} /></label>
              <label>冲洗参数<AutocompleteInput value={rollDraft.development ?? ''} suggestions={DEVELOPMENT_SUGGESTIONS} placeholder="搜索或输入冲洗工艺" label="冲洗参数" onChange={(development) => setRollDraft((current) => ({ ...current, development }))} /></label>
              <label>拍摄日期<CustomDatePicker value={rollDraft.shotDate ?? ''} onChange={(shotDate) => setRollDraft((current) => ({ ...current, shotDate }))} /></label>
              <label className="span-two">备注<textarea rows={3} value={rollDraft.notes} placeholder="扫描、翻拍或拍摄备注…" onChange={(event) => setRollDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
            </div>
            <div className="modal-foot"><span><Sparkles size={14} />添加素材后会自动判断片种，并尝试填写胶卷型号和 ISO。</span><div><button className="button-secondary" onClick={() => setRollEditorOpen(false)}>取消</button><button className="button-primary" onClick={() => void saveRoll()}><Save size={16} />{rollEditorMode === 'create' ? '创建并继续' : '保存信息'}</button></div></div>
          </section>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}><span aria-hidden="true">{toast.tone === 'error' ? <TriangleAlert size={17} /> : <Check size={17} />}</span><span>{toast.message}</span>{toast.action && <button type="button" className="toast-action" onClick={() => { const action = toast.action; setToast(undefined); action?.run(); }}>{toast.action.label}</button>}</div>}
    </AppShell>
  );
}
