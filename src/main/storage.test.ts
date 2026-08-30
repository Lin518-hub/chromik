import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRecipe } from '../shared/defaults';
import { Storage } from './storage';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'filmlab-storage-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Storage roll and frame workflow', () => {
  it('preserves each frame geometry when synchronizing grade and adapts recipes when film type changes', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'strip.tif');
    const assetPreview = path.join(directory, 'asset.jpg');
    const firstPreview = path.join(directory, 'first.jpg');
    const secondPreview = path.join(directory, 'second.jpg');
    for (const filePath of [sourcePath, assetPreview, firstPreview, secondPreview]) writeFileSync(filePath, 'test');
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    storage.createRoll('roll', { name: 'Test roll', filmType: 'color_negative' }, 1);
    storage.addAsset({
      id: 'asset', rollId: 'roll', name: 'strip.tif', sourcePath, sourceFingerprint: '1',
      width: 12000, height: 2000, format: 'TIFF', fileSize: 4, previewPath: assetPreview, kind: 'strip', createdAt: 2,
    });
    const firstRecipe = createDefaultRecipe();
    firstRecipe.geometry.corners = [{ x: 0, y: 0 }, { x: .45, y: 0 }, { x: .45, y: 1 }, { x: 0, y: 1 }];
    firstRecipe.density.enabled = true;
    firstRecipe.grade.exposureEv = 1.25;
    const secondRecipe = createDefaultRecipe();
    secondRecipe.geometry.corners = [{ x: .55, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: .55, y: 1 }];
    storage.addFrame({ id: 'first', rollId: 'roll', assetId: 'asset', name: 'first', sourcePath, sourceFingerprint: '1', width: 5400, height: 2000, format: 'TIFF', fileSize: 4, previewPath: firstPreview, recipe: firstRecipe, createdAt: 3 });
    storage.addFrame({ id: 'second', rollId: 'roll', assetId: 'asset', name: 'second', sourcePath, sourceFingerprint: '1', width: 5400, height: 2000, format: 'TIFF', fileSize: 4, previewPath: secondPreview, recipe: secondRecipe, createdAt: 4 });
    storage.saveRollCalibration('roll', { baseRgb: [230, 158, 101], density: { ...firstRecipe.density }, updatedAt: 5 });

    const densityBeforeCopy = storage.getFrame('second')!.recipe.density;
    storage.copyRecipeToRoll('first');
    const synchronized = storage.getFrame('second')!;
    expect(synchronized.recipe.grade.exposureEv).toBe(1.25);
    expect(synchronized.recipe.geometry.corners).toEqual(secondRecipe.geometry.corners);
    expect(synchronized.recipe.density).toEqual(densityBeforeCopy);

    storage.updateRoll('roll', { name: 'Test roll', filmType: 'bw_slide' });
    const slideRecipe = storage.getFrame('first')!.recipe;
    expect(slideRecipe.density.enabled).toBe(false);
    expect(slideRecipe.grade.blackAndWhite).toBe(true);
    storage.updateRoll('roll', { name: 'Test roll', filmType: 'color_negative' });
    expect(storage.getFrame('first')!.recipe.density.enabled).toBe(true);
    storage.close();
  });

  it('migrates the original single-frame schema into an asset-backed roll', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'legacy.sqlite');
    const sourcePath = path.join(directory, 'legacy.png');
    const previewPath = path.join(directory, 'legacy.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE rolls (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE frames (
        id TEXT PRIMARY KEY, roll_id TEXT NOT NULL, name TEXT NOT NULL, source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, format TEXT NOT NULL,
        file_size INTEGER NOT NULL, status TEXT NOT NULL, preview_path TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE edits (
        frame_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, algorithm_version TEXT NOT NULL,
        recipe_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    database.prepare('INSERT INTO rolls VALUES (?, ?, ?)').run('legacy-roll', 'Legacy roll', 1);
    database.prepare('INSERT INTO frames VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-frame', 'legacy-roll', 'legacy.png', sourcePath, '1', 100, 80, 'PNG', 6, 'ready', previewPath, 2,
    );
    const recipe = createDefaultRecipe();
    database.prepare('INSERT INTO edits VALUES (?, ?, ?, ?, ?)').run('legacy-frame', 2, 'filmlab-2', JSON.stringify(recipe), recipe.updatedAt);
    database.close();

    const storage = new Storage(databasePath);
    expect(storage.listAssets('legacy-roll')).toHaveLength(1);
    expect(storage.getFrame('legacy-frame')?.assetId).toBe('legacy-frame');
    expect(storage.getRoll('legacy-roll')).toMatchObject({ filmType: 'color_negative', assetCount: 1, frameCount: 1 });
    storage.close();
  });

  it('stores one roll calibration and applies only conversion fields to existing frames', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'negative.tif');
    const previewPath = path.join(directory, 'negative.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'calibration.sqlite'));
    storage.createRoll('roll', { name: 'Calibrated roll', filmType: 'color_negative' }, 1);
    const recipe = createDefaultRecipe();
    recipe.geometry.corners = [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }];
    recipe.grade.exposureEv = .75;
    storage.addFrame({ id: 'frame', rollId: 'roll', name: 'frame', sourcePath, sourceFingerprint: '1', width: 100, height: 80, format: 'TIFF', fileSize: 6, previewPath, recipe, createdAt: 2 });

    const updatedFrameIds = storage.saveRollCalibration('roll', {
      baseRgb: [231, 158, 102],
      density: {
        enabled: true,
        low: [.04, .05, .06],
        high: [1.5, 1.6, 1.7],
        mode: 'display_reference',
        profileId: 'camera_srgb',
        filmProfileId: 'generic_color_negative',
        inputTransfer: 'srgb',
        separation: 0,
        neutralProtection: 55,
        crossoverStrength: 1,
        shadowCorrection: [0, 0, 0],
        midCorrection: [0, 0, 0],
        highlightCorrection: [0, 0, 0],
      },
      updatedAt: 3,
    });

    expect(updatedFrameIds).toEqual(['frame']);
    const calibrated = storage.getFrame('frame')!.recipe;
    expect(calibrated.baseRgb).toEqual([231, 158, 102]);
    expect(calibrated.density.high).toEqual([1.5, 1.6, 1.7]);
    expect(calibrated.geometry.corners).toEqual(recipe.geometry.corners);
    expect(calibrated.grade.exposureEv).toBe(.75);
    expect(storage.getRoll('roll')?.calibration.baseRgb).toEqual([231, 158, 102]);
    storage.close();
  });

  it('invalidates the original-preview URL after reframing and relocation', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'preview.sqlite'));
    storage.createRoll('roll', { name: 'Roll', filmType: 'color_negative' }, 1);
    const recipe = createDefaultRecipe();
    storage.addFrame({ id: 'frame', rollId: 'roll', name: 'frame', sourcePath, sourceFingerprint: '1', width: 100, height: 80, format: 'TIFF', fileSize: 6, previewPath, recipe, createdAt: 2 });
    const originalUrl = storage.getFrame('frame')!.previewUrl;
    storage.updateFrameGeometry('frame', { width: 90, height: 70, previewPath, name: 'reframed', recipe });
    const reframedUrl = storage.getFrame('frame')!.previewUrl;
    expect(reframedUrl).not.toBe(originalUrl);
    storage.relocateFrame('frame', { sourcePath, sourceFingerprint: '2', width: 95, height: 75, format: 'TIFF', fileSize: 6, previewPath, name: 'relocated' });
    expect(storage.getFrame('frame')!.previewUrl).not.toBe(reframedUrl);
    storage.close();
  });

  it('stores grade presets with name deduplication and idempotent delete', () => {
    const directory = temporaryDirectory();
    const storage = new Storage(path.join(directory, 'presets.sqlite'));
    const grade = createDefaultRecipe().grade;
    grade.printerLights = [1, 2, 3];

    const first = storage.savePreset('My Look', grade);
    grade.printerLights[0] = 99;
    expect(first.name).toBe('My Look');
    expect(first.grade.printerLights).toEqual([1, 2, 3]);

    expect(storage.savePreset('My Look', grade).name).toBe('My Look (2)');
    expect(storage.savePreset('My Look', grade).name).toBe('My Look (3)');
    expect(storage.listPresets().map((preset) => preset.name)).toEqual(['My Look', 'My Look (2)', 'My Look (3)']);

    storage.deletePreset(first.id);
    storage.deletePreset(first.id); // idempotent
    storage.deletePreset('missing-preset'); // idempotent, never throws
    expect(storage.listPresets().map((preset) => preset.id)).not.toContain(first.id);
    expect(storage.listPresets()).toHaveLength(2);
    storage.close();
  });

  it('persists frame and roll starred/tags metadata through the summary objects', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'meta.sqlite'));
    storage.createRoll('roll', { name: 'Roll', filmType: 'color_negative' }, 1);
    expect(storage.getRoll('roll')).toMatchObject({ starred: false, tags: [] });

    storage.addFrame({ id: 'frame', rollId: 'roll', name: 'frame', sourcePath, sourceFingerprint: '1', width: 100, height: 80, format: 'TIFF', fileSize: 6, previewPath, recipe: createDefaultRecipe(), createdAt: 2 });
    expect(storage.getFrame('frame')).toMatchObject({ starred: false, tags: [] });

    expect(storage.setFrameMeta('frame', { starred: true, tags: ['keeper', 'portrait'] })).toMatchObject({ starred: true, tags: ['keeper', 'portrait'] });
    expect(storage.getFrame('frame')).toMatchObject({ starred: true, tags: ['keeper', 'portrait'] });
    expect(storage.listFrames('roll')[0]).toMatchObject({ starred: true, tags: ['keeper', 'portrait'] });

    expect(storage.setRollMeta('roll', { starred: true, tags: ['scanned'] })).toMatchObject({ starred: true, tags: ['scanned'] });
    expect(storage.getRoll('roll')).toMatchObject({ starred: true, tags: ['scanned'] });
    expect(storage.listRolls()[0]).toMatchObject({ starred: true, tags: ['scanned'] });
    storage.close();
  });

  it('pastes only the requested grade scope and never touches geometry or crop', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'paste.sqlite'));
    storage.createRoll('roll', { name: 'Roll', filmType: 'color_negative' }, 1);

    const target = createDefaultRecipe();
    target.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    target.geometry.corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    target.grade.exposureEv = 0;
    target.grade.temperature = 0;
    target.grade.contrast = 8;
    target.grade.look = 'neutral';
    target.grade.saturation = 0;
    storage.addFrame({ id: 'frame', rollId: 'roll', name: 'frame', sourcePath, sourceFingerprint: '1', width: 100, height: 80, format: 'TIFF', fileSize: 6, previewPath, recipe: target, createdAt: 2 });

    const source = createDefaultRecipe();
    source.grade.exposureEv = 1.5;
    source.grade.temperature = 20;
    source.grade.saturation = 30;
    source.grade.contrast = 60;
    source.grade.look = 'warm_print';

    expect(storage.pasteRecipeToFrames(['frame'], source, 'exposure')).toBe(1);
    let pasted = storage.getFrame('frame')!;
    expect(pasted.recipe.grade.exposureEv).toBe(1.5);
    expect(pasted.recipe.grade.temperature).toBe(0);
    expect(pasted.recipe.grade.contrast).toBe(8);
    expect(pasted.recipe.grade.look).toBe('neutral');
    expect(pasted.recipe.crop).toEqual(target.crop);
    expect(pasted.recipe.geometry.corners).toEqual(target.geometry.corners);

    expect(storage.pasteRecipeToFrames(['frame'], source, 'color')).toBe(1);
    pasted = storage.getFrame('frame')!;
    expect(pasted.recipe.grade.temperature).toBe(20);
    expect(pasted.recipe.grade.saturation).toBe(30);
    expect(pasted.recipe.grade.exposureEv).toBe(1.5); // exposure preserved from previous paste
    expect(pasted.recipe.grade.contrast).toBe(8); // contrast is not part of 'color'
    expect(pasted.recipe.grade.look).toBe('neutral'); // look is not part of 'color'

    expect(storage.pasteRecipeToFrames(['frame'], source, 'all')).toBe(1);
    pasted = storage.getFrame('frame')!;
    expect(pasted.recipe.grade.contrast).toBe(60);
    expect(pasted.recipe.grade.look).toBe('warm_print');
    expect(pasted.recipe.crop).toEqual(target.crop);
    expect(pasted.recipe.geometry.corners).toEqual(target.geometry.corners);
    expect(pasted.recipe.grade).not.toBe(source.grade);
    expect(pasted.recipe.grade.printerLights).not.toBe(source.grade.printerLights);
    storage.close();
  });

  it('writes and parses asset EXIF metadata', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'exif.sqlite'));
    storage.createRoll('roll', { name: 'Roll', filmType: 'color_negative' }, 1);
    storage.addAsset({
      id: 'asset', rollId: 'roll', name: 'source.tif', sourcePath, sourceFingerprint: '1',
      width: 12000, height: 2000, format: 'TIFF', fileSize: 4, previewPath, kind: 'strip', createdAt: 2,
      exif: { iso: 400, shutter: '1/125', aperture: 'f/2.8', focalLength: '50mm', shotAt: '2024-05-01T12:30:00', camera: 'Test Camera' },
    });
    expect(storage.getAsset('asset')).toMatchObject({ exif: { iso: 400, shutter: '1/125', camera: 'Test Camera' } });
    expect(storage.listAssets('roll')[0].exif?.aperture).toBe('f/2.8');
    expect(storage.listAssets('roll')[0].exif?.focalLength).toBe('50mm');
    storage.close();
  });

  it('falls back to a default recipe when one database row is damaged', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'damaged.sqlite');
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, 'source');
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(databasePath);
    storage.createRoll('roll', { name: 'Roll', filmType: 'color_negative' }, 1);
    storage.addFrame({ id: 'frame', rollId: 'roll', name: 'frame', sourcePath, sourceFingerprint: '1', width: 100, height: 80, format: 'TIFF', fileSize: 6, previewPath, recipe: createDefaultRecipe(), createdAt: 2 });
    storage.close();
    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE edits SET recipe_json = ? WHERE frame_id = ?').run('{invalid-json', 'frame');
    database.close();
    const reopened = new Storage(databasePath);
    expect(reopened.listFrames('roll')).toHaveLength(1);
    expect(reopened.getFrame('frame')!.recipe.algorithmVersion).toBe('chromik-6');
    reopened.close();
  });

  it('finds duplicate originals and relocates every reference atomically', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, Buffer.alloc(8));
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    storage.createRoll('roll', { name: 'Test roll', filmType: 'color_negative' }, 1);
    const recipe = createDefaultRecipe();
    const relocated = path.join(directory, 'relocated.tif');
    writeFileSync(relocated, Buffer.alloc(8));
    storage.addAsset({
      id: 'asset-duplicate', rollId: 'roll', name: 'source.tif', sourcePath,
      sourceFingerprint: 'v2:8:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      width: 100, height: 80, format: 'TIFF', fileSize: 8, previewPath, kind: 'single', createdAt: 20,
    });
    storage.addFrame({
      id: 'frame-duplicate', rollId: 'roll', assetId: 'asset-duplicate', name: 'source.tif', sourcePath,
      sourceFingerprint: 'v2:8:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      width: 100, height: 80, format: 'TIFF', fileSize: 8, previewPath, recipe, createdAt: 21,
    });
    const duplicate = storage.findSourceByFingerprint('v2:8:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(duplicate).toMatchObject({ sourcePath, assetCount: 1, frameCount: 1 });
    expect(storage.relocateSource(sourcePath, relocated, duplicate!.sourceFingerprint)).toEqual({ assets: 1, frames: 1 });
    expect(storage.getAsset('asset-duplicate')?.sourcePath).toBe(relocated);
    expect(storage.getFrame('frame-duplicate')?.sourcePath).toBe(relocated);
    storage.close();
  });

  it('keeps a missing original visible and returns it to ready after relinking', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.tif');
    const relocatedPath = path.join(directory, 'relocated.tif');
    const previewPath = path.join(directory, 'preview.jpg');
    writeFileSync(sourcePath, Buffer.alloc(8));
    writeFileSync(previewPath, 'preview');
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    storage.createRoll('roll', { name: 'Missing source roll', filmType: 'color_negative' }, 1);
    storage.addFrame({
      id: 'frame', rollId: 'roll', name: 'source.tif', sourcePath, sourceFingerprint: 'fingerprint',
      width: 100, height: 80, format: 'TIFF', fileSize: 8, previewPath, recipe: createDefaultRecipe(), createdAt: 2,
    });

    unlinkSync(sourcePath);
    expect(storage.getFrame('frame')).toMatchObject({ id: 'frame', status: 'missing' });

    writeFileSync(relocatedPath, Buffer.alloc(8));
    expect(storage.relocateSource(sourcePath, relocatedPath, 'fingerprint')).toEqual({ assets: 0, frames: 1 });
    expect(storage.getFrame('frame')).toMatchObject({ sourcePath: relocatedPath, status: 'ready' });
    storage.close();
  });
});

