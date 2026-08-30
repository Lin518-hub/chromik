import { promises as fs } from 'node:fs';
import { decodeDevelopProxy, describeDevelopProxy } from '../core/develop-proxy';

/**
 * 故障注入器与验证助手：把开发代理（CHPX）缓存文件变成 QA-06 要求的
 * "被截断 / 被改坏" 状态，并给出独立于主进程缓存簿记的裁决结果。
 *
 * 这些函数刻意不依赖 Electron / storage / 主进程状态，只接收绝对路径，
 * 因此既可以被单元测试直接驱动，也可以被 QA 故障注入 harness 复用。
 */

export type DevelopProxyFaultKind =
  | 'truncate-payload' // 模拟写入中断：头部完好，载荷丢掉约 40%
  | 'flip-payload' // 模拟位翻转/磁盘坏道：长度不变，翻转载荷若干字节
  | 'smash-header' // 模拟头部被覆写：整段 32 字节头翻转
  | 'truncate-header' // 模拟文件只剩半截头部
  | 'garbage-file'; // 模拟文件整体被替换成无关内容

export const DEVELOP_PROXY_FAULT_KINDS: readonly DevelopProxyFaultKind[] = [
  'truncate-payload',
  'flip-payload',
  'smash-header',
  'truncate-header',
  'garbage-file',
];

const HEADER_SIZE = 32;

export interface FaultInjection {
  kind: DevelopProxyFaultKind;
  sizeBefore: number;
  sizeAfter: number;
  lengthPreserved: boolean;
}

/** 就地注入故障（直接覆写目标文件，模拟进程外损坏）。 */
export async function injectDevelopProxyFault(filePath: string, kind: DevelopProxyFaultKind): Promise<FaultInjection> {
  const bytes = Buffer.from(await fs.readFile(filePath));
  const sizeBefore = bytes.length;
  let corrupted: Buffer;
  switch (kind) {
    case 'truncate-payload': {
      // 中断写入的典型残骸：容器头部完整，数据区只剩前 60%。
      corrupted = bytes.subarray(0, Math.max(HEADER_SIZE, Math.floor(bytes.length * 0.6)));
      break;
    }
    case 'flip-payload': {
      corrupted = Buffer.from(bytes);
      if (corrupted.length > HEADER_SIZE + 8) {
        const start = HEADER_SIZE + Math.floor((corrupted.length - HEADER_SIZE) / 3);
        for (let index = 0; index < 8; index += 1) {
          const at = start + index * 7;
          if (at < corrupted.length) corrupted[at] ^= 0xa5;
        }
      } else {
        corrupted[HEADER_SIZE - 1] ^= 0xa5;
      }
      break;
    }
    case 'smash-header': {
      corrupted = Buffer.from(bytes);
      const limit = Math.min(HEADER_SIZE, corrupted.length);
      for (let index = 0; index < limit; index += 1) corrupted[index] ^= 0xff;
      break;
    }
    case 'truncate-header':
      corrupted = bytes.subarray(0, Math.min(10, bytes.length));
      break;
    case 'garbage-file':
      corrupted = Buffer.from('this is not a chromik develop proxy');
      break;
  }
  await fs.writeFile(filePath, corrupted);
  return { kind, sizeBefore, sizeAfter: corrupted.length, lengthPreserved: corrupted.length === sizeBefore };
}

export interface DevelopProxyVerdict {
  valid: boolean;
  width?: number;
  height?: number;
  bitDepth?: number;
  transfer?: string;
  reason?: string;
}

/** 与主进程无关的裁决：解码并复核容器（含 CRC32 校验和与转移函数门禁）。 */
export async function verifyDevelopProxyFile(filePath: string): Promise<DevelopProxyVerdict> {
  try {
    const proxy = decodeDevelopProxy(await fs.readFile(filePath));
    describeDevelopProxy(proxy);
    return {
      valid: true,
      width: proxy.width,
      height: proxy.height,
      bitDepth: proxy.bitDepth,
      transfer: proxy.transfer,
    };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
