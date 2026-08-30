export type RGB = [number, number, number];
/** Row-major 3×3 matrix used for channel-decoupling / dye cross-talk. */
export type Matrix9 = [number, number, number, number, number, number, number, number, number];
export interface DustSpot {
  x: number;
  y: number;
  r: number;
}
export type FilmType = 'color_negative' | 'color_slide' | 'bw_negative' | 'bw_slide' | 'unknown';
export type AssetKind = 'strip' | 'contact' | 'single' | 'unknown';

export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];
export interface CurvePoint {
  x: number;
  y: number;
}
export type CurvePoints = CurvePoint[];
export type InputTransfer = 'srgb' | 'linear';
export type PixelSourceRole = 'display' | 'develop' | 'master';

interface PixelSourceDescriptorBase {
  channels: 3 | 4;
  colorSpace: 'srgb';
}

/** View-only image. Its type is deliberately excluded from every processing entry point. */
export interface DisplayPreviewDescriptor extends PixelSourceDescriptorBase {
  role: 'display';
  transfer: 'srgb';
  bitDepth: 8;
  displayTransform: 'neutral' | 'gallery-lift';
}

/** Canonical analysis/preview source: 16-bit linear-light sRGB. */
export interface DevelopProxyDescriptor extends PixelSourceDescriptorBase {
  role: 'develop';
  transfer: 'linear';
  bitDepth: 16;
  version: number;
}

/** Full-resolution decode used by export; its transfer is explicitly owned by the decoder/cache. */
export interface MasterSourceDescriptor extends PixelSourceDescriptorBase {
  role: 'master';
  transfer: InputTransfer;
  bitDepth: 8 | 16;
  decoder: 'libraw' | 'sharp' | 'heic' | 'chromik-cache';
}

export type PixelSourceDescriptor = DisplayPreviewDescriptor | DevelopProxyDescriptor | MasterSourceDescriptor;
export type ProcessablePixelSourceDescriptor = DevelopProxyDescriptor | MasterSourceDescriptor;
export type CaptureProfileId = 'camera_srgb' | 'scanner_srgb' | 'linear_raw';
export type FilmResponseProfileId = 'generic_color_negative' | 'generic_bw_negative';
export type BuiltinLook = 'neutral' | 'warm_print' | 'classic_color' | 'cool_slide' | 'silver_bw';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditRecipe {
  /** Schema 5 remains readable so saved 0.9 appearances are never silently reinterpreted. */
  schemaVersion: 5 | 6;
  algorithmVersion: 'chromik-5' | 'chromik-6';
  crop: CropRect;
  geometry: {
    corners: Quad;
    rotation90: 0 | 1 | 2 | 3;
    straighten: number;
    lensDistortion: number;
    flipX: boolean;
    flipY: boolean;
  };
  baseRgb?: RGB;
  /** Canonical linear-light film-base sample. New processing never has to reinterpret UI RGB values. */
  baseRgbLinear?: RGB;
  density: {
    enabled: boolean;
    low: RGB;
    high: RGB;
    mode: 'display_reference' | 'cineon';
    profileId: CaptureProfileId;
    filmProfileId: FilmResponseProfileId;
    filmStockProfileId?: string;
    /** COL-11：所选胶卷型号配置的版本；升级配置后据此解释旧配方，避免外观静默漂移。 */
    filmStockProfileVersion?: string;
    inputTransfer: InputTransfer;
    separation: number;
    separationMatrix?: Matrix9;
    neutralProtection: number;
    crossoverStrength: number;
    shadowCorrection: RGB;
    midCorrection: RGB;
    highlightCorrection: RGB;
    lightSourceRgb?: RGB;
  };
  grade: {
    exposureEv: number;
    temperature: number;
    tint: number;
    contrast: number;
    gamma: number;
    saturation: number;
    vibrance: number;
    highlights: number;
    shadows: number;
    highlightRolloff: number;
    fade: number;
    printerLights: RGB;
    blackAndWhite: boolean;
    look: BuiltinLook;
    lookStrength: number;
    vignette: { strength: number; midpoint: number; roundness: number };
    cmy: { cyan: number; magenta: number; yellow: number; density: number };
    lutId?: string;
    curves: {
      rgb: CurvePoints;
      red: CurvePoints;
      green: CurvePoints;
      blue: CurvePoints;
    };
  };
  spots?: DustSpot[];
  updatedAt: number;
}

