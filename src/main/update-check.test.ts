import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, evaluateUpdate, readUpdateManifest, updateManifestCandidates } from './update-check';

describe('update check', () => {
  it('compares dotted numeric versions', () => {
    expect(compareVersions('0.9.4', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('0.9.3', '0.9.3')).toBe(0);
    expect(compareVersions('0.9.2', '0.9.3')).toBeLessThan(0);
    expect(compareVersions('v1.2.3-rc1', '1.2.2')).toBeGreaterThan(0);
    expect(compareVersions('garbage', '0.9.3')).toBeLessThan(0);
  });

  it('reads a valid manifest and rejects malformed ones', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'chromik-update-'));
    const manifestPath = path.join(directory, 'version.json');
    writeFileSync(manifestPath, JSON.stringify({ version: '1.0.0', url: 'https://example.com/chromik', notes: '第一个正式版' }));
    expect(await readUpdateManifest([manifestPath])).toEqual({ version: '1.0.0', url: 'https://example.com/chromik', notes: '第一个正式版' });
    writeFileSync(manifestPath, JSON.stringify({ version: 'not-a-version' }));
    expect(await readUpdateManifest([manifestPath])).toBeUndefined();
    expect(await readUpdateManifest([path.join(directory, 'missing.json')])).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });

  it('only announces strictly newer versions and https urls', () => {
    expect(evaluateUpdate(undefined, '0.9.3')).toEqual({ available: false });
    expect(evaluateUpdate({ version: '0.9.3' }, '0.9.3')).toEqual({ available: false });
    expect(evaluateUpdate({ version: '0.9.2' }, '0.9.3')).toEqual({ available: false });
    expect(evaluateUpdate({ version: '1.0.0', url: 'http://insecure.example' }, '0.9.3')).toEqual({ available: true, version: '1.0.0', url: undefined, notes: undefined });
    expect(evaluateUpdate({ version: '1.0.0', url: 'https://example.com/chromik' }, '0.9.3')).toEqual({ available: true, version: '1.0.0', url: 'https://example.com/chromik', notes: undefined });
  });

  it('builds candidate paths beside the executable and in resources', () => {
    expect(updateManifestCandidates('/Applications/Chromik.app/Contents/MacOS', '/Applications/Chromik.app/Contents/Resources')).toEqual([
      '/Applications/Chromik.app/Contents/MacOS/version.json',
      '/Applications/Chromik.app/Contents/Resources/version.json',
    ]);
  });
});
