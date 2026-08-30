import { describe, expect, it } from 'vitest';
import { encodeLinearDng } from './dng';
import { srgbToLinear } from '../core/image';

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  value: number[];
}

function parseTiffEntries(buffer: Buffer): TiffEntry[] {
  expect(buffer.readUInt16LE(0)).toBe(0x4949);
  expect(buffer.readUInt16LE(2)).toBe(42);
  const ifdOffset = buffer.readUInt32LE(4);
  const entryCount = buffer.readUInt16LE(ifdOffset);
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const entries: TiffEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const cursor = ifdOffset + 2 + index * 12;
    const tag = buffer.readUInt16LE(cursor);
    const type = buffer.readUInt16LE(cursor + 2);
    const count = buffer.readUInt32LE(cursor + 4);
    const total = typeSize[type] * count;
    let value: number[];
    if (total <= 4) {
      if (type === 3) value = [buffer.readUInt16LE(cursor + 8)];
      else if (type === 4) value = [buffer.readUInt32LE(cursor + 8)];
      else if (type === 1) value = [...buffer.subarray(cursor + 8, cursor + 8 + count)];
      else value = [];
    } else {
      const offset = buffer.readUInt32LE(cursor + 8);
      value = [];
      if (type === 3) {
        for (let k = 0; k < count; k += 1) value.push(buffer.readUInt16LE(offset + k * 2));
      } else if (type === 4) {
        for (let k = 0; k < count; k += 1) value.push(buffer.readUInt32LE(offset + k * 4));
      } else if (type === 5 || type === 10) {
        for (let k = 0; k < count; k += 1) {
          const numerator = buffer.readUInt32LE(offset + k * 8);
          const denominator = buffer.readInt32LE(offset + k * 8 + 4);
          value.push(denominator === 0 ? numerator : numerator / denominator);
        }
      } else if (type === 1 || type === 2) {
        for (let k = 0; k < count; k += 1) value.push(buffer.readUInt8(offset + k));
      }
    }
    entries.push({ tag, type, count, value });
  }
  return entries;
}

function readStrips(buffer: Buffer, entries: TiffEntry[]): Uint16Array {
  const offsets = entries.find((entry) => entry.tag === 273)!.value;
  const counts = entries.find((entry) => entry.tag === 279)!.value;
  const total = counts.reduce((sum, count) => sum + count, 0);
  const pixels = new Uint16Array(total / 2);
  let out = 0;
  for (let strip = 0; strip < offsets.length; strip += 1) {
    for (let at = offsets[strip]; at < offsets[strip] + counts[strip]; at += 2, out += 1) {
      pixels[out] = buffer.readUInt16LE(at);
    }
  }
  return pixels;
}

describe('encodeLinearDng', () => {
  it('does not linearize density-mode samples a second time', () => {
    const samples = new Uint16Array([32768, 16384, 8192]);
    const dng = encodeLinearDng(1, 1, samples, 'linear');
    expect(dng.includes(Buffer.from(samples.buffer))).toBe(true);
  });
  it('writes a structurally valid Linear DNG (single strip) with linearized samples', () => {
    const width = 8;
    const height = 5; // single strip → exercises inline StripOffsets/ByteCounts
    const srgb16 = new Uint16Array(width * height * 3);
    for (let index = 0; index < srgb16.length; index += 1) srgb16[index] = (index * 1009 + 7) % 65536;
    const dng = encodeLinearDng(width, height, srgb16);
    const entries = parseTiffEntries(dng);

    const tag = (id: number) => entries.find((entry) => entry.tag === id);
    expect(tag(256)!.value[0]).toBe(width);
    expect(tag(257)!.value[0]).toBe(height);
    expect(tag(258)!.value).toEqual([16, 16, 16]);
    expect(tag(259)!.value[0]).toBe(1);
    expect(tag(262)!.value[0]).toBe(34892); // LinearRaw
    expect(tag(274)!.value[0]).toBe(1);
    expect(tag(277)!.value[0]).toBe(3);
    expect(tag(284)!.value[0]).toBe(1);
    expect(tag(50706)!.value).toEqual([1, 4, 0, 0]);
    expect(tag(50707)!.value).toEqual([1, 1, 0, 0]);
    expect(tag(50714)!.value).toEqual([0, 0, 0]);
    expect(tag(50717)!.value[0]).toBe(65535);
    expect(tag(50721)!.value).toEqual([4124, 3576, 1805, 2126, 7152, 722, 193, 1192, 9505]);
    expect(tag(50728)!.value).toEqual([1, 1, 1]);
    expect(tag(50778)!.value[0]).toBe(21);

    const readback = readStrips(dng, entries);
    expect(readback.length).toBe(srgb16.length);
    for (let index = 0; index < srgb16.length; index += 1) {
      const expected = Math.round(srgbToLinear(srgb16[index] / 65535) * 65535);
      expect(readback[index]).toBe(expected);
    }
  });

  it('round-trips multi-strip images', () => {
    const width = 13;
    const height = 40; // three strips
    const srgb16 = new Uint16Array(width * height * 3);
    for (let index = 0; index < srgb16.length; index += 1) srgb16[index] = (index * 131 + 3) % 65536;
    const dng = encodeLinearDng(width, height, srgb16);
    const entries = parseTiffEntries(dng);
    const readback = readStrips(dng, entries);
    expect(readback.length).toBe(srgb16.length);
    let exact = true;
    for (let index = 0; index < srgb16.length; index += 1) {
      if (readback[index] !== Math.round(srgbToLinear(srgb16[index] / 65535) * 65535)) exact = false;
    }
    expect(exact).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(() => encodeLinearDng(0, 4, new Uint16Array(0))).toThrow();
    expect(() => encodeLinearDng(4, 4, new Uint16Array(16))).toThrow();
  });
});