export interface RollCalibration {
  baseRgb?: RGB;
  baseRgbLinear?: RGB;
  density: EditRecipe['density'];
  updatedAt: number;
}

export interface RollSummary {
  id: string;
  name: string;
  filmType: FilmType;
  camera: string;
  lens: string;
  filmStock: string;
  iso?: number;
  development: string;
  shotDate: string;
  notes: string;
  edgeText: string;
  calibration: RollCalibration;
  assetCount: number;
  frameCount: number;
  createdAt: number;
  starred?: boolean;
  tags?: string[];
  /** AUTO-06：最近一次自动识别失败的中文原因；识别成功时为空。 */
  recognitionError?: string;
}

export type FrameStatus = 'ready' | 'missing' | 'error';

export interface FrameSummary {
  id: string;
  rollId: string;
  assetId?: string;
  frameNumber: number;
  name: string;
  sourcePath: string;
  width: number;
  height: number;
  format: string;
  fileSize: number;
  status: FrameStatus;
  previewUrl: string;
  sourcePreviewUrl: string;
  processedPreviewUrl: string;
  /** High-precision processing proxy; unlike sourcePreviewUrl it is never display-lifted. */
  developPreviewUrl: string;
  recipe: EditRecipe;
  createdAt: number;
  starred?: boolean;
  tags?: string[];
}

export interface AssetSummary {
  id: string;
  rollId: string;
  name: string;
  sourcePath: string;
  width: number;
  height: number;
  format: string;
  fileSize: number;
  status: FrameStatus;
  previewUrl: string;
  /** Processing-neutral proxy used for calibration/framing; RAW display previews may use a brighter view transform. */
  analysisPreviewUrl: string;
  /** High-precision processing proxy shared by analysis and frame development. */
  developPreviewUrl: string;
  kind: AssetKind;
  frameCount: number;
  createdAt: number;
  exif?: AssetExif;
}

/** Best-effort EXIF summary read at import time (RAW from LibRaw, others from sharp). */
export interface AssetExif {
  iso?: number;
  shutter?: string;
  aperture?: string;
  focalLength?: string;
  shotAt?: string;
  camera?: string;
  lens?: string;
}

/** A saved grade preset (colors / style / curves / lights, no geometry). */
export interface RecipePreset {
  id: string;
  name: string;
  grade: EditRecipe['grade'];
  createdAt: number;
}

/** Which parts of a recipe to paste onto selected frames. */
export type PasteScope = 'all' | 'exposure' | 'color' | 'style' | 'curves';

export interface BackupInfo {
  path: string;
  createdAt: number;
  sizeBytes: number;
}

export interface SourceRelocationResult {
  root?: string;
  matched: number;
  assets: number;
  frames: number;
  unmatched: Array<{ name: string; previousPath: string; reason: string }>;
}

export interface CacheMaintenanceResult {
  removedFiles: number;
  reclaimedBytes: number;
  message: string;
}

export interface SprocketInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RollInput {
  name: string;
  filmType: FilmType;
  camera?: string;
  lens?: string;
  filmStock?: string;
  iso?: number;
  development?: string;
  shotDate?: string;
  notes?: string;
}

export interface FrameRegionInput {
  frameId?: string;
  corners: Quad;
}

export type ExportFormat = 'jpeg' | 'png' | 'tiff' | 'dng';

