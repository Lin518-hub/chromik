import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEVELOP_PROXY_FAULT_KINDS, injectDevelopProxyFault, verifyDevelopProxyFile } from './develop-cache-faults';
import type { Storage } from './storage';

/**
 * QA-06 故障注入闭环（开发代理缓存）。
 *
 * 场景：缓存文件被截断 / 位翻转 / 头部被毁 / 被整体替换 / 被外部删除后，
 * 应用必须自愈——校验失败 → 移除残骸 → 按需重建 → 缓存回到合法状态，
 * 用户照片因此永远不会"永久打不开"。每个场景都通过真实的 ensure*
 * 路径（与 UI 打开画面完全相同的代码）验证，并把重建计数落在
 * cache_state 表里作为审计证据。
 *
 * 只在未打包的开发构建中由 FILMLAB_QA_FAULT_INJECT=1 触发。
 */

export interface QaFaultInjectionDeps {
  storage: Storage;
  ensureDevelopProxy(assetId: string): Promise<string>;
  ensureFrameDevelopProxy(frameId: string): Promise<string>;
  developProxyPath(assetId: string): string;
  frameDevelopProxyPath(frameId: string): string;
  /** 通过 app-media 协议（渲染进程读取开发代理的同一通道）取回字节数。 */
  fetchDevelop(url: string): Promise<{ status: number; bytes: number }>;
  reportPath(): string;
  exit(code: number): void;
}

interface FaultInjectionStep {
  subjectId: string;
  kind: string;
  ok: boolean;
  sizeBefore: number;
  sizeAfter: number;
  lengthPreserved: boolean;
  rebuildCount: number;
  reason?: string;
}

interface ProtocolCheck {
  subjectId: string;
  kind: 'asset' | 'frame';
  status: number;
  bytes: number;
}

interface Subject {
  kind: 'asset' | 'frame';
  id: string;
  path: string;
  expectedWidth: number;
  expectedHeight: number;
}

