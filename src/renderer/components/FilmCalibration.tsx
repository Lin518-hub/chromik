import { useEffect, useMemo, useRef, useState } from 'react';
import { Aperture, Check, Film, LoaderCircle, LocateFixed, Maximize, RotateCcw, ScanSearch, X } from 'lucide-react';
import { CAPTURE_PROFILES, getCaptureProfile } from '../../shared/capture-profiles';
import type { FilmBaseSample } from '../../core/density';
import { createRecipeForFilmType } from '../../shared/defaults';
import { filmResponseProfileForType, getFilmResponseProfile } from '../../shared/film-response-profiles';
import { FILM_STOCK_PROFILES, getFilmStockProfile, suggestFilmStockProfile } from '../../shared/film-stock-profiles';
import type { AssetSummary, CaptureProfileId, CropRect, EditRecipe, FrameSummary, Matrix9, RGB, RollCalibration, RollSummary } from '../../shared/types';
import { DevelopCanvas, type DevelopCanvasHandle } from './DevelopCanvas';
import { InfoTip } from './InfoTip';
import { RangeControl } from './RangeControl';
import { EditorShell } from './EditorShell';
import { CustomSelect } from './CustomSelect';
import type { EditorContext, EditorToolId } from '../navigation';

interface FilmCalibrationProps {
  roll: RollSummary;
  assets: AssetSummary[];
  systemGestures: boolean;
  onSave: (calibration: RollCalibration) => Promise<void>;
  onContinue: (asset: AssetSummary) => void;
  onEditRoll: () => void;
  editorContext: EditorContext;
  onToolChange: (tool: EditorToolId) => void;
  /** 反馈①：导入后进入校准时，优先展示刚导入的素材。 */
  preferredAssetId?: string;
}

const CHANNELS = ['红', '绿', '蓝'] as const;
const PROFILE_IDS: CaptureProfileId[] = ['camera_srgb', 'scanner_srgb', 'linear_raw'];

/** COL-07：把片基/密度锚点的异常状态翻译成中文提示。 */
const STATUS_HINTS: Record<string, string> = {
  fallback: '片基样本不足，回退到基础估算',
  low_samples: '片基候选样本太少',
  border_dominated: '边缘色相不集中，可能混入了灯箱或边框',
  low_usable: '有效画面像素占比过低',
  heavily_clipped: '高光裁切严重',
  low_neutral: '中性参考像素不足',
};

function recipeFromRoll(roll: RollSummary): EditRecipe {
  const recipe = createRecipeForFilmType(roll.filmType);
  recipe.baseRgb = roll.calibration.baseRgb;
  recipe.baseRgbLinear = roll.calibration.baseRgbLinear;
  const suggested = roll.calibration.density.filmStockProfileId ?? suggestFilmStockProfile(roll.filmStock)?.id;
  const stock = suggested ? getFilmStockProfile(suggested) : undefined;
  const seeded = roll.calibration.density.enabled ? {} : stock ? {
    separation: stock.separation,
    separationMatrix: stock.separationMatrix,
    crossoverStrength: stock.crossoverStrength,
    neutralProtection: stock.neutralProtection,
  } : {};
  recipe.density = {
    ...roll.calibration.density,
    ...seeded,
    filmProfileId: filmResponseProfileForType(roll.filmType),
    filmStockProfileId: suggested,
    enabled: (roll.filmType === 'color_negative' || roll.filmType === 'bw_negative') && roll.calibration.density.enabled,
  };
  return recipe;
}