export interface ExportConfig {
  directory: string;
  format: ExportFormat;
  quality: number;
  suffix: string;
  bitDepth: 8 | 16;
  resizeMode: 'original' | 'dimensions';
  width: number;
  height: number;
  lockAspect: boolean;
  allowUpscale: boolean;
  sharpening: number;
  colorSpace: 'srgb' | 'p3';
  conflictPolicy: 'rename' | 'skip';
  borderPadding: number;
}

export interface ExportProgress {
  jobId: string;
  taskKind?: 'export' | 'contact-sheet';
  done: number;
  total: number;
  currentName?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  errors: Array<{ frameId: string; name: string; message: string }>;
  /** BUG-002：重名策略为「跳过」时被跳过的张数，用于完成提示展示。 */
  skipped?: number;
  outputDirectory?: string;
}

export interface ImportResult {
  cancelled: boolean;
  rollId?: string;
  imported: number;
  errors: Array<{ path: string; message: string }>;
  rawImports?: RawImportJob[];
  importedAssets?: ImportRecognition[];
  pendingDuplicates?: { id: string; items: ImportDuplicate[] };
}

export interface ImportDuplicate {
  sourcePath: string;
  name: string;
  existingPath: string;
  existingName: string;
}

export interface ImportRecognition {
  id: string;
  name: string;
  kind: AssetKind;
  confidence: number;
  reason: string;
}

export interface RawImportJob {
  sourcePath: string;
  /** Short-lived app-local URL streamed directly from disk; never exposes arbitrary files. */
  readUrl: string;
  name: string;
  fileSize: number;
}

export interface RawDecodedImage {
  width: number;
  height: number;
  channels: 3 | 4;
  bits: 8 | 16;
  data: Uint8Array | Uint16Array;
  /** Transfer function of decoder output; all new RAW imports are linear. */
  transfer: InputTransfer;
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  iso?: number;
  shutter?: string;
  aperture?: string;
  focalLength?: string;
  shotAt?: string;
}

export interface ContactSheetConfig {
  style: 'classic' | 'darkroom' | 'minimal';
  resolution: 'preview' | 'standard' | 'best';
  columns: 3 | 4 | 5 | 6;
  showFileName: boolean;
  showMetadata: boolean;
  title: string;
  format: 'jpeg' | 'png';
}

export interface FilmEdgeRecognitionResult {
  text: string;
  confidence: number;
  detected: Partial<Pick<RollInput, 'filmType' | 'filmStock' | 'iso'>>;
  roll: RollSummary;
  /** AUTO-06：识别失败时的中文原因（成功时为空字符串）。 */
  error?: string;
}

export interface FilmTypeDetectionResult {
  filmType: FilmType;
  confidence: number;
  reason: string;
  roll: RollSummary;
  /** AUTO-06：识别失败时的中文原因（成功时为空字符串）。 */
  error?: string;
}

export interface HdrMergeResult {
  asset?: AssetSummary;
  message?: string;
}

export interface RecoveryIssueSummary {
  count: number;
  issues: Array<{ frameId: string; error: string; createdAt: number }>;
}

export interface AppInfo {
  version: string;
  packaged: boolean;
}