describe('Storage develop cache state bookkeeping', () => {
  it('records version and checksum, marks damage and counts rebuilds', () => {
    const directory = temporaryDirectory();
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    const filePath = path.join(directory, 'asset-v4.chpx');

    storage.recordCacheState({ path: filePath, kind: 'asset', subjectId: 'asset', version: 4, size: 1234, checksum: 'deadbeef' }, 10);
    expect(storage.getCacheState(filePath)).toMatchObject({
      kind: 'asset', subjectId: 'asset', version: 4, size: 1234, checksum: 'deadbeef', status: 'valid', rebuildCount: 0, lastValidatedAt: 10,
    });

    // 同路径重复写入且状态未受损：重建计数不动。
    storage.recordCacheState({ path: filePath, kind: 'asset', subjectId: 'asset', version: 4, size: 1234, checksum: 'deadbeef' }, 11);
    expect(storage.getCacheState(filePath)?.rebuildCount).toBe(0);

    // 损坏 → 重建：状态回到 valid，rebuild_count 恰好 +1。
    storage.markCacheDamaged({ path: filePath, kind: 'asset', subjectId: 'asset' }, 12);
    expect(storage.getCacheState(filePath)?.status).toBe('damaged');
    storage.recordCacheState({ path: filePath, kind: 'asset', subjectId: 'asset', version: 4, size: 1234, checksum: 'deadbeef' }, 13);
    const rebuilt = storage.getCacheState(filePath);
    expect(rebuilt).toMatchObject({ status: 'valid', rebuildCount: 1, lastValidatedAt: 13 });
    expect(storage.listCacheStates()).toHaveLength(1);

    storage.deleteCacheStates([filePath, path.join(directory, 'never-tracked.chpx')]);
    expect(storage.getCacheState(filePath)).toBeUndefined();
    storage.close();
  });

  it('markCacheValidated refreshes timestamps without losing rebuild history', () => {
    const directory = temporaryDirectory();
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    const filePath = path.join(directory, 'frame-42-v4.chpx');
    storage.recordCacheState({ path: filePath, kind: 'frame', subjectId: 'frame-42', version: 4, size: 64, checksum: '0badc0de' }, 1);
    storage.markCacheDamaged({ path: filePath, kind: 'frame', subjectId: 'frame-42' }, 2);
    storage.recordCacheState({ path: filePath, kind: 'frame', subjectId: 'frame-42', version: 4, size: 64, checksum: '0badc0de' }, 3);
    storage.markCacheValidated({ path: filePath, kind: 'frame', subjectId: 'frame-42' }, 4);
    expect(storage.getCacheState(filePath)).toMatchObject({ status: 'valid', rebuildCount: 1, lastValidatedAt: 4 });

    // 从未入库的路径被校验通过：补一条零值 valid 记录。
    const legacy = path.join(directory, 'legacy-v4.chpx');
    storage.markCacheValidated({ path: legacy, kind: 'asset', subjectId: 'asset',  }, 5);
    expect(storage.getCacheState(legacy)).toMatchObject({ status: 'valid', version: 0, rebuildCount: 0 });
    storage.close();
  });
});

