import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, promises as fs, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BackupInfo } from '../shared/types';

const CURRENT_RECIPE_SCHEMA = 6;
const MIN_FREE_SPACE_SLACK_BYTES = 64 * 1024 * 1024;

export interface BackupServiceDependencies {
  backupsDirectory: string;
  lutDirectory: string;
  appVersion: string;
  databasePath(): string;
  sourcePaths(): string[];
  checkpoint(): void;
  close(): void;
  reopen(): void;
  clearLutCache(): void;
}

export interface BackupManifest {
  format: 'chromik-backup';
  version: 1;
  appVersion: string;
  recipeSchema: 6;
  algorithmVersion: 'chromik-6';
  createdAt: number;
  database: {
    file: 'library.sqlite';
    sha256: string;
    size: number;
    wal?: { file: string; sha256: string };
    shm?: { file: string; sha256: string };
  };
  settings?: { file: 'settings.json'; sha256: string };
  luts: Array<{ file: string; sha256: string }>;
  originals: Array<{ path: string; fingerprint?: { size: number; mtimeMs: number; sha256: string } }>;
  originalHashMethod: 'sha256(size + first256KiB + last256KiB)';
  caches: { included: false; reason: string };
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function sampledSourceHash(filePath: string): Promise<{ size: number; mtimeMs: number; sha256: string } | undefined> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return undefined;
    const handle = await fs.open(filePath, 'r');
    try {
      const sampleSize = Math.min(256 * 1024, stats.size);
      const first = Buffer.alloc(sampleSize);
      const last = Buffer.alloc(sampleSize);
      await handle.read(first, 0, sampleSize, 0);
      if (stats.size > sampleSize) await handle.read(last, 0, sampleSize, Math.max(0, stats.size - sampleSize));
      const sha256 = createHash('sha256').update(String(stats.size)).update(first).update(last).digest('hex');
      return { size: stats.size, mtimeMs: stats.mtimeMs, sha256 };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function directorySize(directory: string): Promise<number> {
  // BUG-051（P3-11）：递归统计加深度/条目上限，符号链接循环不再爆栈或死循环。
  let total = 0;
  let entries = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 16 || entries > 200_000) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > 200_000) return;
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(itemPath, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) total += (await fs.stat(itemPath)).size;
    }
  };
  await walk(directory, 0);
  return total;
}

export class BackupService {
  constructor(private readonly dependencies: BackupServiceDependencies) {}

