import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

const SAMPLE_BYTES = 256 * 1024;
const VERSION = 'v2';

/**
 * A relocation/duplicate fingerprint that does not require reading a whole
 * multi-hundred-megabyte RAW. Size plus the first and last 256 KiB is stable
 * across copies and intentionally excludes mtime.
 */
export async function fingerprintSource(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('所选路径不是文件');
  const sampleSize = Math.min(SAMPLE_BYTES, stats.size);
  const first = Buffer.alloc(sampleSize);
  const last = Buffer.alloc(sampleSize);
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.read(first, 0, sampleSize, 0);
    if (stats.size > sampleSize) {
      await handle.read(last, 0, sampleSize, Math.max(0, stats.size - sampleSize));
    }
  } finally {
    await handle.close();
  }
  const digest = createHash('sha256')
    .update(String(stats.size))
    .update('\0')
    .update(first)
    .update(last)
    .digest('hex');
  return `${VERSION}:${stats.size}:${digest}`;
}

export function isStrongSourceFingerprint(value: string): boolean {
  return /^v2:\d+:[a-f0-9]{64}$/.test(value);
}

export function fingerprintSize(value: string): number | undefined {
  const strong = /^v2:(\d+):[a-f0-9]{64}$/.exec(value);
  if (strong) return Number(strong[1]);
  const legacy = /^(\d+):\d+$/.exec(value);
  return legacy ? Number(legacy[1]) : undefined;
}
