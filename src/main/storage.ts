import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AssetExif, AssetKind, AssetSummary, EditRecipe, FilmType, FrameSummary, FrameStatus, PasteScope, RecipePreset, RollCalibration, RollInput, RollSummary,
} from '../shared/types';
import { createDefaultRecipe, migrateCalibration, migrateRecipe } from '../shared/defaults';
import { filmResponseProfileForType } from '../shared/film-response-profiles';

interface FrameRow {
  id: string;
  roll_id: string;
  asset_id: string | null;
  frame_number: number;
  name: string;
  source_path: string;
  width: number;
  height: number;
  format: string;
  file_size: number;
  status: FrameStatus;
  preview_path: string;
  recipe_json: string;
  preview_updated_at: number;
  created_at: number;
  starred: number;
  tags: string;
}

interface AssetRow {
  id: string;
  roll_id: string;
  name: string;
  source_path: string;
  width: number;
  height: number;
  format: string;
  file_size: number;
  status: FrameStatus;
  preview_path: string;
  kind: AssetKind;
  frame_count: number;
  created_at: number;
  preview_updated_at: number;
  exif: string | null;
}

interface RollRow {
  id: string;
  name: string;
  filmType: FilmType;
  camera: string;
  lens: string;
  filmStock: string;
  iso: number | null;
  development: string;
  shotDate: string;
  notes: string;
  edgeText: string;
  calibrationJson: string;
  assetCount: number;
  frameCount: number;
  createdAt: number;
  starred: number;
  tags: string;
  recognitionError?: string;
}

export interface SourceReference {
  sourcePath: string;
  sourceFingerprint: string;
  fileSize: number;
  assetCount: number;
  frameCount: number;
  displayName: string;
}

export interface CacheStateRow {
  path: string;
  kind: 'asset' | 'frame';
  subjectId: string;
  version: number;
  size: number;
  checksum: string;
  status: 'valid' | 'damaged';
  rebuildCount: number;
  lastValidatedAt: number;
  updatedAt: number;
}

