import { mkdtempSync, rmSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintSize, fingerprintSource, isStrongSourceFingerprint } from './source-fingerprint';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('source fingerprints', () => {
  it('survives a copy and mtime change', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'chromik-fingerprint-'));
    directories.push(directory);
    const source = path.join(directory, 'source.raw');
    const copy = path.join(directory, 'copy.raw');
    writeFileSync(source, Buffer.alloc(700_000, 31));
    copyFileSync(source, copy);
    utimesSync(copy, new Date(1_000), new Date(2_000));
    const left = await fingerprintSource(source);
    const right = await fingerprintSource(copy);
    expect(left).toBe(right);
    expect(isStrongSourceFingerprint(left)).toBe(true);
    expect(fingerprintSize(left)).toBe(700_000);
  });

  it('detects changes at either sampled edge', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'chromik-fingerprint-'));
    directories.push(directory);
    const left = path.join(directory, 'left.raw');
    const right = path.join(directory, 'right.raw');
    const data = Buffer.alloc(700_000, 5);
    writeFileSync(left, data);
    data[data.length - 1] = 9;
    writeFileSync(right, data);
    expect(await fingerprintSource(left)).not.toBe(await fingerprintSource(right));
  });
});