  async create(settingsJson?: string): Promise<BackupInfo> {
    this.dependencies.checkpoint();
    const directory = this.dependencies.backupsDirectory;
    await fs.mkdir(directory, { recursive: true });
    const createdAt = Date.now();
    const destination = path.join(directory, `chromik-backup-${createdAt}`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(temporary, { recursive: true });
      const databasePath = this.dependencies.databasePath();
      const databaseFile = path.join(temporary, 'library.sqlite');
      // P2-7：checkpoint 之后的新写入会落到 -wal，必须连同 wal/shm 一起
      // 复制，恢复时三者同组放回，SQLite 才能重放出一致的库。
      await fs.copyFile(databasePath, databaseFile);
      let walCopied = false;
      let shmCopied = false;
      if (existsSync(`${databasePath}-wal`)) {
        await fs.copyFile(`${databasePath}-wal`, `${databaseFile}-wal`);
        walCopied = true;
      }
      if (existsSync(`${databasePath}-shm`)) {
        await fs.copyFile(`${databasePath}-shm`, `${databaseFile}-shm`);
        shmCopied = true;
      }
      const originals = [];
      for (const sourcePath of new Set(this.dependencies.sourcePaths())) {
        originals.push({ path: sourcePath, fingerprint: await sampledSourceHash(sourcePath) });
      }
      const backupLuts = path.join(temporary, 'luts');
      if (existsSync(this.dependencies.lutDirectory)) {
        // P2-6：dereference 解析符号链接，备份与恢复都不跟随外部链接。
        await fs.cp(this.dependencies.lutDirectory, backupLuts, { recursive: true, force: false, dereference: true });
      }
      const lutFiles = existsSync(backupLuts)
        ? (await fs.readdir(backupLuts)).filter((name) => name.endsWith('.cube'))
        : [];
      const manifest: BackupManifest = {
        format: 'chromik-backup',
        version: 1,
        appVersion: this.dependencies.appVersion,
        recipeSchema: 6,
        algorithmVersion: 'chromik-6',
        createdAt,
        database: {
          file: 'library.sqlite',
          sha256: await hashFile(databaseFile),
          size: (await fs.stat(databaseFile)).size,
          wal: walCopied ? { file: 'library.sqlite-wal', sha256: await hashFile(`${databaseFile}-wal`) } : undefined,
          shm: shmCopied ? { file: 'library.sqlite-shm', sha256: await hashFile(`${databaseFile}-shm`) } : undefined,
        },
        settings: settingsJson ? { file: 'settings.json', sha256: createHash('sha256').update(settingsJson).digest('hex') } : undefined,
        luts: await Promise.all(lutFiles.map(async (name) => ({ file: `luts/${name}`, sha256: await hashFile(path.join(backupLuts, name)) }))),
        originals,
        originalHashMethod: 'sha256(size + first256KiB + last256KiB)',
        caches: { included: false, reason: '可由原片与配方安全重建' },
      };
      if (settingsJson) await fs.writeFile(path.join(temporary, 'settings.json'), settingsJson, { flag: 'wx' });
      await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return { path: destination, createdAt, sizeBytes: await directorySize(destination) };
  }

  async list(): Promise<BackupInfo[]> {
    const directory = this.dependencies.backupsDirectory;
    await fs.mkdir(directory, { recursive: true });
    const backups: BackupInfo[] = [];
    for (const name of await fs.readdir(directory)) {
      const match = /^(?:filmlab-(\d+)\.sqlite|chromik-backup-(\d+))$/.exec(name);
      if (!match) continue;
      const filePath = path.join(directory, name);
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile() && !stats.isDirectory()) continue;
        const parsed = Number(match[1] ?? match[2]);
        backups.push({
          path: filePath,
          createdAt: Number.isFinite(parsed) && parsed > 0 ? parsed : Math.round(stats.mtimeMs),
          sizeBytes: stats.isDirectory() ? await directorySize(filePath) : stats.size,
        });
      } catch {
        // A backup may disappear between readdir and stat.
      }
    }
    return backups.sort((left, right) => right.createdAt - left.createdAt);
  }

  async restore(backupPath: string): Promise<{ ok: boolean; message: string; settingsJson?: string }> {
    // BUG-042：路径校验解析符号链接（realpath），备份目录内的链接不能越权
    // 读取外部文件或替换主库。
    const directory = await fs.realpath(path.resolve(this.dependencies.backupsDirectory))
      .catch(() => path.resolve(this.dependencies.backupsDirectory));
    const resolvedLexical = path.resolve(backupPath);
    const resolved = await fs.realpath(resolvedLexical).catch(() => resolvedLexical);
    if (resolved !== directory && !resolved.startsWith(directory + path.sep)) throw new Error('仅允许恢复备份目录内的文件');
    const backupStats = await fs.stat(resolved).catch(() => undefined);
    if (!backupStats) throw new Error('备份不存在');
    let databaseSource = resolved;
    let settingsJson: string | undefined;
    let backupLuts: string | undefined;
    let expectedDatabaseHash: string | undefined;
    let expectedWal: { file: string; sha256: string } | undefined;
    let expectedShm: { file: string; sha256: string } | undefined;
    let lutEntries: Array<{ file: string; sha256: string }> = [];
    if (backupStats.isDirectory()) {
      const manifestPath = path.join(resolved, 'manifest.json');
      // P3-12：manifest 大小上限，损坏/异常备份不会拖垮内存。
      const manifestStats = await fs.stat(manifestPath).catch(() => undefined);
      if (!manifestStats || manifestStats.size > 1_048_576) throw new Error('备份 manifest 无效');
      const manifestSchema = z.object({
        format: z.literal('chromik-backup'), version: z.literal(1),
        database: z.object({
          file: z.literal('library.sqlite'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
          wal: z.object({ file: z.literal('library.sqlite-wal'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
          shm: z.object({ file: z.literal('library.sqlite-shm'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
        }),
        settings: z.object({ file: z.literal('settings.json'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
        luts: z.array(z.object({ file: z.string().regex(/^luts\/[A-Za-z0-9_-]+\.cube$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
      }).passthrough();
      const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
      databaseSource = path.join(resolved, manifest.database.file);
      expectedDatabaseHash = manifest.database.sha256;
      expectedWal = manifest.database.wal;
      expectedShm = manifest.database.shm;
      lutEntries = manifest.luts;
      if (manifest.settings) {
        settingsJson = await fs.readFile(path.join(resolved, manifest.settings.file), 'utf8');
        if (createHash('sha256').update(settingsJson).digest('hex') !== manifest.settings.sha256) throw new Error('备份设置校验失败');
      }
      const candidateLuts = path.join(resolved, 'luts');
      if (existsSync(candidateLuts)) backupLuts = candidateLuts;
      for (const lut of lutEntries) {
        if (await hashFile(path.join(resolved, lut.file)) !== lut.sha256) throw new Error(`备份 LUT 校验失败：${path.basename(lut.file)}`);
      }
      if (expectedWal && await hashFile(path.join(resolved, expectedWal.file)) !== expectedWal.sha256) throw new Error('备份数据库 WAL 校验失败');
      if (expectedShm && await hashFile(path.join(resolved, expectedShm.file)) !== expectedShm.sha256) throw new Error('备份数据库 SHM 校验失败');
    } else if (!backupStats.isFile()) {
      throw new Error('备份格式无效');
    }
    const handle = await fs.open(databaseSource, 'r').catch(() => undefined);
    if (!handle) throw new Error('备份文件不可读');
    const header = Buffer.alloc(16);
    try {
      await handle.read(header, 0, 16, 0);
    } finally {
      await handle.close();
    }
    if (header.toString('utf8', 0, 16) !== 'SQLite format 3\u0000') throw new Error('不是有效的 SQLite 备份文件');
    if (expectedDatabaseHash && await hashFile(databaseSource) !== expectedDatabaseHash) throw new Error('备份数据库校验失败');

    // DATA-02：恢复前磁盘空间预检（备份数据库大小 + 64MB 余量）。
    const databaseSize = (await fs.stat(databaseSource)).size;
    try {
      const databasePath = this.dependencies.databasePath();
      const space = await fs.statfs(path.dirname(databasePath));
      const available = Number(space.bavail) * Number(space.bsize);
      if (Number.isFinite(available) && available < databaseSize + MIN_FREE_SPACE_SLACK_BYTES) {
        throw new Error(`磁盘空间不足：恢复需要约 ${Math.ceil((databaseSize + MIN_FREE_SPACE_SLACK_BYTES) / 1024 / 1024)} MB 可用空间`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('磁盘空间不足')) throw error;
      // statfs 不可用时跳过预检（恢复流程自身会在写入失败时安全回滚）。
    }

    // DATA-02：备份版本兼容提示——schema 比当前新说明备份来自更新版本，
    // 仍允许恢复（配方可向前迁移），但必须明确告知用户。
    let compatibilityNote: string | undefined;
    try {
      if (backupStats.isDirectory()) {
        const manifest = JSON.parse(await fs.readFile(path.join(resolved, 'manifest.json'), 'utf8')) as {
          appVersion?: unknown;
          recipeSchema?: unknown;
        };
        if (typeof manifest.recipeSchema === 'number' && manifest.recipeSchema > CURRENT_RECIPE_SCHEMA) {
          compatibilityNote = `备份来自更新版本（配方 schema ${manifest.recipeSchema}），恢复后部分参数可能按当前版本回退`;
        } else if (typeof manifest.appVersion === 'string' && this.dependencies.appVersion !== manifest.appVersion) {
          compatibilityNote = `备份来自 ${manifest.appVersion}，当前为 ${this.dependencies.appVersion}`;
        }
      }
    } catch { /* manifest 兼容提示失败不影响恢复 */ }

    const databasePath = this.dependencies.databasePath();
    const lutDirectory = this.dependencies.lutDirectory;
    // 第一步：存储仍打开时完成所有耗时异步 staging（复制大文件）。
    const stagedDatabase = `${databasePath}.${randomUUID()}.restore`;
    const stagedWal = `${stagedDatabase}-wal`;
    const stagedShm = `${stagedDatabase}-shm`;
    const stagedLutsPath = backupLuts ? `${lutDirectory}.${randomUUID()}.restore` : undefined;
    await fs.copyFile(databaseSource, stagedDatabase);
    // BUG-042/TOCTOU：对 staged 副本再做一次哈希校验，关闭“校验后复制前
    // 被替换”的窗口——换库依据的是这份刚复制完的字节。
    if (expectedDatabaseHash && await hashFile(stagedDatabase) !== expectedDatabaseHash) {
      await fs.rm(stagedDatabase, { force: true });
      throw new Error('备份数据库校验失败');
    }
    if (expectedWal) await fs.copyFile(path.join(resolved, expectedWal.file), stagedWal);
    if (expectedShm) await fs.copyFile(path.join(resolved, expectedShm.file), stagedShm);
    if (backupLuts && stagedLutsPath) {
      // P2-6：dereference 解析链接，恢复后的 LUT 目录不含指向外部的符号链接。
      await fs.cp(backupLuts, stagedLutsPath, { recursive: true, force: false, dereference: true });
    }

    // 第二步：同步交换。close 与 reopen 之间零 await（BUG-031：此前这里夹
    // 多个 await，其他 IPC 会命中已关闭的 DatabaseSync）。任何一步失败都
    // 整组回滚——绝不给用户留下“库已换但 LUT 失败”的半途状态（BUG-032）。
    const recoveryPath = path.join(directory, `before-restore-${Date.now()}.sqlite`);
    this.dependencies.checkpoint();
    this.dependencies.close();
    let databaseSwapped = false;
    let lutsSwapped = false;
    let previousLuts: string | undefined;
    try {
      if (existsSync(databasePath)) renameSync(databasePath, recoveryPath);
      renameSync(stagedDatabase, databasePath);
      databaseSwapped = true;
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      if (expectedWal) copyFileSync(stagedWal, `${databasePath}-wal`);
      if (expectedShm) copyFileSync(stagedShm, `${databasePath}-shm`);
      if (backupLuts && stagedLutsPath) {
        previousLuts = `${lutDirectory}.before-restore-${Date.now()}`;
        if (existsSync(lutDirectory)) renameSync(lutDirectory, previousLuts);
        renameSync(stagedLutsPath, lutDirectory);
        lutsSwapped = true;
        this.dependencies.clearLutCache();
      }
    } catch (error) {
      try {
        if (databaseSwapped) {
          rmSync(databasePath, { force: true });
          if (existsSync(recoveryPath)) renameSync(recoveryPath, databasePath);
          rmSync(`${databasePath}-wal`, { force: true });
          rmSync(`${databasePath}-shm`, { force: true });
        } else if (!existsSync(databasePath) && existsSync(recoveryPath)) {
          renameSync(recoveryPath, databasePath);
        }
        if (previousLuts && existsSync(previousLuts)) {
          if (lutsSwapped) {
            rmSync(lutDirectory, { recursive: true, force: true });
            renameSync(previousLuts, lutDirectory);
          } else if (!existsSync(lutDirectory)) {
            renameSync(previousLuts, lutDirectory);
          }
        }
      } catch (rollbackError) {
        console.warn('Chromik: 备份恢复回滚未完全完成', rollbackError);
      }
      rmSync(stagedDatabase, { force: true });
      rmSync(stagedWal, { force: true });
      rmSync(stagedShm, { force: true });
      if (stagedLutsPath) rmSync(stagedLutsPath, { recursive: true, force: true });
      this.dependencies.reopen();
      throw error;
    }
    rmSync(stagedWal, { force: true });
    rmSync(stagedShm, { force: true });
    this.dependencies.reopen();
    return {
      ok: true,
      message: compatibilityNote ? `完整备份已恢复（${compatibilityNote}）；已保留恢复前数据库，建议重启应用` : '完整备份已恢复；已保留恢复前数据库，建议重启应用',
      settingsJson,
    };
  }
}