interface CacheStateSqlRow {
  path: string;
  kind: string;
  subject_id: string;
  version: number;
  size: number;
  checksum: string;
  status: string;
  rebuild_count: number;
  last_validated_at: number;
  updated_at: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** SQLite 结构版本（PRAGMA user_version）。结构迁移前必须快照，迁移后递增。 */
export const STORAGE_SCHEMA_VERSION = 1;

export interface RecoveryIssueRow {
  id: string;
  frameId: string;
  error: string;
  createdAt: number;
}

export class Storage {
  private readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly schemaVersion: number = STORAGE_SCHEMA_VERSION;
  /** BUG-025：源文件状态短期缓存，避免每次列图库都对每行做同步 stat 阻塞主进程。 */
  private readonly sourceStatusCache = new Map<string, { status: FrameStatus; checkedAt: number }>();
  private static readonly SOURCE_STATUS_TTL_MS = 3_000;
  private static readonly SOURCE_STATUS_MAX_ENTRIES = 20_000;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.snapshotBeforeStructureMigration();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rolls (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        film_type TEXT NOT NULL DEFAULT 'color_negative',
        camera TEXT NOT NULL DEFAULT '',
        lens TEXT NOT NULL DEFAULT '',
        film_stock TEXT NOT NULL DEFAULT '',
        iso INTEGER,
        development TEXT NOT NULL DEFAULT '',
        shot_date TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        edge_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        starred INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        roll_id TEXT NOT NULL REFERENCES rolls(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        format TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'unknown',
        exif TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY,
        roll_id TEXT NOT NULL REFERENCES rolls(id) ON DELETE CASCADE,
        asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        frame_number INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        format TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        starred INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS edits (
        frame_id TEXT PRIMARY KEY REFERENCES frames(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        algorithm_version TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grade TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache_state (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'valid',
        rebuild_count INTEGER NOT NULL DEFAULT 0,
        last_validated_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_log (
        id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn('rolls', 'film_type', "TEXT NOT NULL DEFAULT 'color_negative'");
    this.ensureColumn('rolls', 'camera', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'lens', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'film_stock', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'iso', 'INTEGER');
    this.ensureColumn('rolls', 'development', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'shot_date', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'notes', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'edge_text', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'calibration_json', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('rolls', 'starred', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('rolls', 'tags', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('rolls', 'recognition_error', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('assets', 'exif', 'TEXT');
    this.ensureColumn('assets', 'preview_updated_at', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('frames', 'asset_id', 'TEXT');
    this.ensureColumn('frames', 'frame_number', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('frames', 'preview_updated_at', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('frames', 'starred', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('frames', 'tags', "TEXT NOT NULL DEFAULT '[]'");
    this.database.exec('UPDATE frames SET preview_updated_at = created_at WHERE preview_updated_at = 0; UPDATE assets SET preview_updated_at = created_at WHERE preview_updated_at = 0;');
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_assets_roll ON assets(roll_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_frames_roll ON frames(roll_id, frame_number, created_at);
      CREATE INDEX IF NOT EXISTS idx_frames_asset ON frames(asset_id, frame_number);
    `);
    // The frame→asset migration only runs when both tables exist and the
    // data was created before the split. Wrap each step so a single bad
    // row cannot leave the library in a half-migrated state on next boot.
    this.database.exec('BEGIN');
    try {
      this.database.exec(`
        INSERT OR IGNORE INTO assets (
          id, roll_id, name, source_path, source_fingerprint, width, height,
          format, file_size, status, preview_path, kind, created_at
        )
        SELECT id, roll_id, name, source_path, source_fingerprint, width, height,
          format, file_size, status, preview_path, 'single', created_at
        FROM frames WHERE asset_id IS NULL;
        UPDATE frames SET asset_id = id WHERE asset_id IS NULL;
      `);
      this.database.exec('COMMIT');
    } catch (migrationError) {
      this.database.exec('ROLLBACK');
      console.warn('Chromik: 历史帧→素材迁移失败，已跳过。请联系支持。', migrationError);
    }
    try {
      for (const row of this.database.prepare('SELECT id FROM rolls').all() as Array<{ id: string }>) this.renumberRollFrames(row.id);
    } catch (renumberError) {
      console.warn('Chromik: 帧号回填失败', renumberError);
    }
    this.database.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
  }

  /**
   * REL-03：结构迁移前快照。若 user_version 与当前不一致且库中已有数据，
   * 先 checkpoint 并把数据库文件原子复制到 backups/pre-upgrade/<旧版本>-<时间>/。
   * 迁移失败或新版有问题时，用户可从该快照回滚。
   */
  private snapshotBeforeStructureMigration(): void {
    try {
      const current = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (current === STORAGE_SCHEMA_VERSION) return;
      const hasLibrary = (this.database.prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rolls'",
      ).get() as { count: number }).count > 0;
      if (!hasLibrary) return; // 全新数据库无需快照
      this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      const directory = path.join(path.dirname(this.databasePath), 'backups', 'pre-upgrade', `v${current}-${Date.now()}`);
      mkdirSync(directory, { recursive: true });
      copyFileSync(this.databasePath, path.join(directory, 'library.sqlite'));
      console.log(`Chromik: 结构升级前快照已保存（v${current} → v${STORAGE_SCHEMA_VERSION}）`, directory);
    } catch (error) {
      console.warn('Chromik: 结构升级前快照失败，继续启动（迁移已受事务保护）', error);
    }
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }

  close(): void {
    this.database.close();
  }

  checkpoint(): void {
    this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  }

  /** DATA-01：记录一次损坏配方回退（同一画面重复损坏只更新不重复计）。 */
  recordRecoveryIssue(frameId: string, error: string, createdAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO recovery_log (id, frame_id, error, created_at)
      VALUES (@id, @frameId, @error, @createdAt)
      ON CONFLICT(id) DO UPDATE SET error = excluded.error, created_at = excluded.created_at
    `).run({ id: `frame:${frameId}`, frameId, error, createdAt });
  }

  listRecoveryIssues(): RecoveryIssueRow[] {
    return this.database.prepare('SELECT id, frame_id AS frameId, error, created_at AS createdAt FROM recovery_log ORDER BY created_at DESC LIMIT 200')
      .all() as unknown as RecoveryIssueRow[];
  }

  recoveryIssueCount(): number {
    return (this.database.prepare('SELECT count(*) AS count FROM recovery_log').get() as { count: number }).count;
  }

  /** AUTO-06：持久化最近一次识别失败原因（成功识别时清空）。 */
  setRecognitionError(rollId: string, error: string): void {
    this.database.prepare('UPDATE rolls SET recognition_error = ? WHERE id = ?').run(error, rollId);
  }

  getRecognitionError(rollId: string): string {
    const row = this.database.prepare('SELECT recognition_error FROM rolls WHERE id = ?').get(rollId) as { recognition_error?: string } | undefined;
    return row?.recognition_error ?? '';
  }

  /**
   * 记录一次开发代理缓存写入：版本、大小与载荷校验和（§16.3 要求的
   * "数据库记录版本和校验"）。同一路径重复写入时若上一条记录是 damaged，
   * 重建计数 +1 —— 这是 QA-06 故障注入的审计证据来源。
   */
  recordCacheState(input: {
    path: string;
    kind: 'asset' | 'frame';
    subjectId: string;
    version: number;
    size: number;
    checksum: string;
  }, updatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO cache_state (path, kind, subject_id, version, size, checksum, status, rebuild_count, last_validated_at, updated_at)
      VALUES (@path, @kind, @subjectId, @version, @size, @checksum, 'valid', 0, @updatedAt, @updatedAt)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        subject_id = excluded.subject_id,
        version = excluded.version,
        size = excluded.size,
        checksum = excluded.checksum,
        status = 'valid',
        rebuild_count = cache_state.rebuild_count + CASE WHEN cache_state.status = 'damaged' THEN 1 ELSE 0 END,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at
    `).run({
      path: input.path, kind: input.kind, subjectId: input.subjectId, version: input.version,
      size: input.size, checksum: input.checksum, updatedAt,
    });
  }

  /** 校验失败时标记：缓存文件已被移除，等待按需重建。 */
  markCacheDamaged(input: { path: string; kind: 'asset' | 'frame'; subjectId: string }, updatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO cache_state (path, kind, subject_id, version, size, checksum, status, rebuild_count, last_validated_at, updated_at)
      VALUES (@path, @kind, @subjectId, 0, 0, '', 'damaged', 0, 0, @updatedAt)
      ON CONFLICT(path) DO UPDATE SET status = 'damaged', updated_at = @updatedAt
    `).run({ path: input.path, kind: input.kind, subjectId: input.subjectId, updatedAt });
  }

  /** 全量校验通过时刷新时间戳（若该路径从未入库，则以零值补一条 valid 记录）。 */
  markCacheValidated(input: { path: string; kind: 'asset' | 'frame'; subjectId: string }, validatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO cache_state (path, kind, subject_id, version, size, checksum, status, rebuild_count, last_validated_at, updated_at)
      VALUES (@path, @kind, @subjectId, 0, 0, '', 'valid', 0, @validatedAt, @validatedAt)
      ON CONFLICT(path) DO UPDATE SET status = 'valid', last_validated_at = @validatedAt, updated_at = @validatedAt
    `).run({ path: input.path, kind: input.kind, subjectId: input.subjectId, validatedAt });
  }

  listCacheStates(): CacheStateRow[] {
    return (this.database.prepare('SELECT * FROM cache_state ORDER BY path').all() as unknown as CacheStateSqlRow[])
      .map((row) => this.toCacheStateRow(row));
  }

  getCacheState(path: string): CacheStateRow | undefined {
    const row = this.database.prepare('SELECT * FROM cache_state WHERE path = ?').get(path) as unknown as CacheStateSqlRow | undefined;
    return row ? this.toCacheStateRow(row) : undefined;
  }

  /** 缓存文件被删除（清缓存 / 删除画面与素材）时同步移除簿记，避免孤儿记录。 */
  deleteCacheStates(paths: string[]): void {
    for (const chunk of chunkArray(paths, 100)) {
      const placeholders = chunk.map(() => '?').join(', ');
      this.database.prepare(`DELETE FROM cache_state WHERE path IN (${placeholders})`).run(...chunk);
    }
  }

  createRoll(id: string, input: RollInput, createdAt: number): void {
    this.database.prepare(`
      INSERT INTO rolls (
        id, name, film_type, camera, lens, film_stock, iso, development, shot_date, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.filmType, input.camera ?? '', input.lens ?? '', input.filmStock ?? '',
      input.iso ?? null, input.development ?? '', input.shotDate ?? '', input.notes ?? '', createdAt,
    );
  }

  updateRoll(id: string, input: RollInput, edgeText?: string): void {
    const previous = this.database.prepare('SELECT film_type AS filmType, film_stock AS filmStock FROM rolls WHERE id = ?').get(id) as unknown as { filmType: FilmType; filmStock: string } | undefined;
    if (!previous) throw new Error('找不到胶卷');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE rolls SET name = ?, film_type = ?, camera = ?, lens = ?, film_stock = ?, iso = ?,
          development = ?, shot_date = ?, notes = ?, edge_text = COALESCE(?, edge_text) WHERE id = ?
      `).run(
        input.name, input.filmType, input.camera ?? '', input.lens ?? '', input.filmStock ?? '', input.iso ?? null,
        input.development ?? '', input.shotDate ?? '', input.notes ?? '', edgeText ?? null, id,
      );
      if (previous.filmType !== input.filmType) {
        const negative = input.filmType === 'color_negative' || input.filmType === 'bw_negative';
        const blackAndWhite = input.filmType === 'bw_negative' || input.filmType === 'bw_slide';
        const calibrationRow = this.database.prepare('SELECT calibration_json AS calibrationJson FROM rolls WHERE id = ?').get(id) as unknown as { calibrationJson: string };
        let calibrationInput: unknown;
        try { calibrationInput = calibrationRow.calibrationJson ? JSON.parse(calibrationRow.calibrationJson) : undefined; } catch { calibrationInput = undefined; }
        const calibration = migrateCalibration(calibrationInput, input.filmType);
        calibration.density.filmProfileId = filmResponseProfileForType(input.filmType);
        // Preserve the saved negative conversion while a roll is temporarily
        // viewed as positive; switching back must restore the previous result.
        calibration.updatedAt = Date.now();
        this.database.prepare('UPDATE rolls SET calibration_json = ? WHERE id = ?').run(JSON.stringify(calibration), id);
        const statement = this.database.prepare('UPDATE edits SET schema_version = ?, algorithm_version = ?, recipe_json = ?, updated_at = ? WHERE frame_id = ?');
        for (const frame of this.listFrames(id)) {
          const recipe: EditRecipe = {
            ...frame.recipe,
            baseRgb: negative ? calibration.baseRgb ?? frame.recipe.baseRgb : undefined,
            baseRgbLinear: negative ? calibration.baseRgbLinear ?? frame.recipe.baseRgbLinear : undefined,
            density: { ...frame.recipe.density, ...calibration.density, enabled: negative && calibration.density.enabled },
            grade: { ...frame.recipe.grade, blackAndWhite },
            updatedAt: Date.now(),
          };
          statement.run(recipe.schemaVersion, recipe.algorithmVersion, JSON.stringify(recipe), recipe.updatedAt, frame.id);
        }
      }
      if (previous.filmStock !== (input.filmStock ?? '')) {
        // The film-stock name changed, so any saved per-stock profile id is
        // stale. Clear it (and the frame copies) so the renderer re-suggests a
        // matching profile from the new name; the user can still pick one
        // manually in the calibration panel.
        const calibrationRow = this.database.prepare('SELECT calibration_json AS calibrationJson FROM rolls WHERE id = ?').get(id) as unknown as { calibrationJson: string };
        try {
          const calibration = calibrationRow.calibrationJson ? JSON.parse(calibrationRow.calibrationJson) as RollCalibration : undefined;
          if (calibration?.density?.filmStockProfileId) {
            delete calibration.density.filmStockProfileId;
            this.database.prepare('UPDATE rolls SET calibration_json = ? WHERE id = ?').run(JSON.stringify(calibration), id);
          }
        } catch { /* ignore malformed calibration */ }
        const frameStatement = this.database.prepare('UPDATE edits SET recipe_json = ?, updated_at = ? WHERE frame_id = ?');
        for (const frame of this.listFrames(id)) {
          const recipe: EditRecipe = { ...frame.recipe, updatedAt: Date.now() };
          delete recipe.density.filmStockProfileId;
          frameStatement.run(JSON.stringify(recipe), recipe.updatedAt, frame.id);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getRoll(id: string): RollSummary | undefined {
    return this.listRolls().find((roll) => roll.id === id);
  }

  listRolls(): RollSummary[] {
    const rows = this.database.prepare(`
      SELECT r.id, r.name, r.film_type AS filmType, r.camera, r.lens, r.film_stock AS filmStock,
        r.iso, r.development, r.shot_date AS shotDate, r.notes, r.edge_text AS edgeText,
        r.calibration_json AS calibrationJson,
        (SELECT COUNT(*) FROM assets a WHERE a.roll_id = r.id) AS assetCount,
        (SELECT COUNT(*) FROM frames f WHERE f.roll_id = r.id) AS frameCount,
        r.created_at AS createdAt,
        r.starred,
        r.tags,
        r.recognition_error AS recognitionError
      FROM rolls r ORDER BY r.created_at DESC
    `).all() as unknown as RollRow[];
    return rows.map((row) => {
      let stored: unknown;
      try { stored = row.calibrationJson ? JSON.parse(row.calibrationJson) : undefined; } catch { stored = undefined; }
      const { calibrationJson: _calibrationJson, starred, tags, recognitionError, ...summary } = row;
      return {
        ...summary,
        iso: row.iso ?? undefined,
        starred: starred === 1,
        tags: this.parseStringArray(tags),
        recognitionError: recognitionError || undefined,
        calibration: migrateCalibration(stored, row.filmType),
      };
    });
  }

  saveRollCalibration(id: string, calibration: RollCalibration): string[] {
    const roll = this.getRoll(id);
    if (!roll) throw new Error('找不到胶卷');
    const negative = roll.filmType === 'color_negative' || roll.filmType === 'bw_negative';
    const stored: RollCalibration = {
      baseRgb: calibration.baseRgb,
      baseRgbLinear: calibration.baseRgbLinear,
      density: { ...calibration.density, enabled: negative && calibration.density.enabled },
      updatedAt: Date.now(),
    };
    const frames = this.listFrames(id);
    const previous = roll.calibration;
    // Roll calibration is inherited, not an unconditional batch overwrite.
    // Frames whose density/base no longer match the previous roll calibration
    // contain per-photo work and must be preserved.
    // BUG-010：比较使用键序无关的规范化序列化，避免对象键序差异导致
    // “看起来相同”的帧不再继承整卷校准。
    const framesToUpdate = frames.filter((frame) => {
      // A frame with no base sample and inversion disabled is still
      // uncalibrated. Treat it as inheriting the roll even if a newer app
      // version changed the default rendering intent; otherwise such legacy
      // frames would never receive their first real roll calibration.
      const uncalibrated = !frame.recipe.density.enabled
        && frame.recipe.baseRgb === undefined
        && frame.recipe.baseRgbLinear === undefined;
      const inherited = JSON.stringify(frame.recipe.baseRgb) === JSON.stringify(previous.baseRgb)
        && JSON.stringify(frame.recipe.baseRgbLinear) === JSON.stringify(previous.baseRgbLinear)
        && this.canonicalDensity(frame.recipe.density) === this.canonicalDensity(previous.density);
      return uncalibrated || inherited;
    });
    const statement = this.database.prepare('UPDATE edits SET schema_version = ?, algorithm_version = ?, recipe_json = ?, updated_at = ? WHERE frame_id = ?');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE rolls SET calibration_json = ? WHERE id = ?').run(JSON.stringify(stored), id);
      for (const frame of framesToUpdate) {
        const recipe: EditRecipe = {
          ...frame.recipe,
          baseRgb: stored.baseRgb,
          baseRgbLinear: stored.baseRgbLinear,
          density: { ...stored.density },
          updatedAt: stored.updatedAt,
        };
        statement.run(recipe.schemaVersion, recipe.algorithmVersion, JSON.stringify(recipe), stored.updatedAt, frame.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return framesToUpdate.map((frame) => frame.id);
  }

  deleteRoll(id: string): string[] {
    const paths = this.database.prepare(`
      SELECT preview_path AS path FROM assets WHERE roll_id = ?
      UNION SELECT preview_path AS path FROM frames WHERE roll_id = ?
    `).all(id, id) as Array<{ path: string }>;
    this.database.prepare('DELETE FROM rolls WHERE id = ?').run(id);
    this.sourceStatusCache.clear();
    return paths.map((row) => row.path);
  }

  addAsset(input: {
    id: string;
    rollId: string;
    name: string;
    sourcePath: string;
    sourceFingerprint: string;
    width: number;
    height: number;
    format: string;
    fileSize: number;
    previewPath: string;
    kind: AssetKind;
    exif?: AssetExif;
    createdAt: number;
  }): void {
    this.sourceStatusCache.delete(input.sourcePath);
    this.database.prepare(`
      INSERT INTO assets (
        id, roll_id, name, source_path, source_fingerprint, width, height,
        format, file_size, status, preview_path, kind, exif, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
    `).run(
      input.id, input.rollId, input.name, input.sourcePath, input.sourceFingerprint, input.width,
      input.height, input.format, input.fileSize, input.previewPath, input.kind,
      input.exif ? JSON.stringify(input.exif) : null, input.createdAt,
    );
  }

  listAssets(rollId: string): AssetSummary[] {
    const rows = this.database.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM frames f WHERE f.asset_id = a.id) AS frame_count
      FROM assets a WHERE a.roll_id = ? ORDER BY a.created_at ASC
    `).all(rollId) as unknown as AssetRow[];
    return rows.map((row) => this.toAssetSummary(row));
  }

  getAsset(id: string): AssetSummary | undefined {
    const row = this.database.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM frames f WHERE f.asset_id = a.id) AS frame_count
      FROM assets a WHERE a.id = ?
    `).get(id) as unknown as AssetRow | undefined;
    return row ? this.toAssetSummary(row) : undefined;
  }

  getAssetPaths(id: string): { sourcePath: string; previewPath: string } | undefined {
    return this.database.prepare('SELECT source_path AS sourcePath, preview_path AS previewPath FROM assets WHERE id = ?').get(id) as unknown as { sourcePath: string; previewPath: string } | undefined;
  }

  findSourceByFingerprint(sourceFingerprint: string): SourceReference | undefined {
    return this.listSourceReferences().find((item) => item.sourceFingerprint === sourceFingerprint);
  }

  listSourceReferences(): SourceReference[] {
    return this.database.prepare(`
      SELECT source_path AS sourcePath, source_fingerprint AS sourceFingerprint,
        MAX(file_size) AS fileSize,
        SUM(CASE WHEN source_kind = 'asset' THEN 1 ELSE 0 END) AS assetCount,
        SUM(CASE WHEN source_kind = 'frame' THEN 1 ELSE 0 END) AS frameCount,
        MIN(name) AS displayName
      FROM (
        SELECT source_path, source_fingerprint, file_size, name, 'asset' AS source_kind FROM assets
        UNION ALL
        SELECT source_path, source_fingerprint, file_size, name, 'frame' AS source_kind FROM frames
      )
      GROUP BY source_path, source_fingerprint
      ORDER BY source_path
    `).all() as unknown as SourceReference[];
  }

  /** Updates every asset/frame that references one original as one transaction. */
  relocateSource(oldPath: string, newPath: string, expectedFingerprint: string, newFingerprint = expectedFingerprint): { assets: number; frames: number } {
    const fileSize = statSync(newPath).size;
    this.sourceStatusCache.delete(oldPath);
    this.sourceStatusCache.delete(newPath);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const assets = this.database.prepare(`
        UPDATE assets SET source_path = ?, source_fingerprint = ?, file_size = ?, status = 'ready'
        WHERE source_path = ? AND source_fingerprint = ?
      `).run(newPath, newFingerprint, fileSize, oldPath, expectedFingerprint).changes;
      const frames = this.database.prepare(`
        UPDATE frames SET source_path = ?, source_fingerprint = ?, file_size = ?, status = 'ready'
        WHERE source_path = ? AND source_fingerprint = ?
      `).run(newPath, newFingerprint, fileSize, oldPath, expectedFingerprint).changes;
      this.database.exec('COMMIT');
      return { assets: Number(assets), frames: Number(frames) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  updateAssetKind(id: string, kind: AssetKind): void {
    this.database.prepare('UPDATE assets SET kind = ? WHERE id = ?').run(kind, id);
  }

  touchAssetPreview(id: string, updatedAt = Date.now()): void {
    this.database.prepare('UPDATE assets SET preview_updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  deleteAssets(ids: string[]): string[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const paths = this.database.prepare(`
      SELECT preview_path AS path FROM assets WHERE id IN (${placeholders})
      UNION SELECT preview_path AS path FROM frames WHERE asset_id IN (${placeholders})
    `).all(...ids, ...ids) as Array<{ path: string }>;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`DELETE FROM frames WHERE asset_id IN (${placeholders})`).run(...ids);
      this.database.prepare(`DELETE FROM assets WHERE id IN (${placeholders})`).run(...ids);
      this.database.exec('COMMIT');
      this.sourceStatusCache.clear();
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const rollIds = this.database.prepare('SELECT id FROM rolls').all() as Array<{ id: string }>;
    for (const roll of rollIds) this.renumberRollFrames(roll.id);
    return paths.map((row) => row.path);
  }

  addFrame(input: {
    id: string;
    rollId: string;
    assetId?: string;
    frameNumber?: number;
    name: string;
    sourcePath: string;
    sourceFingerprint: string;
    width: number;
    height: number;
    format: string;
    fileSize: number;
    previewPath: string;
    recipe: EditRecipe;
    createdAt: number;
  }): void {
    this.sourceStatusCache.delete(input.sourcePath);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO frames (
          id, roll_id, asset_id, frame_number, name, source_path, source_fingerprint, width, height,
          format, file_size, status, preview_path, preview_updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
      `).run(
        input.id, input.rollId, input.assetId ?? null, input.frameNumber ?? 0, input.name, input.sourcePath,
        input.sourceFingerprint, input.width, input.height, input.format, input.fileSize, input.previewPath, input.createdAt, input.createdAt,
      );
      this.database.prepare(`
        INSERT INTO edits (frame_id, schema_version, algorithm_version, recipe_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.id, input.recipe.schemaVersion, input.recipe.algorithmVersion, JSON.stringify(input.recipe), input.recipe.updatedAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listFrames(rollId?: string): FrameSummary[] {
    const rows = (rollId
      ? this.database.prepare(`
          SELECT frames.*, edits.recipe_json FROM frames
          JOIN edits ON edits.frame_id = frames.id WHERE frames.roll_id = ?
          ORDER BY frames.frame_number ASC, frames.created_at ASC
        `).all(rollId)
      : this.database.prepare(`
          SELECT frames.*, edits.recipe_json FROM frames JOIN edits ON edits.frame_id = frames.id
          ORDER BY frames.roll_id, frames.frame_number ASC, frames.created_at ASC
        `).all()) as unknown as FrameRow[];
    return rows.map((row) => this.toFrameSummary(row));
  }

  listFramesForAsset(assetId: string): FrameSummary[] {
    const rows = this.database.prepare(`
      SELECT frames.*, edits.recipe_json FROM frames JOIN edits ON edits.frame_id = frames.id
      WHERE frames.asset_id = ? ORDER BY frames.frame_number ASC, frames.created_at ASC
    `).all(assetId) as unknown as FrameRow[];
    return rows.map((row) => this.toFrameSummary(row));
  }

  getFrame(id: string): FrameSummary | undefined {
    const row = this.database.prepare(`
      SELECT frames.*, edits.recipe_json FROM frames JOIN edits ON edits.frame_id = frames.id WHERE frames.id = ?
    `).get(id) as unknown as FrameRow | undefined;
    return row ? this.toFrameSummary(row) : undefined;
  }

  getFramePaths(id: string): { sourcePath: string; previewPath: string } | undefined {
    return this.database.prepare('SELECT source_path AS sourcePath, preview_path AS previewPath FROM frames WHERE id = ?').get(id) as unknown as { sourcePath: string; previewPath: string } | undefined;
  }

  deleteFrames(ids: string[]): string[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT preview_path AS path, roll_id AS rollId FROM frames WHERE id IN (${placeholders})`).all(...ids) as unknown as Array<{ path: string; rollId: string }>;
    this.database.prepare(`DELETE FROM frames WHERE id IN (${placeholders})`).run(...ids);
    this.sourceStatusCache.clear();
    for (const rollId of new Set(rows.map((row) => row.rollId))) this.renumberRollFrames(rollId);
    return rows.map((row) => row.path);
  }

  saveRecipe(frameId: string, recipe: EditRecipe): number {
    // BUG-012：updatedAt 需按帧单调递增，避免同一毫秒两次保存产生相同
    // 缩略图 URL/缓存键，导致图库持续显示旧缩略图。
    const savedAt = Math.max(Date.now(), this.nextRecipeUpdatedAt(frameId) + 1);
    const stored = { ...recipe, updatedAt: savedAt };
    const result = this.database.prepare(`
      UPDATE edits SET schema_version = ?, algorithm_version = ?, recipe_json = ?, updated_at = ? WHERE frame_id = ?
    `).run(stored.schemaVersion, stored.algorithmVersion, JSON.stringify(stored), savedAt, frameId);
    if (result.changes !== 1) throw new Error('找不到要保存的画面');
    return savedAt;
  }

  updateFramePreview(frameId: string, previewPath: string, name?: string): void {
    this.database.prepare('UPDATE frames SET preview_path = ?, preview_updated_at = ?, name = COALESCE(?, name) WHERE id = ?')
      .run(previewPath, this.nextFramePreviewVersion(frameId), name ?? null, frameId);
  }

  updateFrameGeometry(frameId: string, input: {
    width: number;
    height: number;
    previewPath: string;
    name: string;
    recipe: EditRecipe;
  }): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const savedAt = Math.max(Date.now(), this.nextRecipeUpdatedAt(frameId) + 1);
      const previewVersion = this.nextFramePreviewVersion(frameId);
      this.database.prepare('UPDATE frames SET width = ?, height = ?, preview_path = ?, preview_updated_at = ?, name = ? WHERE id = ?')
        .run(input.width, input.height, input.previewPath, previewVersion, input.name, frameId);
      const recipe = { ...input.recipe, updatedAt: savedAt };
      this.database.prepare(`
        UPDATE edits SET schema_version = ?, algorithm_version = ?, recipe_json = ?, updated_at = ? WHERE frame_id = ?
      `).run(recipe.schemaVersion, recipe.algorithmVersion, JSON.stringify(recipe), savedAt, frameId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  copyRecipeToRoll(frameId: string): number {
    const source = this.getFrame(frameId);
    if (!source) throw new Error('找不到源画面');
    const frames = this.listFrames(source.rollId).filter((frame) => frame.id !== frameId);
    const statement = this.database.prepare(`
      UPDATE edits SET schema_version = ?, algorithm_version = ?, recipe_json = ?, updated_at = ? WHERE frame_id = ?
    `);
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const frame of frames) {
        const recipe: EditRecipe = {
          ...frame.recipe,
          grade: {
            ...source.recipe.grade,
            printerLights: [...source.recipe.grade.printerLights],
            vignette: { ...source.recipe.grade.vignette },
            cmy: { ...source.recipe.grade.cmy },
            curves: {
              rgb: source.recipe.grade.curves.rgb.map((point) => ({ ...point })),
              red: source.recipe.grade.curves.red.map((point) => ({ ...point })),
              green: source.recipe.grade.curves.green.map((point) => ({ ...point })),
              blue: source.recipe.grade.curves.blue.map((point) => ({ ...point })),
            },
          },
          updatedAt: now,
        };
        statement.run(recipe.schemaVersion, recipe.algorithmVersion, JSON.stringify(recipe), now, frame.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return frames.length;
  }

  setFrameMeta(frameId: string, meta: { starred?: boolean; tags?: string[] }): FrameSummary {
    const existing = this.getFrame(frameId);
    if (!existing) throw new Error('找不到画面');
    const starred = meta.starred ?? existing.starred ?? false;
    const tags = meta.tags ?? existing.tags ?? [];
    const result = this.database.prepare('UPDATE frames SET starred = ?, tags = ? WHERE id = ?')
      .run(starred ? 1 : 0, JSON.stringify(tags), frameId);
    if (result.changes !== 1) throw new Error('找不到画面');
    return this.getFrame(frameId)!;
  }

  setRollMeta(rollId: string, meta: { starred?: boolean; tags?: string[] }): RollSummary {
    const existing = this.getRoll(rollId);
    if (!existing) throw new Error('找不到胶卷');
    const starred = meta.starred ?? existing.starred ?? false;
    const tags = meta.tags ?? existing.tags ?? [];
    const result = this.database.prepare('UPDATE rolls SET starred = ?, tags = ? WHERE id = ?')
      .run(starred ? 1 : 0, JSON.stringify(tags), rollId);
    if (result.changes !== 1) throw new Error('找不到胶卷');
    return this.getRoll(rollId)!;
  }

  /**
   * Pastes the selected parts of a source grade onto several frames. Only the
   * grade is touched — crop/geometry/spots/baseRgb/density are never copied.
   * BUG-009：批量粘贴包进一个事务，中途失败全部回滚，避免“部分粘贴”。
   */
  pasteRecipeToFrames(frameIds: string[], source: EditRecipe, scope: PasteScope): number {
    const frames = frameIds.map((frameId) => this.getFrame(frameId)).filter((frame): frame is FrameSummary => Boolean(frame));
    if (!frames.length) return 0;
    let updated = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const frame of frames) {
        const recipe: EditRecipe = {
          ...frame.recipe,
          grade: this.mergeGrade(frame.recipe.grade, source.grade, scope),
        };
        this.saveRecipe(frame.id, recipe);
        updated += 1;
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return updated;
  }

  listPresets(): RecipePreset[] {
    const rows = this.database.prepare('SELECT id, name, grade, created_at AS createdAt FROM presets ORDER BY created_at ASC')
      .all() as Array<{ id: string; name: string; grade: string; createdAt: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      grade: this.parseGrade(row.grade),
      createdAt: row.createdAt,
    }));
  }

  savePreset(name: string, grade: EditRecipe['grade']): RecipePreset {
    const id = randomUUID();
    const createdAt = Date.now();
    const uniqueName = this.uniquePresetName(name);
    const stored = this.cloneGrade(grade);
    this.database.prepare('INSERT INTO presets (id, name, grade, created_at) VALUES (?, ?, ?, ?)')
      .run(id, uniqueName, JSON.stringify(stored), createdAt);
    return { id, name: uniqueName, grade: stored, createdAt };
  }

  deletePreset(id: string): void {
    this.database.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }

  renumberRollFrames(rollId: string): void {
    const rows = this.database.prepare('SELECT id FROM frames WHERE roll_id = ? ORDER BY created_at ASC, id ASC').all(rollId) as Array<{ id: string }>;
    const update = this.database.prepare('UPDATE frames SET frame_number = ? WHERE id = ?');
    for (const [index, row] of rows.entries()) update.run(index + 1, row.id);
  }

  relocateFrame(frameId: string, input: {
    sourcePath: string;
    sourceFingerprint: string;
    width: number;
    height: number;
    format: string;
    fileSize: number;
    previewPath: string;
    name: string;
  }): void {
    const previous = this.database.prepare('SELECT source_path AS sourcePath FROM frames WHERE id = ?').get(frameId) as { sourcePath: string } | undefined;
    if (previous) this.sourceStatusCache.delete(previous.sourcePath);
    this.sourceStatusCache.delete(input.sourcePath);
    this.database.prepare(`
      UPDATE frames SET source_path = ?, source_fingerprint = ?, width = ?, height = ?,
        format = ?, file_size = ?, preview_path = ?, preview_updated_at = ?, status = 'ready', name = ? WHERE id = ?
    `).run(
      input.sourcePath, input.sourceFingerprint, input.width, input.height, input.format,
      input.fileSize, input.previewPath, this.nextFramePreviewVersion(frameId), input.name, frameId,
    );
  }

  private nextFramePreviewVersion(frameId: string): number {
    const row = this.database.prepare('SELECT preview_updated_at AS version FROM frames WHERE id = ?')
      .get(frameId) as { version: number } | undefined;
    return Math.max(Date.now(), (row?.version ?? 0) + 1);
  }

  private nextRecipeUpdatedAt(frameId: string): number {
    const row = this.database.prepare('SELECT updated_at AS updatedAt FROM edits WHERE frame_id = ?')
      .get(frameId) as { updatedAt: number } | undefined;
    return row?.updatedAt ?? 0;
  }

  /** BUG-010：按固定键序规范化 density，避免 JSON.stringify 键序敏感的相等比较。 */
  private canonicalDensity(density: EditRecipe['density']): string {
    const {
      enabled, low, high, mode, profileId, filmProfileId, filmStockProfileId, filmStockProfileVersion,
      inputTransfer, separation, separationMatrix, neutralProtection, crossoverStrength,
      shadowCorrection, midCorrection, highlightCorrection, lightSourceRgb,
    } = density;
    return JSON.stringify({
      enabled, low, high, mode, profileId, filmProfileId, filmStockProfileId, filmStockProfileVersion,
      inputTransfer, separation, separationMatrix, neutralProtection, crossoverStrength,
      shadowCorrection, midCorrection, highlightCorrection, lightSourceRgb,
    });
  }

  private parseStringArray(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseExif(raw: string | null | undefined): AssetExif | undefined {
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as AssetExif : undefined;
    } catch {
      return undefined;
    }
  }

  private parseGrade(raw: string): EditRecipe['grade'] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // BUG-011：预设 JSON 同样走配方迁移校验，损坏/旧版结构（缺 curves、
        // vignette、cmy 等）回退默认值，而不是直接 cast 后在渲染层崩溃。
        return migrateRecipe({ grade: parsed as EditRecipe['grade'] }).grade;
      }
    } catch { /* fall through to default */ }
    return createDefaultRecipe().grade;
  }

  private uniquePresetName(name: string): string {
    const names = new Set((this.database.prepare('SELECT name FROM presets').all() as Array<{ name: string }>).map((row) => row.name));
    if (!names.has(name)) return name;
    let index = 2;
    while (names.has(`${name} (${index})`)) index += 1;
    return `${name} (${index})`;
  }

  private cloneCurves(curves: EditRecipe['grade']['curves']): EditRecipe['grade']['curves'] {
    return {
      rgb: curves.rgb.map((point) => ({ ...point })),
      red: curves.red.map((point) => ({ ...point })),
      green: curves.green.map((point) => ({ ...point })),
      blue: curves.blue.map((point) => ({ ...point })),
    };
  }

  private cloneGrade(grade: EditRecipe['grade']): EditRecipe['grade'] {
    return {
      ...grade,
      printerLights: [...grade.printerLights],
      vignette: { ...grade.vignette },
      cmy: { ...grade.cmy },
      curves: this.cloneCurves(grade.curves),
    };
  }

  private mergeGrade(current: EditRecipe['grade'], source: EditRecipe['grade'], scope: PasteScope): EditRecipe['grade'] {
    switch (scope) {
      case 'all':
        return this.cloneGrade(source);
      case 'exposure':
        return { ...current, exposureEv: source.exposureEv };
      case 'color':
        return {
          ...current,
          temperature: source.temperature,
          tint: source.tint,
          saturation: source.saturation,
          vibrance: source.vibrance,
          printerLights: [...source.printerLights],
          cmy: { ...source.cmy },
          blackAndWhite: source.blackAndWhite,
        };
      case 'style':
        return { ...current, look: source.look, lookStrength: source.lookStrength, lutId: source.lutId };
      case 'curves':
        return { ...current, curves: this.cloneCurves(source.curves) };
    }
  }

  private resolveStatus(sourcePath: string, storedStatus: FrameStatus): FrameStatus {
    const now = Date.now();
    const cached = this.sourceStatusCache.get(sourcePath);
    if (cached && now - cached.checkedAt < Storage.SOURCE_STATUS_TTL_MS) return cached.status;
    let status: FrameStatus;
    if (!existsSync(sourcePath)) {
      status = 'missing';
    } else {
      try {
        statSync(sourcePath);
        status = storedStatus === 'error' ? 'error' : 'ready';
      } catch {
        status = 'error';
      }
    }
    if (this.sourceStatusCache.size >= Storage.SOURCE_STATUS_MAX_ENTRIES) this.sourceStatusCache.clear();
    this.sourceStatusCache.set(sourcePath, { status, checkedAt: now });
    return status;
  }

  private toCacheStateRow(row: CacheStateSqlRow): CacheStateRow {
    return {
      path: row.path,
      kind: row.kind === 'frame' ? 'frame' : 'asset',
      subjectId: row.subject_id,
      version: row.version,
      size: row.size,
      checksum: row.checksum,
      status: row.status === 'damaged' ? 'damaged' : 'valid',
      rebuildCount: row.rebuild_count,
      lastValidatedAt: row.last_validated_at,
      updatedAt: row.updated_at,
    };
  }

  private toAssetSummary(row: AssetRow): AssetSummary {
    return {
      id: row.id,
      rollId: row.roll_id,
      name: row.name,
      sourcePath: row.source_path,
      width: row.width,
      height: row.height,
      format: row.format,
      fileSize: row.file_size,
      status: this.resolveStatus(row.source_path, row.status),
      previewUrl: `app-media://asset/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      analysisPreviewUrl: `app-media://asset-analysis/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      developPreviewUrl: `app-media://develop/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      kind: row.kind,
      frameCount: row.frame_count,
      createdAt: row.created_at,
      exif: this.parseExif(row.exif),
    };
  }

  private toFrameSummary(row: FrameRow): FrameSummary {
    let recipe: EditRecipe;
    try {
      recipe = migrateRecipe(JSON.parse(row.recipe_json));
    } catch (error) {
      // DATA-01：损坏配方回退默认值并留下持久化记录，图库仍可打开。
      const message = error instanceof Error ? error.message : String(error);
      this.recordRecoveryIssue(row.id, message);
      console.warn(`Chromik: frame ${row.id} has an invalid recipe; using defaults`, message);
      recipe = createDefaultRecipe();
    }
    return {
      id: row.id,
      rollId: row.roll_id,
      assetId: row.asset_id ?? undefined,
      frameNumber: row.frame_number,
      name: row.name,
      sourcePath: row.source_path,
      width: row.width,
      height: row.height,
      format: row.format,
      fileSize: row.file_size,
      status: this.resolveStatus(row.source_path, row.status),
      previewUrl: `app-media://frame/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      sourcePreviewUrl: row.asset_id
        ? `app-media://asset-analysis/${encodeURIComponent(row.asset_id)}?v=${row.created_at}`
        : `app-media://frame/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      processedPreviewUrl: `app-media://processed/${encodeURIComponent(row.id)}?v=${recipe.updatedAt}`,
      developPreviewUrl: row.asset_id
        ? `app-media://develop/${encodeURIComponent(row.asset_id)}?v=${row.created_at}`
        : `app-media://develop-frame/${encodeURIComponent(row.id)}?v=${row.preview_updated_at || row.created_at}`,
      recipe,
      createdAt: row.created_at,
      starred: row.starred === 1,
      tags: this.parseStringArray(row.tags),
    };
  }
}
