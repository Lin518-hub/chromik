import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from './backup-service';
import { Storage } from './storage';

const temporaryDirectories: string[] = [];

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'chromik-backup-test-'));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, 'library.sqlite');
  const backupsDirectory = path.join(root, 'backups');
  const lutDirectory = path.join(root, 'luts');
  const originalPath = path.join(root, 'original.tif');
  writeFileSync(originalPath, Buffer.alloc(600_000, 17));
  writeFileSync(path.join(root, 'placeholder'), 'x');
  let storage = new Storage(databasePath);
  storage.createRoll('original-roll', { name: 'Original', filmType: 'color_negative' }, 1);
  const service = () => new BackupService({
    backupsDirectory,
    lutDirectory,
    appVersion: '0.9.1-test',
    databasePath: () => databasePath,
    sourcePaths: () => [originalPath],
    checkpoint: () => storage.checkpoint(),
    close: () => storage.close(),
    reopen: () => { storage = new Storage(databasePath); },
    clearLutCache: () => undefined,
  });
  return { root, databasePath, backupsDirectory, lutDirectory, get storage() { return storage; }, service };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('BackupService', () => {
  it('round-trips database, settings and LUTs while preserving a recovery database', async () => {
    const context = setup();
    await import('node:fs/promises').then((fs) => fs.mkdir(context.lutDirectory, { recursive: true }));
    writeFileSync(path.join(context.lutDirectory, 'test.cube'), 'LUT_3D_SIZE 2\n');
    const backup = await context.service().create('{"motionLevel":"reduced"}');
    expect(existsSync(path.join(backup.path, 'manifest.json'))).toBe(true);

    context.storage.createRoll('later-roll', { name: 'Later', filmType: 'bw_negative' }, 2);
    writeFileSync(path.join(context.lutDirectory, 'test.cube'), 'changed');
    const result = await context.service().restore(backup.path);

    expect(result.settingsJson).toBe('{"motionLevel":"reduced"}');
    expect(context.storage.listRolls().map((roll) => roll.id)).toEqual(['original-roll']);
    expect(readFileSync(path.join(context.lutDirectory, 'test.cube'), 'utf8')).toBe('LUT_3D_SIZE 2\n');
    expect(readdirSync(context.backupsDirectory).some((name) => name.startsWith('before-restore-'))).toBe(true);
    context.storage.close();
  });

  it('rejects a tampered database before closing the live library', async () => {
    const context = setup();
    const backup = await context.service().create();
    appendFileSync(path.join(backup.path, 'library.sqlite'), 'tampered');
    await expect(context.service().restore(backup.path)).rejects.toThrow('备份数据库校验失败');
    expect(context.storage.listRolls()).toHaveLength(1);
    context.storage.close();
  });

  it('rolls the live database back when the synchronous restore swap is interrupted', async () => {
    const context = setup();
    mkdirSync(context.lutDirectory, { recursive: true });
    writeFileSync(path.join(context.lutDirectory, 'live.cube'), 'live');
    const backup = await context.service().create();
    context.storage.createRoll('must-survive', { name: 'Must survive', filmType: 'color_negative' }, 2);

    const interruptedAt = 1_787_735_700_000;
    const collisionDirectory = `${context.lutDirectory}.before-restore-${interruptedAt}`;
    mkdirSync(collisionDirectory, { recursive: true });
    writeFileSync(path.join(collisionDirectory, 'occupied'), 'block directory replacement');
    const now = vi.spyOn(Date, 'now').mockReturnValue(interruptedAt);
    await expect(context.service().restore(backup.path)).rejects.toThrow();
    now.mockRestore();

    expect(context.storage.listRolls().map((roll) => roll.id).sort()).toEqual(['must-survive', 'original-roll']);
    expect(readFileSync(path.join(context.lutDirectory, 'live.cube'), 'utf8')).toBe('live');
    expect(readdirSync(context.root).filter((name) => name.endsWith('.restore'))).toEqual([]);
    context.storage.close();
  });
});

describe('BackupService version compatibility', () => {
  it('warns when the backup comes from a newer recipe schema', async () => {
    const context = setup();
    const backup = await context.service().create();
    const manifestPath = path.join(backup.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.recipeSchema = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await context.service().restore(backup.path);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('更新版本');
    context.storage.close();
  });
});