export interface FilmLabApi {
  /** REL-04：版本号唯一来源 app.getVersion()。 */
  getAppInfo(): Promise<AppInfo>;
  /** DATA-01：损坏配方自动回退的记录（用户可见的容错证据）。 */
  getRecoveryIssues(): Promise<RecoveryIssueSummary>;
  listRolls(): Promise<RollSummary[]>;
  createRoll(input: RollInput): Promise<RollSummary>;
  updateRoll(rollId: string, input: RollInput): Promise<RollSummary>;
  deleteRoll(rollId: string): Promise<{ cancelled: boolean; deleted: boolean }>;
  recognizeFilmEdge(rollId: string, assetId?: string, apply?: boolean): Promise<FilmEdgeRecognitionResult>;
  detectFilmType(rollId: string, assetId?: string, apply?: boolean): Promise<FilmTypeDetectionResult>;
  saveRollCalibration(rollId: string, calibration: RollCalibration): Promise<{ updatedFrames: number; updatedFrameIds: string[]; roll: RollSummary }>;
  listAssets(rollId: string): Promise<AssetSummary[]>;
  importAssets(rollId: string): Promise<ImportResult>;
  retryRawImports(rollId: string, sourcePaths: string[]): Promise<RawImportJob[]>;
  prepareRawCommit(rollId: string, sourcePath: string, metadata: Omit<RawDecodedImage, 'data'>): Promise<string>;
  resolveDuplicateImport(id: string, policy: 'skip' | 'reference'): Promise<ImportResult>;
  updateAssetKind(assetId: string, kind: AssetKind): Promise<{ asset: AssetSummary; frames: FrameSummary[] }>;
  deleteAssets(assetIds: string[]): Promise<{ cancelled: boolean; deleted: number }>;
  mergeHdrAssets(rollId: string, assetIds: string[]): Promise<HdrMergeResult>;
  setAssetFrames(assetId: string, regions: FrameRegionInput[]): Promise<{ frames: FrameSummary[] }>;
  listFrames(rollId?: string): Promise<FrameSummary[]>;
  deleteFrames(frameIds: string[]): Promise<{ cancelled: boolean; deleted: number }>;
  saveRecipe(frameId: string, recipe: EditRecipe): Promise<{ savedAt: number }>;
  renderProofPreview(frameId: string, recipe: EditRecipe): Promise<{ url: string; width: number; height: number }>;
  copyRecipeToRoll(frameId: string): Promise<{ updated: number }>;
  relocateFrame(frameId: string): Promise<{ cancelled: boolean; frame?: FrameSummary }>;
  chooseExportDirectory(): Promise<string | null>;
  authorizeExportDirectory(directory: string): Promise<boolean>;
  startExport(frameIds: string[], config: ExportConfig): Promise<{ jobId: string }>;
  cancelExport(jobId: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  createContactSheet(rollIds: string[], directory: string, config: ContactSheetConfig): Promise<{ jobId: string; total: number }>;
  listLuts(): Promise<Array<{ id: string; title: string; type: '1d' | '3d'; size: number }>>;
  importLuts(): Promise<{ imported: Array<{ id: string; title: string }> }>;
  loadLut(id: string): Promise<{ id: string; type: '1d' | '3d'; size: number; data: number[]; title?: string; domainMin: RGB; domainMax: RGB }>;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void;
  listPresets(): Promise<RecipePreset[]>;
  savePreset(name: string, grade: EditRecipe['grade']): Promise<RecipePreset>;
  deletePreset(id: string): Promise<void>;
  pasteRecipeToFrames(frameIds: string[], source: EditRecipe, scope: PasteScope): Promise<{ updated: number }>;
  setFrameMeta(frameId: string, meta: { starred?: boolean; tags?: string[] }): Promise<FrameSummary>;
  setRollMeta(rollId: string, meta: { starred?: boolean; tags?: string[] }): Promise<RollSummary>;
  createBackup(settingsJson?: string): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;
  restoreBackup(path: string): Promise<{ ok: boolean; message?: string; settingsJson?: string }>;
  relocateMissingSources(): Promise<SourceRelocationResult & { cancelled: boolean }>;
  cleanRebuildableCache(): Promise<CacheMaintenanceResult>;
  detectSprockets(assetId: string): Promise<{ top: SprocketInfo[]; bottom: SprocketInfo[] }>;
  /** REL-03：打开新版本下载页（仅 https，主进程校验）。 */
  openReleaseUrl(url: string): Promise<void>;
  /** REL-03：订阅启动更新检查结果；返回取消订阅函数。 */
  onUpdateAvailable(callback: (update: { version: string; url?: string; notes?: string }) => void): () => void;
  platform: NodeJS.Platform;
  /** Development-only pixel parity instrumentation; always false in packaged builds. */
  qaGpuValidation: boolean;
  /** Development-only interactive proxy tier override for fps benchmarks. */
  qaInteractiveEdge?: number;
}
