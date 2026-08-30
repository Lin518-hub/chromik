import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_SCHEMA_VERSION, Storage } from './storage';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Storage crash recovery', () => {
  it('reopens and completes migration after a process is killed inside a SQLite transaction', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'chromik-crash-recovery-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'library.sqlite');
    const childSource = `
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.argv[1]);
      database.exec(\`PRAGMA journal_mode = WAL;
        CREATE TABLE rolls (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO rolls VALUES ('preserved', 'Preserved roll', 1);
        PRAGMA user_version = 0;
        BEGIN IMMEDIATE;
        ALTER TABLE rolls ADD COLUMN interrupted TEXT;
        INSERT INTO rolls VALUES ('uncommitted', 'Must roll back', 2, 'partial');\`);
      process.stdout.write('CHROMIK_CRASH_READY\\n');
      setInterval(() => undefined, 1_000);
    `;
    const child = spawn(process.execPath, ['--experimental-sqlite', '-e', childSource, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('crash fixture did not become ready')), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (!chunk.toString().includes('CHROMIK_CRASH_READY')) return;
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const storage = new Storage(databasePath);
    expect(storage.listRolls().map((roll) => roll.id)).toEqual(['preserved']);
    storage.close();

    const recovered = new DatabaseSync(databasePath);
    const columns = recovered.prepare('PRAGMA table_info(rolls)').all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'interrupted')).toBe(false);
    expect((recovered.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(STORAGE_SCHEMA_VERSION);
    expect((recovered.prepare('SELECT count(*) AS count FROM rolls WHERE id = ?').get('uncommitted') as { count: number }).count).toBe(0);
    recovered.close();
  }, 15_000);
});
