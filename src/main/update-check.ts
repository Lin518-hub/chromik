import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * REL-03：1.0 的手动更新检测。应用启动时读取安装目录旁（或打包 resources
 * 中）的 version.json 清单，若清单版本高于当前版本则提示用户"到下载页获取"。
 * 不做自动下载/静默更新：本地应用、无账号体系，避免后台下载与中断恢复复杂度。
 */

export interface UpdateManifest {
  version: string;
  url?: string;
  notes?: string;
}

const updateManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url().optional(),
  notes: z.string().max(500).optional(),
});

/** 纯比较器：按 主.次.修订 数字比较，忽略前缀与构建后缀。 */
export function compareVersions(candidate: string, current: string): number {
  const parse = (value: string) => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
    if (!match) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const [candidateMajor, candidateMinor, candidatePatch] = parse(candidate);
  const [currentMajor, currentMinor, currentPatch] = parse(current);
  if (candidateMajor !== currentMajor) return candidateMajor - currentMajor;
  if (candidateMinor !== currentMinor) return candidateMinor - currentMinor;
  return candidatePatch - currentPatch;
}

/** 从给定的候选路径列表中读取第一份合法清单（QA 可用环境变量覆盖）。 */
export async function readUpdateManifest(candidatePaths: string[]): Promise<UpdateManifest | undefined> {
  for (const filePath of candidatePaths) {
    try {
      const parsed = updateManifestSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
      return { version: parsed.version, url: parsed.url, notes: parsed.notes };
    } catch {
      // 清单缺失/损坏都不应影响启动。
    }
  }
  return undefined;
}

export function updateManifestCandidates(executableDirectory: string, resourcesDirectory: string): string[] {
  return [
    path.join(executableDirectory, 'version.json'),
    path.join(resourcesDirectory, 'version.json'),
  ];
}

/** 只在候选版本严格高于当前版本时返回提示；URL 仅接受 https。 */
export function evaluateUpdate(manifest: UpdateManifest | undefined, currentVersion: string): { available: false } | {
  available: true;
  version: string;
  url: string | undefined;
  notes: string | undefined;
} {
  if (!manifest || compareVersions(manifest.version, currentVersion) <= 0) return { available: false };
  const url = manifest.url && manifest.url.startsWith('https://') ? manifest.url : undefined;
  return { available: true, version: manifest.version, url, notes: manifest.notes };
}