describe('Storage schema versioning and recovery bookkeeping', () => {
  it('sets user_version and does not snapshot an already-current database', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'library.sqlite');
    const storage = new Storage(databasePath);
    storage.createRoll('roll', { name: 'Test roll', filmType: 'color_negative' }, 1);
    const version = (storage as unknown as { database: unknown }).database;
    expect(version).toBeDefined();
    storage.close();
    const raw = new DatabaseSync(databasePath);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    raw.close();
    // 已是当前版本：再次打开不得产生 pre-upgrade 快照。
    const reopened = new Storage(databasePath);
    expect(existsSync(path.join(directory, 'backups', 'pre-upgrade'))).toBe(false);
    reopened.close();
  });

  it('snapshots the database before a structure migration', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'library.sqlite');
    // 先造一个"旧版本"库：user_version=0 且含数据。
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("CREATE TABLE rolls (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO rolls VALUES ('legacy', 'Old');");
    legacy.exec('PRAGMA user_version = 0');
    legacy.close();
    const storage = new Storage(databasePath);
    storage.close();
    const snapshots = readdirSync(path.join(directory, 'backups', 'pre-upgrade'));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]).toMatch(/^v0-\d+$/);
  });

  it('records damaged-recipe fallbacks and recognition errors persistently', () => {
    const directory = temporaryDirectory();
    const storage = new Storage(path.join(directory, 'library.sqlite'));
    storage.recordRecoveryIssue('frame-a', 'Expected property name');
    expect(storage.recoveryIssueCount()).toBe(1);
    expect(storage.listRecoveryIssues()[0]).toMatchObject({ frameId: 'frame-a' });

    storage.createRoll('roll-x', { name: 'Recognition roll', filmType: 'color_negative' }, 1);
    storage.setRecognitionError('roll-x', '片种识别置信度不足');
    expect(storage.getRecognitionError('roll-x')).toBe('片种识别置信度不足');
    storage.setRecognitionError('roll-x', '');
    expect(storage.getRecognitionError('roll-x')).toBe('');
    expect(storage.getRoll('roll-x')?.recognitionError).toBeUndefined();
    storage.setRecognitionError('roll-x', '再次失败');
    expect(storage.getRoll('roll-x')?.recognitionError).toBe('再次失败');
    storage.close();
  });
});
