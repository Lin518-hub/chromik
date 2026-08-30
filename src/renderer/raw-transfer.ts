import type { ImportResult, RawDecodedImage } from '../shared/types';

export type RawCacheStage = 'validated' | 'proxy' | 'analysis' | 'display' | 'encoded' | 'written' | 'recognition' | 'database';

type RawCommitReply =
  | { type: 'ready' }
  | { type: 'progress'; stage: RawCacheStage; elapsedMs: number }
  | { type: 'result'; ok: boolean; result?: ImportResult; message?: string };

interface RawCommitOptions {
  signal?: AbortSignal;
  onProgress?: (stage: RawCacheStage, elapsedMs: number) => void;
}

/**
 * Send the decoded RGB buffer through a transferable MessagePort. The large
 * ArrayBuffer changes ownership instead of being serialized through invoke(),
 * avoiding a second ~200 MB copy for a full-resolution camera RAW.
 */
export async function commitRawImportTransfer(
  rollId: string,
  sourcePath: string,
  decoded: RawDecodedImage,
  options: RawCommitOptions = {},
): Promise<ImportResult> {
  const channel = new MessageChannel();
  const { data, ...metadata } = decoded;
  const exactBuffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  // prepareRawCommit returns the commit token. We need to pass it to the
  // preload message so it can look up the matching IPC entry; pairing the
  // data to the wrong token would let one RAW's pixels be committed under
  // another RAW's import slot.
  const token = await window.filmLab.prepareRawCommit(rollId, sourcePath, metadata);

  return new Promise((resolve, reject) => {
    let settled = false;
    let pixelsSent = false;
    let timeout = 0;
    const armTimeout = (delay: number, message: string) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => finish(() => reject(new Error(message))), delay);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      channel.port1.close();
      callback();
    };
    const onAbort = () => {
      try { channel.port1.postMessage('cancel'); } catch { /* the main port may already be closed */ }
      finish(() => reject(new DOMException('RAW 导入已取消', 'AbortError')));
    };
    channel.port1.onmessage = (event: MessageEvent<RawCommitReply>) => {
      const reply = event.data;
      if (reply?.type === 'ready') {
        if (pixelsSent || settled) return;
        if (options.signal?.aborted) return onAbort();
        pixelsSent = true;
        channel.port1.postMessage(exactBuffer, [exactBuffer]);
        armTimeout(300_000, 'RAW 缓存生成超时，请重试');
        return;
      }
      if (reply?.type === 'progress') {
        options.onProgress?.(reply.stage, reply.elapsedMs);
        armTimeout(300_000, 'RAW 缓存生成超时，请重试');
        return;
      }
      if (reply?.type !== 'result') return;
      finish(() => {
        if (reply.ok && reply.result) resolve(reply.result);
        else reject(new Error(reply.message ?? 'RAW 提交失败'));
      });
    };
    channel.port1.onmessageerror = () => {
      finish(() => reject(new Error('RAW 提交通道损坏，请重试')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const targetOrigin = window.location.protocol === 'file:' || window.location.origin === 'null'
      ? '*'
      : window.location.origin;
    // BUG-008：sourcePath 与 token 一并传递，preload 回退配对时只允许同一原片，
    // 防止并发 RAW 导入把像素提交到错误的 sourcePath/metadata。
    window.postMessage({ type: 'chromik:raw-commit-port', token, sourcePath }, targetOrigin, [channel.port2]);
    armTimeout(15_000, 'RAW 提交通道握手超时，请重试');
  });
}