export async function runQaFaultInjection(deps: QaFaultInjectionDeps): Promise<void> {
  // BUG-055：纵深熔断——即使调用点被误接线，打包生产版也绝不执行故障注入。
  if (app.isPackaged) {
    console.warn('Chromik: QA 故障注入在打包构建中被禁用');
    return;
  }
  const startedAt = Date.now();
  const steps: FaultInjectionStep[] = [];
  const protocolChecks: ProtocolCheck[] = [];
  let reportPath = deps.reportPath();
  try {
    // ---- 枚举目标：所有素材代理 + 无素材归属的画面代理（兼容旧库）----
    const subjects: Subject[] = [];
    for (const roll of deps.storage.listRolls()) {
      for (const asset of deps.storage.listAssets(roll.id)) {
        subjects.push({
          kind: 'asset', id: asset.id, path: deps.developProxyPath(asset.id),
          expectedWidth: asset.width, expectedHeight: asset.height,
        });
      }
      let assetlessFrames = deps.storage.listFrames(roll.id).filter((frame) => !frame.assetId);
      if (!assetlessFrames.length) {
        // 种子库的画面都挂在素材上时，合成一个无素材画面，
        // 保证 ensureFrameDevelopProxy / frame-develop 协议通道也被注入覆盖。
        const seedFrame = deps.storage.listFrames(roll.id)[0];
        if (!seedFrame) throw new Error('故障注入：胶卷中没有画面，无法合成无素材画面');
        const syntheticId = randomUUID();
        deps.storage.addFrame({
          id: syntheticId,
          rollId: roll.id,
          frameNumber: (seedFrame.frameNumber ?? 0) + 1,
          name: 'QA 故障注入无素材画面',
          sourcePath: seedFrame.sourcePath,
          // FrameSummary 不暴露指纹；合成画面仅用于代理自愈演练，指纹只参与重定位。
          sourceFingerprint: 'qa-fault-inject-synthetic',
          width: seedFrame.width,
          height: seedFrame.height,
          format: seedFrame.format,
          fileSize: seedFrame.fileSize,
          previewPath: deps.storage.getFramePaths(seedFrame.id)?.previewPath ?? seedFrame.sourcePath,
          recipe: { ...seedFrame.recipe, updatedAt: seedFrame.recipe.updatedAt + 1 },
          createdAt: Date.now(),
        });
        const synthetic = deps.storage.getFrame(syntheticId);
        if (!synthetic) throw new Error('故障注入：合成无素材画面失败');
        assetlessFrames = [synthetic];
      }
      for (const frame of assetlessFrames) {
        subjects.push({
          kind: 'frame', id: frame.id, path: deps.frameDevelopProxyPath(frame.id),
          expectedWidth: frame.width, expectedHeight: frame.height,
        });
      }
    }
    if (!subjects.length) throw new Error('故障注入：图库为空，没有可注入的开发代理');

    // ---- 预热：确保每个代理存在、合法且已落 cache_state 校验和记录 ----
    for (const subject of subjects) {
      const ensured = subject.kind === 'asset' ? await deps.ensureDevelopProxy(subject.id) : await deps.ensureFrameDevelopProxy(subject.id);
      const verdict = await verifyDevelopProxyFile(ensured);
      if (!verdict.valid) throw new Error(`预热失败：${ensured} 非法（${verdict.reason ?? '未知原因'}）`);
      const state = deps.storage.getCacheState(ensured);
      if (!state || !/^[0-9a-f]{8}$/.test(state.checksum) || state.version <= 0 || state.status !== 'valid') {
        throw new Error(`预热失败：${ensured} 缺少数据库校验和记录`);
      }
    }

    // ---- 故障注入：每种损坏 x 每个主体，走真实 ensure* 路径自愈 ----
    for (const subject of subjects) {
      for (const kind of DEVELOP_PROXY_FAULT_KINDS) {
        const beforeState = deps.storage.getCacheState(subject.path);
        const rebuildBefore = beforeState?.rebuildCount ?? 0;
        const injection = await injectDevelopProxyFault(subject.path, kind);
        // 注入之后必须立刻"非法"，否则该注入器本身无效，测试没有意义。
        const afterInjection = await verifyDevelopProxyFile(subject.path);
        if (afterInjection.valid) {
          steps.push({
            subjectId: subject.id, kind, ok: false, reason: `注入器无效：${kind} 之后文件仍然合法`,
            sizeBefore: injection.sizeBefore, sizeAfter: injection.sizeAfter,
            lengthPreserved: injection.lengthPreserved, rebuildCount: beforeState?.rebuildCount ?? 0,
          });
          continue;
        }
        // 与真实打开画面同一路径：校验 → 移除残骸 → 重建。
        const ensured = subject.kind === 'asset' ? await deps.ensureDevelopProxy(subject.id) : await deps.ensureFrameDevelopProxy(subject.id);
        const verdict = await verifyDevelopProxyFile(ensured);
        const afterState = deps.storage.getCacheState(ensured);
        const ok = verdict.valid
          && verdict.width === subject.expectedWidth
          && verdict.height === subject.expectedHeight
          && verdict.bitDepth === 16
          && verdict.transfer === 'linear'
          && afterState?.status === 'valid'
          && afterState.rebuildCount === rebuildBefore + 1;
        steps.push({
          subjectId: subject.id, kind, ok,
          sizeBefore: injection.sizeBefore, sizeAfter: injection.sizeAfter,
          lengthPreserved: injection.lengthPreserved,
          rebuildCount: afterState?.rebuildCount ?? -1,
          reason: ok ? undefined
            : (verdict.reason
              ?? `重建后仍不合法或计数不符（期望 rebuild=${rebuildBefore + 1}，实际=${afterState?.rebuildCount ?? '无记录'}）`),
        });
      }

      // ---- 缺失场景：文件被外部删除，同样必须静默重建 ----
      const beforeMissing = deps.storage.getCacheState(subject.path);
      const rebuildBeforeMissing = beforeMissing?.rebuildCount ?? 0;
      await fs.rm(subject.path, { force: true });
      const ensuredMissing = subject.kind === 'asset' ? await deps.ensureDevelopProxy(subject.id) : await deps.ensureFrameDevelopProxy(subject.id);
      const verdictMissing = await verifyDevelopProxyFile(ensuredMissing);
      const afterMissing = deps.storage.getCacheState(ensuredMissing);
      steps.push({
        subjectId: subject.id, kind: 'deleted-file', ok: verdictMissing.valid && afterMissing?.status === 'valid'
          && afterMissing.rebuildCount === rebuildBeforeMissing + 1,
        sizeBefore: 0, sizeAfter: 0, lengthPreserved: false,
        rebuildCount: afterMissing?.rebuildCount ?? -1,
        reason: verdictMissing.valid && afterMissing?.status === 'valid'
          ? undefined : '删除后重建失败或计数不符',
      });
    }

    // ---- 协议通道：渲染进程读取开发代理的同一 app-media 处理器 ----
    // 缓存破坏者加查询参数，绕开渲染层对旧 URL 的不可变缓存。
    for (const subject of subjects) {
      const host = subject.kind === 'asset' ? 'develop' : 'develop-frame';
      const bustedUrl = `app-media://${host}/${encodeURIComponent(subject.id)}?fault=${Date.now()}-${randomUUID()}`;
      const check = await deps.fetchDevelop(bustedUrl);
      protocolChecks.push({ subjectId: subject.id, kind: subject.kind, status: check.status, bytes: check.bytes });
    }

    const allStepsOk = steps.every((step) => step.ok);
    const allProtocolOk = protocolChecks.every((check) => check.status === 200 && check.bytes > 0);
    const passed = allStepsOk && allProtocolOk;
    const report = {
      format: 'chromik-fault-injection',
      version: 1,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      passed,
      subjects: subjects.length,
      injections: steps.length,
      protocolChecks: protocolChecks.length,
      steps,
      protocol: protocolChecks,
      cacheStates: deps.storage.listCacheStates(),
    };
    reportPath = await writeFaultReport(reportPath, report);
    console.log(`CHROMIK_FAULT_INJECT ${JSON.stringify({ output: reportPath, passed, subjects: subjects.length, injections: steps.length, protocolChecks: protocolChecks.length, durationMs: report.durationMs })}`);
    deps.exit(passed ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      reportPath = await writeFaultReport(reportPath, {
        format: 'chromik-fault-injection', version: 1, generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt, passed: false, subjects: 0, injections: steps.length,
        protocolChecks: protocolChecks.length, steps, protocol: protocolChecks, fatal: message,
        cacheStates: deps.storage.listCacheStates(),
      });
    } catch { /* 报告写失败不影响退出码 */ }
    console.error('CHROMIK_FAULT_INJECT_FAILED', message, reportPath);
    deps.exit(1);
  }
}

async function writeFaultReport(reportPath: string, report: unknown): Promise<string> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, reportPath);
  return reportPath;
}
