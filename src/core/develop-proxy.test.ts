import { describe, expect, it } from 'vitest';
import { decodeDevelopProxy, describeDevelopProxy, developProxyPayloadChecksum, downscaleLinearProxy16, encodeDevelopProxy } from './develop-proxy';

describe('Chromik develop proxy', () => {
  it('round-trips 16-bit linear RGB without losing code values', () => {
    const source = new Uint16Array([0, 1, 257, 4096, 32768, 65535]);
    const encoded = encodeDevelopProxy({ width: 2, height: 1, channels: 3, bitDepth: 16, transfer: 'linear', data: source });
    const decoded = decodeDevelopProxy(encoded);
    expect(decoded).toMatchObject({ role: 'develop', version: 4, width: 2, height: 1, channels: 3, bitDepth: 16, transfer: 'linear' });
    expect([...decoded.data]).toEqual([...source]);
    expect(developProxyPayloadChecksum(encoded).toString(16).length).toBeLessThanOrEqual(8);
  });

  it('round-trips an 8-bit compatibility proxy and rejects truncation', () => {
    const encoded = encodeDevelopProxy({ width: 1, height: 1, channels: 3, bitDepth: 8, transfer: 'srgb', data: new Uint8Array([12, 34, 56]) });
    expect([...decodeDevelopProxy(encoded).data]).toEqual([12, 34, 56]);
    expect(() => decodeDevelopProxy(encoded.subarray(0, encoded.length - 1))).toThrow('长度');
  });

  it('area-averages a linear 16-bit proxy without reducing it to 8-bit steps', () => {
    const source = new Uint16Array([
      0, 1000, 2000, 10_000, 11_000, 12_000,
      20_000, 21_000, 22_000, 30_000, 31_000, 32_000,
    ]);
    const result = downscaleLinearProxy16(source, 2, 2, 1);
    expect(result).toMatchObject({ width: 1, height: 1 });
    expect([...result.data16]).toEqual([15_000, 16_000, 17_000]);
    expect(result.data16.some((value) => value % 257 !== 0)).toBe(true);
  });

  it('detects payload corruption even when the file length is unchanged', () => {
    const encoded = encodeDevelopProxy({ width: 1, height: 1, channels: 3, bitDepth: 16, transfer: 'linear', data: new Uint16Array([123, 456, 789]) });
    const corrupted = encoded.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(() => decodeDevelopProxy(corrupted)).toThrow('校验和');
  });

  it('rejects every header-level fault a torn or tampered write could produce', () => {
    const encoded = encodeDevelopProxy({ width: 3, height: 2, channels: 3, bitDepth: 16, transfer: 'linear', data: new Uint16Array(18).fill(1000) });

    const smashed = encoded.slice();
    for (let index = 0; index < 32; index += 1) smashed[index] ^= 0xff;
    expect(() => decodeDevelopProxy(smashed)).toThrow('文件头');

    const wrongVersion = encoded.slice();
    wrongVersion[4] = DEVELOP_PROXY_VERSION_TEST_VALUE;
    expect(() => decodeDevelopProxy(wrongVersion)).toThrow('版本');

    const wrongMagic = encoded.slice();
    wrongMagic[0] ^= 0xff;
    expect(() => decodeDevelopProxy(wrongMagic)).toThrow('文件头');

    const truncatedHeader = encoded.subarray(0, 10);
    expect(() => decodeDevelopProxy(truncatedHeader)).toThrow('文件头');

    const wrongDeclaredBytes = encoded.slice();
    new DataView(wrongDeclaredBytes.buffer).setUint32(20, encoded.length - 32 + 2, true);
    expect(() => decodeDevelopProxy(wrongDeclaredBytes)).toThrow('长度');

    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(() => decodeDevelopProxy(garbage)).toThrow('文件头');
  });

  it('rejects non-16-bit linear proxies at the processing gate', () => {
    const encoded8 = encodeDevelopProxy({ width: 1, height: 1, channels: 3, bitDepth: 8, transfer: 'linear', data: new Uint8Array([1, 2, 3]) });
    const proxy = decodeDevelopProxy(encoded8);
    // describeDevelopProxy 是处理图入口的门禁；8-bit 数据即使容器合法也不能进入处理图。
    expect(() => describeDevelopProxy(proxy)).toThrow('16 位');
  });
});

const DEVELOP_PROXY_VERSION_TEST_VALUE = 99;
