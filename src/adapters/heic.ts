import { promises as fs } from 'node:fs';
import path from 'node:path';
import decode from 'heic-decode';

export interface DecodedHeic {
  width: number;
  height: number;
  data: Uint8Array;
}

export function isHeicPath(filePath: string): boolean {
  return ['.heic', '.heif', '.hif'].includes(path.extname(filePath).toLowerCase());
}

export async function decodeHeicFile(filePath: string): Promise<DecodedHeic> {
  const source = await fs.readFile(filePath);
  const decoded = await decode({ buffer: source });
  const expectedLength = decoded.width * decoded.height * 4;
  if (!decoded.width || !decoded.height || decoded.data.byteLength !== expectedLength) {
    throw new Error('HEIC 解码结果无效');
  }
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  };
}
