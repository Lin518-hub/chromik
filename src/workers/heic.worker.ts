import { parentPort, workerData } from 'node:worker_threads';
import { decodeHeicFile } from '../adapters/heic';

decodeHeicFile(workerData as string)
  .then((decoded) => {
    // Transfer the underlying buffer without a full copy. The main process
    // receives byteOffset/byteLength and slices a zero-copy view; the naive
    // Uint8Array.from(decoded.data) cost a second full allocation.
    const buffer = decoded.data.buffer;
    const transferable = buffer instanceof ArrayBuffer ? buffer : undefined;
    parentPort?.postMessage({
      ok: true,
      width: decoded.width,
      height: decoded.height,
      data: buffer,
      byteOffset: decoded.data.byteOffset,
      byteLength: decoded.data.byteLength,
    }, transferable ? [transferable] : []);
  })
  .catch((error: unknown) => parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }));
