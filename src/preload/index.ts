import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo, AssetKind, AssetSummary, BackupInfo, ContactSheetConfig, EditRecipe, ExportConfig, ExportProgress,
  CacheMaintenanceResult, FilmEdgeRecognitionResult, FilmLabApi, FilmTypeDetectionResult, FrameRegionInput, FrameSummary, HdrMergeResult, ImportResult, PasteScope, RawDecodedImage, RecipePreset, RecoveryIssueSummary, RollInput, RollSummary, SourceRelocationResult, SprocketInfo,
} from '../shared/types';

// A renderer can race two `prepareRawCommit` calls (e.g. when a user retries
// one RAW while another is still completing). A single-slot token drops
// the earlier one; per-call entries below let each commit finish its own
// handshake before expiring.
const pendingRawCommitTokens = new Map<string, { token: string; sourcePath: string; expiresAt: number }>();

// The renderer first arms one short-lived commit through contextBridge. A
// renderer-created port loses message payloads if it is transferred straight
// through two Electron isolation boundaries, so preload bridges two native
// channels. The renderer transfers ownership once; preload then uses a
// back-pressured 4 MiB stream because current MessagePortMain cannot receive a
// transferred ArrayBuffer on the second isolation boundary.
window.addEventListener('message', (event) => {
  // Sandboxed Electron isolates the preload and renderer worlds, so source
  // identity is not stable across that boundary. The BrowserWindow has no
  // child frames; for HTTP development builds require the exact page origin.
  if (window.top !== window
    || (window.location.protocol !== 'file:' && event.origin !== window.location.origin)) return;
  if (event.ports.length !== 1) return;
  // The renderer must pass the token that matches this commit; pairing
  // arbitrary "the most recent" tokens to ports was a race that swapped
  // concurrent preps.
  const payload = event.data as { type?: unknown; token?: unknown; sourcePath?: unknown } | undefined;
  if (payload?.type !== 'chromik:raw-commit-port' || typeof payload.token !== 'string' || typeof payload.sourcePath !== 'string') return;
  const token = payload.token;
  const sourcePath = payload.sourcePath;
  const now = Date.now();
  let entry = pendingRawCommitTokens.get(token);
  if (!entry) {
    // Token not in the map: it may have been consumed by an earlier port
    // message or never created. BUG-008：回退匹配必须限定同一 sourcePath，
    // 否则并发导入时 A 的像素通道会被配到 B 的 sourcePath/metadata。
    for (const candidate of pendingRawCommitTokens.values()) {
      if (candidate.expiresAt >= now && candidate.sourcePath === sourcePath) { entry = candidate; break; }
    }
    if (!entry) return;
  }
  if (entry.expiresAt < now) {
    pendingRawCommitTokens.delete(entry.token);
    return;
  }
  pendingRawCommitTokens.delete(entry.token);
  const rendererPort = event.ports[0];
  const mainChannel = new MessageChannel();
  const preloadPort = mainChannel.port1;
  const chunkSize = 4 * 1024 * 1024;
  let pendingPixels: ArrayBuffer | undefined;
  let chunkOffset = 0;
  const close = () => {
    pendingPixels = undefined;
    rendererPort.close();
    preloadPort.close();
  };
  const sendNextChunk = () => {
    if (!pendingPixels) return;
    if (chunkOffset >= pendingPixels.byteLength) {
      pendingPixels = undefined;
      preloadPort.postMessage({ type: 'end' });
      return;
    }
    const length = Math.min(chunkSize, pendingPixels.byteLength - chunkOffset);
    // Give the structured-clone leg its own small backing store. Sending a
    // view of pendingPixels could clone the complete ~200 MB parent buffer.
    const chunk = new Uint8Array(length);
    chunk.set(new Uint8Array(pendingPixels, chunkOffset, length));
    preloadPort.postMessage({ type: 'chunk', offset: chunkOffset, data: chunk.buffer });
    chunkOffset += length;
  };
  rendererPort.onmessage = (rendererEvent) => {
    const payload = rendererEvent.data;
    if (payload instanceof ArrayBuffer) {
      if (pendingPixels) return;
      pendingPixels = payload;
      chunkOffset = 0;
      preloadPort.postMessage({ type: 'begin', byteLength: payload.byteLength });
    } else {
      preloadPort.postMessage(payload);
    }
  };
  rendererPort.onmessageerror = close;
  preloadPort.onmessage = (mainEvent) => {
    if (mainEvent.data?.type === 'chunk-ready') {
      sendNextChunk();
      return;
    }
    rendererPort.postMessage(mainEvent.data);
    if (mainEvent.data?.type === 'result') close();
  };
  preloadPort.onmessageerror = close;
  rendererPort.start();
  preloadPort.start();
  ipcRenderer.postMessage('asset:commit-raw-port', entry.token, [mainChannel.port2]);
});