export function FilmCalibration({ roll, assets, systemGestures, onSave, onContinue, onEditRoll, editorContext, onToolChange, preferredAssetId }: FilmCalibrationProps) {
  const developRef = useRef<DevelopCanvasHandle>(null);
  const [assetId, setAssetId] = useState(
    preferredAssetId && assets.some((asset) => asset.id === preferredAssetId) ? preferredAssetId : assets[0]?.id,
  );
  const [recipe, setRecipe] = useState(() => recipeFromRoll(roll));
  const [sampling, setSampling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [ready, setReady] = useState(false);
  const [histogram, setHistogram] = useState<[number[], number[], number[]] | null>(null);
  const [baseSource, setBaseSource] = useState<'automatic' | 'manual'>('automatic');
  const [analysisConfidence, setAnalysisConfidence] = useState<number>();
  const [sampleTarget, setSampleTarget] = useState<'base' | 'light'>('base');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisIssue, setAnalysisIssue] = useState<string>();
  const [analysisRegion, setAnalysisRegion] = useState<CropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const [analysisRegionEditing, setAnalysisRegionEditing] = useState(false);
  const [analysisRegionReady, setAnalysisRegionReady] = useState(false);
  const [analysisRegionBusy, setAnalysisRegionBusy] = useState(false);
  const [analysisRegionConfidence, setAnalysisRegionConfidence] = useState<number>();
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  /** 反馈②：进入校准界面不自动跑分析，而是高亮「自动采样并转换」按钮（每次进入只高亮一次）。 */
  const [autoHighlight, setAutoHighlight] = useState(false);
  const autoHighlightOfferedRef = useRef(false);
  const lastSavedRef = useRef('');
  const onSaveRef = useRef(onSave);
  const autoRegionAssetRef = useRef<string | undefined>(undefined);
  const autoSaveTimerRef = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef<{ calibration: RollCalibration; fingerprint: string; save: (calibration: RollCalibration) => Promise<void> } | undefined>(undefined);
  const mountedRef = useRef(true);
  /** BUG-013：分析代次。取消/卸载/新分析都会递增，旧结果落地前被丢弃。 */
  const analysisEpochRef = useRef(0);
  // A newly analysed negative follows the current baseline rendering intent,
  // but an explicit user choice in this visit must never be overwritten.
  const densityModeTouchedRef = useRef(false);

  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  async function flushPendingCalibration(updateStatus = true) {
    if (autoSaveTimerRef.current !== undefined) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = undefined;
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = undefined;
    try {
      await pending.save(pending.calibration);
      lastSavedRef.current = pending.fingerprint;
      if (mountedRef.current && updateStatus) {
        setAutoSaveStatus('saved');
        window.setTimeout(() => mountedRef.current && setAutoSaveStatus('idle'), 1800);
      }
    } catch {
      if (mountedRef.current && updateStatus) setAutoSaveStatus('error');
    }
  }

  useEffect(() => () => {
    mountedRef.current = false;
    analysisEpochRef.current += 1;
    // Best-effort save on unmount so a navigation away from the calibration
    // page does not drop the most recent edit; the next remount reseeds
    // lastSavedRef so debouncing still works.
    void flushPendingCalibration(false).catch((error) => {
      console.warn('Chromik: calibration 卸载保存失败', error);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void flushPendingCalibration(false);
    setRecipe(recipeFromRoll(roll));
    setSampling(false);
    setBaseSource('automatic');
    setAnalysisConfidence(undefined);
    setAnalysisIssue(undefined);
    densityModeTouchedRef.current = false;
    // 反馈②：每次进入（切换胶卷）重置一次性高亮。
    autoHighlightOfferedRef.current = false;
    setAutoHighlight(false);
    autoRegionAssetRef.current = undefined;
    setAnalysisRegion({ x: 0, y: 0, width: 1, height: 1 });
    setAnalysisRegionEditing(false);
    setAnalysisRegionReady(false);
    setAnalysisRegionConfidence(undefined);
    const seeded = recipeFromRoll(roll);
    lastSavedRef.current = JSON.stringify({ baseRgb: seeded.baseRgb, baseRgbLinear: seeded.baseRgbLinear, density: seeded.density });
  }, [roll.id, roll.filmType]);

  useEffect(() => {
    if (!assets.some((asset) => asset.id === assetId)) setAssetId(assets[0]?.id);
  }, [assetId, assets]);

  const asset = assets.find((item) => item.id === assetId) ?? assets[0];
  const frame = useMemo<FrameSummary | undefined>(() => asset ? ({
    id: `calibration-${asset.id}`,
    rollId: roll.id,
    assetId: asset.id,
    frameNumber: 0,
    name: asset.name,
    sourcePath: asset.sourcePath,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    fileSize: asset.fileSize,
    status: asset.status,
    previewUrl: asset.analysisPreviewUrl,
    sourcePreviewUrl: asset.analysisPreviewUrl,
    developPreviewUrl: asset.developPreviewUrl,
    processedPreviewUrl: asset.previewUrl,
    recipe,
    createdAt: asset.createdAt,
  }) : undefined, [asset, recipe, roll.id]);
  const negative = roll.filmType === 'color_negative' || roll.filmType === 'bw_negative';
  const unknown = roll.filmType === 'unknown';

  useEffect(() => {
    const calibration = { baseRgb: recipe.baseRgb, baseRgbLinear: recipe.baseRgbLinear, density: { ...recipe.density, enabled: negative && recipe.density.enabled } };
    const fingerprint = JSON.stringify(calibration);
    if (!lastSavedRef.current) lastSavedRef.current = fingerprint;
    if (fingerprint === lastSavedRef.current) return;
    setAutoSaveStatus('saving');
    // Never overwrite a pending save that has not yet been flushed — doing so
    // would drop the older incremental edit on the floor because the new
    // object supersedes the queued call without ever running its save.
    const existing = pendingSaveRef.current;
    if (existing && existing.fingerprint !== fingerprint) {
      void flushPendingCalibration(false);
    }
    pendingSaveRef.current = {
      calibration: { ...calibration, updatedAt: Date.now() },
      fingerprint,
      save: onSaveRef.current,
    };
    if (autoSaveTimerRef.current !== undefined) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => void flushPendingCalibration(), 520);
  }, [recipe, negative, roll.id]);

  useEffect(() => {
    // 反馈②：不自动执行分析，改为一次性高亮提示用户点击。
    if (autoHighlightOfferedRef.current) return;
    if (ready && analysisRegionReady && negative && !unknown && !recipe.density.enabled) {
      autoHighlightOfferedRef.current = true;
      setAutoHighlight(true);
    }
  }, [ready, analysisRegionReady, negative, unknown, recipe.density.enabled]);

  useEffect(() => {
    if (!ready || !asset || autoRegionAssetRef.current === asset.id) return;
    autoRegionAssetRef.current = asset.id;
    void autoSelectFilmRegion();
  }, [ready, asset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function analyze(reestimateBase = baseSource !== 'manual', baseSample?: FilmBaseSample) {
    if (!mountedRef.current) return;
    const epoch = ++analysisEpochRef.current;
    setAutoHighlight(false);
    setAnalyzing(true);
    setAnalysisIssue(undefined);
    // UI-01：分析是 worker 内单次无阶段回调节点，不伪造精确百分比；
    // 显示不确定忙碌 + 已运行秒数，超 1s 后文案提示大图需要更久。
    setAnalysisProgress(0);
    const startedAt = Date.now();
    const progressTimer = window.setInterval(() => setAnalysisProgress(Math.round((Date.now() - startedAt) / 1000)), 1000);
    try {
      const result = await developRef.current?.autoInvert({ reestimateBase, baseRgb: baseSample?.rgb, baseRgbLinear: baseSample?.linearRgb, analysisRegion });
      // BUG-013：取消/卸载/新分析后，旧结果一律丢弃，避免取消无效或错值写回。
      if (epoch !== analysisEpochRef.current || !mountedRef.current) return;
      if (!result) return;
      const confidence = Math.min(result.confidence, result.baseConfidence);
      setAnalysisConfidence(confidence);
      const statusHint = [result.baseStatus, result.anchorStatus]
        .filter((status) => status && status !== 'ok')
        .map((status) => STATUS_HINTS[status] ?? status)
        .join('；');
      if (confidence < 0.55) {
        setAnalysisIssue(`没有可靠识别到片基范围${statusHint ? `（${statusHint}）` : ''}，已保留原来的校准参数。可更换一张片基边缘更完整的原始素材后重试。`);
        return;
      }
      if (statusHint) setAnalysisIssue(`本次结果可用，但建议检查：${statusHint}。`);
      setRecipe((current) => ({
        ...current,
        baseRgb: result.baseRgb,
        baseRgbLinear: result.baseRgbLinear,
        density: {
          ...current.density,
          enabled: true,
          mode: negative && !densityModeTouchedRef.current
            ? createRecipeForFilmType(roll.filmType).density.mode
            : current.density.mode,
          low: result.low,
          high: result.high,
          shadowCorrection: result.shadowCorrection,
          midCorrection: result.midCorrection,
          highlightCorrection: result.highlightCorrection,
        },
      }));
      setBaseSource(reestimateBase ? 'automatic' : 'manual');
    } finally {
      window.clearInterval(progressTimer);
      setAnalysisProgress(0);
      setAnalyzing(false);
    }
  }

  async function autoSelectFilmRegion() {
    const epoch = ++analysisEpochRef.current;
    setAnalysisRegionBusy(true);
    setAnalysisRegionEditing(false);
    try {
      const result = await developRef.current?.autoFilmRegion();
      // BUG-013：与 analyze 相同的代次守卫。
      if (epoch !== analysisEpochRef.current || !mountedRef.current) return;
      if (!result) {
        setAnalysisRegionReady(true);
        setAnalysisIssue('自动识别胶片区域未完成，可手动框选胶片后再分析。');
        return;
      }
      setAnalysisRegion(result.crop);
      setAnalysisRegionConfidence(result.confidence);
      setAnalysisRegionReady(true);
      setAnalysisIssue(result.confidence < .5 ? '胶片区域识别可信度较低，请检查虚线框；必要时使用“手动框选”。' : undefined);
    } finally {
      setAnalysisRegionBusy(false);
    }
  }

  function cancelAnalysisTask(message = '已取消本次分析，现有校准参数保持不变。') {
    // BUG-013：递增代次，让任何在途分析的结果在落地前被丢弃。
    analysisEpochRef.current += 1;
    developRef.current?.cancelAnalysis();
    setAnalyzing(false);
    setAnalysisRegionBusy(false);
    setAnalysisProgress(0);
    setAnalysisIssue(message);
  }

  function sample(baseSample: FilmBaseSample) {
    setRecipe((current) => ({ ...current, baseRgb: baseSample.rgb, baseRgbLinear: baseSample.linearRgb }));
    setBaseSource('manual');
    setAnalysisConfidence(undefined);
    setSampling(false);
    // Pass this exact click directly to the worker. Waiting for React state to
    // commit first introduced a race where analysis still saw the old base and
    // the user's click appeared to have no effect.
    void analyze(false, baseSample);
  }

  function handleSample(baseSample: FilmBaseSample) {
    if (sampleTarget === 'light') {
      setRecipe((current) => ({ ...current, density: { ...current.density, lightSourceRgb: baseSample.rgb } }));
      setSampling(false);
      return;
    }
    sample(baseSample);
  }

  function startBaseSampling() {
    setSampleTarget('base');
    setSampling(true);
  }

  function startLightSampling() {
    setSampleTarget('light');
    setSampling(true);
  }

  function resetCalibrationColor() {
    const defaults = createRecipeForFilmType(roll.filmType);
    densityModeTouchedRef.current = false;
    setRecipe((current) => ({ ...current, baseRgb: undefined, baseRgbLinear: undefined, density: { ...defaults.density } }));
    setBaseSource('automatic');
    setAnalysisConfidence(undefined);
    setSampling(false);
  }

  function selectProfile(profileId: CaptureProfileId) {
    const profile = getCaptureProfile(profileId);
    setRecipe((current) => ({
      ...current,
      density: { ...current.density, profileId, inputTransfer: profile.inputTransfer },
    }));
    setBaseSource('automatic');
    setAnalysisConfidence(undefined);
  }

  function selectStockProfile(profileId: string) {
    const stock = getFilmStockProfile(profileId);
    setRecipe((current) => ({
      ...current,
      density: {
        ...current.density,
        filmStockProfileId: stock?.id,
        // COL-11：配方记住所选配置版本，将来升级配置时能按版本解释旧外观。
        filmStockProfileVersion: stock?.version,
        separation: stock?.separation ?? current.density.separation,
        separationMatrix: stock?.separationMatrix,
        crossoverStrength: stock?.crossoverStrength ?? current.density.crossoverStrength,
        neutralProtection: stock?.neutralProtection ?? current.density.neutralProtection,
      },
    }));
    setBaseSource('automatic');
    setAnalysisConfidence(undefined);
    // A stock change also changes the density-range percentiles, which only
    // take effect during analysis. Re-run it after React commits the new
    // recipe so the preview reflects the selected stock immediately.
    if (negative) window.setTimeout(() => void analyze(), 0);
  }

  function changeMatrixCell(index: number, value: number) {
    if (!Number.isFinite(value)) return;
    setRecipe((current) => {
      const matrix: Matrix9 = current.density.separationMatrix
        ? [...current.density.separationMatrix] as Matrix9
        : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      matrix[index] = value;
      return { ...current, density: { ...current.density, separationMatrix: matrix, enabled: true } };
    });
  }

  function selectAsset(nextAssetId: string) {
    setAssetId(nextAssetId);
    setBaseSource('automatic');
    setAnalysisConfidence(undefined);
    setAnalysisRegion({ x: 0, y: 0, width: 1, height: 1 });
    setAnalysisRegionReady(false);
    setAnalysisRegionConfidence(undefined);
    setAnalysisRegionEditing(false);
    autoRegionAssetRef.current = undefined;
  }

  function changeDensity(kind: 'low' | 'high', channel: number, value: number) {
    setRecipe((current) => {
      const values = [...current.density[kind]] as RGB;
      values[channel] = value;
      return { ...current, density: { ...current.density, [kind]: values, enabled: true } };
    });
  }

  async function continueToFraming() {
    if (!asset) return;
    await flushPendingCalibration();
    onContinue(asset);
  }

  return (
    <EditorShell
      activeTool="calibrate"
      context={editorContext}
      inspectorTitle="胶片校准"
      scopeLabel="整卷"
      onToolChange={onToolChange}
      inspector={<div className="calibration-inspector">
            <div className="calibration-section">
              <div className="calibration-step"><span>1</span><div><b>确认胶片类型</b><small>决定是否反相、是否去除彩色负片橙色罩</small></div></div>
              <div className="film-type-result"><Film size={18} /><div><b>{roll.filmType === 'color_negative' ? '彩色负片' : roll.filmType === 'color_slide' ? '彩色反转片' : roll.filmType === 'bw_negative' ? '黑白负片' : roll.filmType === 'bw_slide' ? '黑白反转片' : '未能可靠识别'}</b><span>{unknown ? '没有可靠结果，当前胶卷信息保持不变' : negative ? '已在导入时自动识别，需要胶片转换' : '已在导入时自动识别，正片无需反相'}</span></div></div>
              {unknown && <button className="button-secondary full" onClick={onEditRoll}>手动确认胶片类型</button>}
            </div>

            <div className="calibration-section">
              <div className="calibration-step"><span>2</span><div><b>限定胶片识别区域</b><small>框入照片与少量干净橙色片边，排除灯箱、手指和夹具</small></div><InfoTip text="最准的范围同时包含照片内容和一小段未曝光的橙色片基。不要只框照片，也不要框入大片白色灯箱。齿孔不是片基；落在框内时会被统计自动排除。虚线框只影响识别分析，不会裁切照片。" /></div>
              <p className="calibration-note">建议框住整段乳剂和少量干净片边；若自动框包含大片灯箱、手指或夹具，请手动收紧。能避开整排齿孔更稳，少量齿孔可自动忽略。</p>
              <div className="calibration-region-actions">
                <button className={`button-secondary ${analysisRegionBusy ? 'danger-outline' : ''}`} disabled={(!ready && !analysisRegionBusy) || analyzing} onClick={() => analysisRegionBusy ? cancelAnalysisTask('已取消自动选区，可手动框选胶片区域。') : void autoSelectFilmRegion()}>{analysisRegionBusy ? <X size={15} /> : <ScanSearch size={15} />}{analysisRegionBusy ? '取消选区' : '自动选择胶片'}</button>
                <button className={`button-secondary ${analysisRegionEditing ? 'is-active' : ''}`} disabled={!ready || analyzing} onClick={() => setAnalysisRegionEditing((current) => !current)}><LocateFixed size={15} />{analysisRegionEditing ? '完成框选' : '手动框选'}</button>
                <button className="icon-button" aria-label="使用完整素材" title="使用完整素材" disabled={analyzing} onClick={() => { setAnalysisRegion({ x: 0, y: 0, width: 1, height: 1 }); setAnalysisRegionReady(true); setAnalysisRegionConfidence(undefined); }}><Maximize size={15} /></button>
              </div>
              {analysisRegionConfidence !== undefined && <p className="calibration-region-result"><Check size={13} />识别区域可信度约 {Math.round(analysisRegionConfidence * 100)}%</p>}
            </div>

            <div className="calibration-section">
              <div className="calibration-step"><span>3</span><div><b>自动反相与去色罩</b><small>{negative ? '在虚线框内重新采样片基，并联合分析密度与交叉色偏' : '反转片会跳过此步骤'}</small></div><InfoTip text="Chromik 只使用上一步虚线框内的像素重新采样片基，再以联合亮度确定密度范围，并分别约束阴影与高光色偏。" /></div>
              {negative && <p className="calibration-note">Chromik 会自动寻找片基、计算密度范围并实时保存。识别可信度不足时不会覆盖现有结果。</p>}
              <button className={`${analyzing ? 'button-secondary danger-outline' : 'button-primary'} full ${autoHighlight ? 'calibration-highlight' : ''}`} disabled={(!ready && !analyzing) || !negative} onClick={() => analyzing ? cancelAnalysisTask() : void analyze()}>{analyzing ? <X size={16} /> : <Aperture size={16} />}{analyzing ? '取消本次分析' : baseSource === 'manual' ? '使用手动片基分析' : recipe.density.enabled ? '重新采样并分析' : '自动采样并转换'}</button>
              {negative && <button className={`button-secondary full ${sampling && sampleTarget === 'base' ? 'is-active' : ''}`} disabled={!ready || analyzing} onClick={() => sampling && sampleTarget === 'base' ? setSampling(false) : startBaseSampling()}><LocateFixed size={15} />{sampling && sampleTarget === 'base' ? '取消片基取样' : '手动点击片基边缘'}</button>}
              <div className="base-readout"><span>片基 RGB · {baseSource === 'manual' ? '手动' : '自动'}</span><i style={{ background: recipe.baseRgb ? `rgb(${recipe.baseRgb.join(',')})` : '#d8d3c7' }} /><b>{recipe.baseRgb?.map((value) => Math.round(value)).join(' / ') ?? '尚未分析'}</b></div>
              {analysisConfidence !== undefined && !analysisIssue && <p className="calibration-note">本次联合分析可信度约 {Math.round(analysisConfidence * 100)}%。</p>}
              {analysisIssue && <p className="calibration-note warning"><InfoTip text={analysisIssue} />{analysisIssue}</p>}
              <button className="button-secondary full" disabled={analyzing} onClick={resetCalibrationColor}><RotateCcw size={15} />重置去色罩与颜色</button>
            </div>

            <details className="calibration-expert">
              <summary><span>高级校准</span><small>输入设备、光源、密度范围与通道分离</small></summary>
              <div className="calibration-expert-body">
              <div className="calibration-section expert-light-source">
                <div className="calibration-step"><span>A</span><div><b>光源取样</b><small>用于灰卡、空片基或正片翻拍的光源偏色校正</small></div><InfoTip text="彩色负片通常已在片基除法中抵消光源偏色，普通用户无需单独取样。" /></div>
                <button className={`button-secondary full ${sampling && sampleTarget === 'light' ? 'is-active' : ''}`} disabled={!ready} onClick={() => (sampling ? setSampling(false) : startLightSampling())}><LocateFixed size={15} />{sampling && sampleTarget === 'light' ? '取消光源取样' : '取样光源（灰卡/空片基）'}</button>
                <div className="base-readout"><span>光源 RGB</span><i style={{ background: recipe.density.lightSourceRgb ? `rgb(${recipe.density.lightSourceRgb.join(',')})` : '#d8d3c7' }} /><b>{recipe.density.lightSourceRgb?.map((value) => Math.round(value)).join(' / ') ?? '未取样'}</b></div>
              </div>
            <div className={`calibration-section density-detail ${!negative ? 'disabled' : ''}`}>
              <div className="calibration-step"><span>4</span><div><b>精细转换</b><small>调整各通道密度黑点与白点</small></div><InfoTip text="通常自动结果即可。出现偏色或反差异常时，再分别微调红、绿、蓝通道的密度范围。" /></div>
              <div className="density-source-control">
                <label>输入设备配置 <InfoTip text="配置决定输入传递函数、片基亮度采样和自动校正上限。当前均为有版本号的通用配置，不冒充特定胶片或相机的实测 ICC/DCP。" /></label>
                <div className="segment-control three">{PROFILE_IDS.map((profileId) => <button key={profileId} title={CAPTURE_PROFILES[profileId].description} className={recipe.density.profileId === profileId ? 'active' : ''} onClick={() => selectProfile(profileId)}>{CAPTURE_PROFILES[profileId].shortLabel}</button>)}</div>
              </div>
              <p className="calibration-note">{getCaptureProfile(recipe.density.profileId).description} · 配置版本 {getCaptureProfile(recipe.density.profileId).version}</p>
              <div className="density-source-control">
                <label>胶卷型号预设 <InfoTip text="按胶卷型号带入一套通用密度范围、通道解耦、交叉色偏强度与特性曲线参数。全部为有版本号的通用近似（measured: false），不是实测感光数据；未录入的型号请选「通用」。" /></label>
                <CustomSelect className="stock-profile-select" label="胶卷型号预设" value={recipe.density.filmStockProfileId ?? ''} onChange={selectStockProfile} options={[{ value: '', label: '通用（按片种）' }, ...FILM_STOCK_PROFILES.map((stock) => ({ value: stock.id, label: stock.label }))]} />
              </div>
              <p className="calibration-note">{recipe.density.filmStockProfileId
                ? `${getFilmStockProfile(recipe.density.filmStockProfileId)?.label ?? '未知型号'} · ${getFilmStockProfile(recipe.density.filmStockProfileId)?.version} · 通用未实测`
                : `胶片响应：${getFilmResponseProfile(recipe.density.filmProfileId).label} · 通用未实测`}</p>
              <div className="density-source-control">
                <label>转换模式 <InfoTip text="柔和胶片层次：在密度归一化后使用 Chromik 自研的平滑趾部/肩部曲线，保留中间调和高光层次，是彩色与黑白负片的新默认。线性显示参考：不加这层通用曲线，便于测量或手动构建外观。两种模式都不改变片基和密度锚点。" /></label>
                <div className="segment-control two"><button className={recipe.density.mode === 'cineon' ? 'active' : ''} onClick={() => { densityModeTouchedRef.current = true; setRecipe((current) => ({ ...current, density: { ...current.density, mode: 'cineon' } })); }}>柔和胶片层次</button><button className={recipe.density.mode === 'display_reference' ? 'active' : ''} onClick={() => { densityModeTouchedRef.current = true; setRecipe((current) => ({ ...current, density: { ...current.density, mode: 'display_reference' } })); }}>线性显示参考</button></div>
              </div>
              <details className="advanced-details">
                <summary>高级参数（交叉色偏 / 通道解耦 / 逐通道微调）</summary>
                <RangeControl label="交叉色偏保护" value={recipe.density.neutralProtection} min={0} max={100} step={1} display={(value) => `${value.toFixed(0)}%`} onChange={(value) => setRecipe((current) => ({ ...current, density: { ...current.density, neutralProtection: value, enabled: true } }))} onReset={() => setRecipe((current) => ({ ...current, density: { ...current.density, neutralProtection: 55 } }))} />
                <RangeControl label="交叉色偏强度" value={recipe.density.crossoverStrength} min={0} max={2} step={0.05} display={(value) => `${value.toFixed(2)}×`} onChange={(value) => setRecipe((current) => ({ ...current, density: { ...current.density, crossoverStrength: value, enabled: true } }))} onReset={() => setRecipe((current) => ({ ...current, density: { ...current.density, crossoverStrength: 1 } }))} />
                <RangeControl label="通道解耦" value={recipe.density.separation} min={0} max={100} step={1} display={(value) => `${value.toFixed(0)}%`} onChange={(value) => setRecipe((current) => ({ ...current, density: { ...current.density, separation: value, enabled: true } }))} onReset={() => setRecipe((current) => ({ ...current, density: { ...current.density, separation: 0 } }))} />
                <details className="advanced-details">
                  <summary>通道解耦矩阵</summary>
                  <p>自定义 3×3 密度分离矩阵（行优先：R' = m00·R + m01·G + m02·B）。仅在「通道解耦」大于 0 时生效；每行系数之和应约为 1，否则会整体移动白点。未填写时使用内置通用矩阵。</p>
                  <div className="matrix-editor">
                    {(recipe.density.separationMatrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).map((value, index) => (
                      <input key={index} type="number" step="0.005" min={-2} max={2} value={value}
                        aria-label={`矩阵第 ${index + 1} 项`}
                        onChange={(event) => changeMatrixCell(index, Number(event.target.value))} />
                    ))}
                  </div>
                </details>
                <p className="calibration-note">自动校正会分别估算阴影、中间调与高光的残余色偏。未经实测的通道矩阵默认关闭；偏色时应先重新采样片基。</p>
                {CHANNELS.map((channel, index) => <div className="density-channel" key={channel}><b>{channel}</b><RangeControl label="黑点" value={recipe.density.low[index]} min={-0.2} max={1.2} step={0.01} display={(value) => value.toFixed(2)} onChange={(value) => changeDensity('low', index, value)} /><RangeControl label="白点" value={recipe.density.high[index]} min={0.2} max={3} step={0.01} display={(value) => value.toFixed(2)} onChange={(value) => changeDensity('high', index, value)} /></div>)}
              </details>
            </div>
              </div>
            </details>
            <div className="calibration-actions">
              <span className={`calibration-autosave ${autoSaveStatus}`}>{autoSaveStatus === 'saving' ? <><LoaderCircle className="spin" size={13} />正在实时保存</> : autoSaveStatus === 'error' ? '保存失败，请重试' : <><Check size={13} />{autoSaveStatus === 'saved' ? '校准已实时保存' : '修改会自动保存'}</>}</span>
              <button className="button-primary" disabled={!asset || unknown || negative && !recipe.density.enabled} onClick={() => void continueToFraming()}><Check size={15} />完成校准</button>
            </div>
          </div>}
      canvas={<div className="preview-shell glass-surface calibration-preview">
            {frame && <DevelopCanvas ref={developRef} frame={frame} recipe={recipe} compare={false} negativeWorkflow={negative} filmTypeUnknown={unknown} systemGestures={systemGestures} sampling={sampling} onSample={handleSample} onHistogram={setHistogram} onReadyChange={setReady} geometryEditing={false} onCornersChange={() => undefined} analysisRegion={analysisRegion} analysisRegionEditing={analysisRegionEditing} onAnalysisRegionChange={(region) => { setAnalysisRegion(region); setAnalysisRegionReady(true); setAnalysisRegionConfidence(undefined); }} samplingHint={sampleTarget === 'light' ? '点击灰卡或空片基区域取样光源 · 中键仍可移动' : '点击未曝光的片基边缘 · 取样后会自动重新计算'} />}
            {!ready && <div className="preview-loading"><LoaderCircle className="spin" />生成校准预览…</div>}
            {analyzing && <div className="calibration-processing" role="status" aria-live="polite"><div className="calibration-processing-card glass-surface-strong"><Aperture size={26} /><b>正在自动反相与去色罩</b><span><LoaderCircle className="spin" size={13} />已运行 {analysisProgress} 秒{analysisProgress > 1 ? ' · 大图可能需要更久，可随时取消' : '…'}</span><button className="button-secondary danger-outline compact" onClick={() => cancelAnalysisTask()}><X size={14} />取消分析</button></div></div>}
            <div className="calibration-canvas-status"><b>{recipe.density.enabled && negative ? '转换预览已启用' : negative ? '尚未建立转换参数' : '当前片种不需要负片转换'}</b><span>{histogram ? '直方图已更新' : '正在读取图像'}</span></div>
          </div>}
      filmstrip={<div className="calibration-source-strip">
        <span>原始素材</span>{assets.map((item) => <button key={item.id} className={item.id === asset?.id ? 'active' : ''} onClick={() => selectAsset(item.id)}><img src={item.previewUrl} draggable={false} alt="" /><b>{item.name}</b></button>)}
      </div>}
    />
  );
}
