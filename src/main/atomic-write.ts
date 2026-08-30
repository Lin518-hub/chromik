import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface AtomicWriteOperations {
  writeExclusive(filePath: string, data: Uint8Array | string): Promise<void>;
  /** 可选：rename 发布之前把数据落盘，缩小断电丢窗口（DATA-05）。 */
  sync?(filePath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  /** P3-8：rename 之后同步父目录，把目录项也落到介质（断电不丢 rename）。 */
  syncDirectory?(directory: string): Promise<void>;
}

const nodeOperations: AtomicWriteOperations = {
  async writeExclusive(filePath, data) { await fs.writeFile(filePath, data, { flag: 'wx' }); },
  async sync(filePath) {
    // fsync 后 close：数据与目录项都到达介质，rename 才发布新文件。
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) { await fs.rename(from, to); },
  async remove(filePath) { await fs.rm(filePath, { force: true }); },
  async syncDirectory(directory) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/**
 * Write beside the destination and publish with one rename. Any write/rename
 * error (including ENOSPC) removes the temporary file and leaves the previous
 * destination untouched.
 */
export async function atomicWriteFile(
  outputPath: string,
  data: Uint8Array | string,
  operations: AtomicWriteOperations = nodeOperations,
): Promise<void> {
  const temporaryPath = `${outputPath}.filmlab-${randomUUID()}.tmp`;
  try {
    await operations.writeExclusive(temporaryPath, data);
    if (operations.sync) await operations.sync(temporaryPath);
    await operations.rename(temporaryPath, outputPath);
    if (operations.syncDirectory) await operations.syncDirectory(path.dirname(outputPath));
  } catch (error) {
    await operations.remove(temporaryPath).catch(() => undefined);
    throw error;
  }
}