const api: FilmLabApi = {
  getAppInfo: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  getRecoveryIssues: () => ipcRenderer.invoke('data:recovery-issues') as Promise<RecoveryIssueSummary>,
  listRolls: () => ipcRenderer.invoke('roll:list') as Promise<RollSummary[]>,
  createRoll: (input: RollInput) => ipcRenderer.invoke('roll:create', input) as Promise<RollSummary>,
  updateRoll: (rollId: string, input: RollInput) => ipcRenderer.invoke('roll:update', { rollId, data: input }) as Promise<RollSummary>,
  deleteRoll: (rollId: string) => ipcRenderer.invoke('roll:delete', { rollId }),
  recognizeFilmEdge: (rollId: string, assetId?: string, apply = true) => ipcRenderer.invoke('roll:recognize-edge', { rollId, assetId, apply }) as Promise<FilmEdgeRecognitionResult>,
  detectFilmType: (rollId: string, assetId?: string, apply = true) => ipcRenderer.invoke('roll:detect-film-type', { rollId, assetId, apply }) as Promise<FilmTypeDetectionResult>,
  saveRollCalibration: (rollId, calibration) => ipcRenderer.invoke('roll:save-calibration', { rollId, calibration }),
  listAssets: (rollId: string) => ipcRenderer.invoke('asset:list', { rollId }) as Promise<AssetSummary[]>,
  importAssets: (rollId: string) => ipcRenderer.invoke('asset:import-dialog', { rollId }) as Promise<ImportResult>,
  retryRawImports: (rollId: string, sourcePaths: string[]) => ipcRenderer.invoke('asset:retry-raw', { rollId, sourcePaths }),
  prepareRawCommit: async (rollId: string, sourcePath: string, metadata: Omit<RawDecodedImage, 'data'>) => {
    const token = await ipcRenderer.invoke('asset:prepare-raw-commit', { rollId, sourcePath, metadata }) as string;
    // Garbage-collect any pending token rows that the renderer never
    // handshaked through (e.g. window closed) so the map stays bounded.
    const now = Date.now();
    for (const [existingId, entry] of pendingRawCommitTokens) {
      if (entry.expiresAt < now) pendingRawCommitTokens.delete(existingId);
    }
    // BUG-008：条目记录 sourcePath，回退配对时只允许同一原片。
    pendingRawCommitTokens.set(token, { token, sourcePath, expiresAt: now + 15_000 });
    return token;
  },
  resolveDuplicateImport: (id: string, policy: 'skip' | 'reference') => ipcRenderer.invoke('asset:resolve-duplicates', { id, policy }) as Promise<ImportResult>,
  updateAssetKind: (assetId: string, kind: AssetKind) => ipcRenderer.invoke('asset:update-kind', { assetId, kind }),
  deleteAssets: (assetIds: string[]) => ipcRenderer.invoke('asset:delete', { assetIds }),
  mergeHdrAssets: (rollId: string, assetIds: string[]) => ipcRenderer.invoke('asset:merge-hdr', { rollId, assetIds }) as Promise<HdrMergeResult>,
  setAssetFrames: (assetId: string, regions: FrameRegionInput[]) => ipcRenderer.invoke('asset:set-frames', { assetId, regions }),
  listFrames: (rollId?: string) => ipcRenderer.invoke('frame:list', { rollId }) as Promise<FrameSummary[]>,
  deleteFrames: (frameIds: string[]) => ipcRenderer.invoke('frame:delete', { frameIds }),
  saveRecipe: (frameId: string, recipe: EditRecipe) => ipcRenderer.invoke('frame:save-recipe', { frameId, recipe }),
  renderProofPreview: (frameId: string, recipe: EditRecipe) => ipcRenderer.invoke('frame:render-proof', { frameId, recipe }) as Promise<{ url: string; width: number; height: number }>,
  copyRecipeToRoll: (frameId: string) => ipcRenderer.invoke('frame:copy-recipe', { frameId }),
  relocateFrame: (frameId: string) => ipcRenderer.invoke('frame:relocate', { frameId }),
  chooseExportDirectory: () => ipcRenderer.invoke('export:choose-directory') as Promise<string | null>,
  authorizeExportDirectory: (directory: string) => ipcRenderer.invoke('export:authorize-directory', { directory }) as Promise<boolean>,
  startExport: (frameIds: string[], config: ExportConfig) => ipcRenderer.invoke('export:start', { frameIds, config }),
  cancelExport: (jobId: string) => ipcRenderer.invoke('export:cancel', { jobId }),
  showInFolder: (path: string) => ipcRenderer.invoke('shell:show-in-folder', { path }),
  createContactSheet: (rollIds: string[], directory: string, config: ContactSheetConfig) => ipcRenderer.invoke('export:contact-sheet', { rollIds, directory, config }),
  listLuts: () => ipcRenderer.invoke('lut:list'),
  importLuts: () => ipcRenderer.invoke('lut:import'),
  loadLut: (id: string) => ipcRenderer.invoke('lut:load', { id }),
  onExportProgress: (callback: (progress: ExportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExportProgress) => callback(progress);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  listPresets: () => ipcRenderer.invoke('preset:list') as Promise<RecipePreset[]>,
  savePreset: (name: string, grade: EditRecipe['grade']) => ipcRenderer.invoke('preset:save', { name, grade }) as Promise<RecipePreset>,
  deletePreset: (id: string) => ipcRenderer.invoke('preset:delete', { id }),
  pasteRecipeToFrames: (frameIds: string[], source: EditRecipe, scope: PasteScope) => ipcRenderer.invoke('frame:paste-recipe', { frameIds, source, scope }) as Promise<{ updated: number }>,
  setFrameMeta: (frameId: string, meta: { starred?: boolean; tags?: string[] }) => ipcRenderer.invoke('frame:set-meta', { frameId, meta }) as Promise<FrameSummary>,
  setRollMeta: (rollId: string, meta: { starred?: boolean; tags?: string[] }) => ipcRenderer.invoke('roll:set-meta', { rollId, meta }) as Promise<RollSummary>,
  createBackup: (settingsJson?: string) => ipcRenderer.invoke('backup:create', { settingsJson }) as Promise<BackupInfo>,
  listBackups: () => ipcRenderer.invoke('backup:list') as Promise<BackupInfo[]>,
  restoreBackup: (path: string) => ipcRenderer.invoke('backup:restore', { path }) as Promise<{ ok: boolean; message?: string; settingsJson?: string }>,
  relocateMissingSources: () => ipcRenderer.invoke('source:relocate-missing') as Promise<SourceRelocationResult & { cancelled: boolean }>,
  cleanRebuildableCache: () => ipcRenderer.invoke('cache:clean-rebuildable') as Promise<CacheMaintenanceResult>,
  detectSprockets: (assetId: string) => ipcRenderer.invoke('asset:sprockets', { assetId }) as Promise<{ top: SprocketInfo[]; bottom: SprocketInfo[] }>,
  openReleaseUrl: (url: string) => ipcRenderer.invoke('app:open-release-url', { url }) as Promise<void>,
  onUpdateAvailable: (callback: (update: { version: string; url?: string; notes?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: { version: string; url?: string; notes?: string }) => callback(update);
    ipcRenderer.on('app:update-available', listener);
    return () => ipcRenderer.removeListener('app:update-available', listener);
  },
  platform: process.platform,
  qaGpuValidation: process.env.FILMLAB_QA_GPU_VALIDATE === '1',
  qaInteractiveEdge: process.env.FILMLAB_QA_INTERACTIVE_EDGE ? Number(process.env.FILMLAB_QA_INTERACTIVE_EDGE) : undefined,
};

contextBridge.exposeInMainWorld('filmLab', api);
