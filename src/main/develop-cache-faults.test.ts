import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeDevelopProxy } from '../core/develop-proxy';
import {
  DEVELOP_PROXY_FAULT_KINDS,
  injectDevelopProxyFault,
  verifyDevelopProxyFile,
} from './develop-cache-faults';

const temporaryDirectories: string[] = [];

async function makeProxyFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chromik-faults-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'asset-v4.chpx');
  const pixels = new Uint16Array(64 * 48 * 3).fill(32768);
  await writeFile(filePath, encodeDevelopProxy({ width: 64, height: 48, channels: 3, bitDepth: 16, transfer: 'linear', data: pixels }));
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('develop cache fault injection', () => {
  it('a pristine proxy passes the independent verdict', async () => {
    const filePath = await makeProxyFile();
    expect(await verifyDevelopProxyFile(filePath)).toMatchObject({ valid: true, width: 64, height: 48, bitDepth: 16, transfer: 'linear' });
  });

  it('every fault kind makes the proxy verifiably invalid', async () => {
    for (const kind of DEVELOP_PROXY_FAULT_KINDS) {
      const filePath = await makeProxyFile();
      const injection = await injectDevelopProxyFault(filePath, kind);
      expect(injection).toMatchObject({ kind, sizeBefore: expect.any(Number), sizeAfter: expect.any(Number) });
      const verdict = await verifyDevelopProxyFile(filePath);
      expect(verdict.valid, `${kind} 之后文件应非法`).toBe(false);
    }
  });

  it('truncate-payload keeps the header but drops payload bytes', async () => {
    const filePath = await makeProxyFile();
    const injection = await injectDevelopProxyFault(filePath, 'truncate-payload');
    expect(injection.sizeAfter).toBeLessThan(injection.sizeBefore);
    expect(injection.lengthPreserved).toBe(false);
  });

  it('flip-payload corrupts content without changing the file length', async () => {
    const filePath = await makeProxyFile();
    const injection = await injectDevelopProxyFault(filePath, 'flip-payload');
    expect(injection.sizeAfter).toBe(injection.sizeBefore);
    expect(injection.lengthPreserved).toBe(true);
    // 长度不变只能靠 CRC32 载荷校验和发现——这正是"原地改坏"场景的关键。
    expect(await verifyDevelopProxyFile(filePath)).toMatchObject({ valid: false });
  });
});
