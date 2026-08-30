import { deflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function encodePng16(width: number, height: number, pixels: Uint16Array, icc?: Uint8Array): Buffer {
  if (pixels.length !== width * height * 3) throw new Error('16-bit PNG 像素尺寸不匹配');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = 2;
  const stride = width * 6 + 1;
  const scanlines = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    scanlines[row] = 0;
    for (let x = 0; x < width * 3; x += 1) scanlines.writeUInt16BE(pixels[y * width * 3 + x], row + 1 + x * 2);
  }
  const chunks = [chunk('IHDR', header)];
  if (icc?.length) chunks.push(chunk('iCCP', Buffer.concat([Buffer.from('sRGB ICC\0', 'ascii'), Buffer.from([0]), deflateSync(icc)])));
  chunks.push(chunk('IDAT', deflateSync(scanlines, { level: 6 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([signature, ...chunks]);
}
