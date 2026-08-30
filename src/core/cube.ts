export type CubeLutType = '1d' | '3d';
export type CubeDomain = [number, number, number];

export interface CubeLut {
  type: CubeLutType;
  size: number;
  /** length = size * 3 (1d) or size^3 * 3 (3d); RGB interleaved. */
  data: Float32Array;
  title?: string;
  domainMin: CubeDomain;
  domainMax: CubeDomain;
}

export interface SerializedCubeLut {
  type: CubeLutType;
  size: number;
  data: number[];
  title?: string;
  domainMin: CubeDomain;
  domainMax: CubeDomain;
}

/**
 * .cube parser supporting the common LUT_1D / LUT_3D dialect and input domain.
 */
export function parseCubeLut(text: string): CubeLut {
  const lines = text.split(/\r?\n/);
  let type: CubeLutType | undefined;
  let size = 0;
  let title: string | undefined;
  let domainMin: CubeDomain = [0, 0, 0];
  let domainMax: CubeDomain = [1, 1, 1];
  const values: number[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const titleMatch = line.match(/^TITLE\s+(.*)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^"|"$/g, '');
      continue;
    }
    const oneDMatch = line.match(/^LUT_1D_SIZE\s+(\d+)/i);
    const threeDMatch = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (oneDMatch || threeDMatch) {
      type = oneDMatch ? '1d' : '3d';
      size = Number((oneDMatch ?? threeDMatch)![1]);
      continue;
    }
    const domainMatch = line.match(/^(DOMAIN_MIN|DOMAIN_MAX)\s+(.+)$/i);
    if (domainMatch) {
      const components = domainMatch[2].trim().split(/\s+/).map(Number);
      if (components.length !== 3 || components.some((value) => !Number.isFinite(value))) throw new Error(`无效的 ${domainMatch[1]} 元数据`);
      if (domainMatch[1].toUpperCase() === 'DOMAIN_MIN') domainMin = components as CubeDomain;
      else domainMax = components as CubeDomain;
      continue;
    }
    const rangeMatch = line.match(/^LUT_(?:1D|3D)_INPUT_RANGE\s+(.+)$/i);
    if (rangeMatch) {
      const range = rangeMatch[1].trim().split(/\s+/).map(Number);
      if (range.length !== 2 || range.some((value) => !Number.isFinite(value))) throw new Error('无效的 LUT INPUT_RANGE 元数据');
      domainMin = [range[0], range[0], range[0]];
      domainMax = [range[1], range[1], range[1]];
      continue;
    }
    // Be tolerant of vendor metadata while never treating it as pixel data.
    if (/^[A-Za-z_]/.test(line)) continue;
    const numbers = line.split(/\s+/).map(Number);
    if (numbers.length !== 3 || numbers.some((number) => !Number.isFinite(number))) throw new Error('无效的 .cube LUT 数据行');
    values.push(...numbers);
  }
  if (!type || size < 2) throw new Error('无效的 .cube LUT（缺少 LUT_1D_SIZE / LUT_3D_SIZE）');
  if ((type === '3d' && size > 65) || (type === '1d' && size > 65536)) throw new Error(`.cube LUT 尺寸过大：${size}`);
  if (domainMin.some((value, channel) => value >= domainMax[channel])) throw new Error('.cube LUT 的输入范围无效');
  const expected = type === '3d' ? size * size * size * 3 : size * 3;
  if (values.length < expected) throw new Error(`.cube LUT 数据不足：需要 ${expected} 个数值，实际 ${values.length}`);
  return { type, size, data: new Float32Array(values.slice(0, expected)), title, domainMin, domainMax };
}

function domainPosition(lut: CubeLut, value: number, component: number): number {
  return Math.max(0, Math.min(1, (value - lut.domainMin[component]) / (lut.domainMax[component] - lut.domainMin[component])));
}

function sample1d(lut: CubeLut, value: number, component: number): number {
  const position = domainPosition(lut, value, component) * (lut.size - 1);
  const low = Math.floor(position);
  const high = Math.min(lut.size - 1, low + 1);
  const fraction = position - low;
  const a = lut.data[low * 3 + component];
  const b = lut.data[high * 3 + component];
  return a + (b - a) * fraction;
}

function sample3d(lut: CubeLut, red: number, green: number, blue: number): [number, number, number] {
  const n = lut.size;
  const rx = domainPosition(lut, red, 0) * (n - 1);
  const gy = domainPosition(lut, green, 1) * (n - 1);
  const bz = domainPosition(lut, blue, 2) * (n - 1);
  const x0 = Math.floor(rx);
  const y0 = Math.floor(gy);
  const z0 = Math.floor(bz);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const fx = rx - x0;
  const fy = gy - y0;
  const fz = bz - z0;
  const at = (x: number, y: number, z: number) => (z * n * n + y * n + x) * 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const c000 = lut.data[at(x0, y0, z0) + channel];
    const c100 = lut.data[at(x1, y0, z0) + channel];
    const c010 = lut.data[at(x0, y1, z0) + channel];
    const c110 = lut.data[at(x1, y1, z0) + channel];
    const c001 = lut.data[at(x0, y0, z1) + channel];
    const c101 = lut.data[at(x1, y0, z1) + channel];
    const c011 = lut.data[at(x0, y1, z1) + channel];
    const c111 = lut.data[at(x1, y1, z1) + channel];
    const c00 = c000 * (1 - fx) + c100 * fx;
    const c10 = c010 * (1 - fx) + c110 * fx;
    const c01 = c001 * (1 - fx) + c101 * fx;
    const c11 = c011 * (1 - fx) + c111 * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[channel] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

export function applyCubeLut(lut: CubeLut, red: number, green: number, blue: number): [number, number, number] {
  if (lut.type === '1d') {
    return [sample1d(lut, red, 0), sample1d(lut, green, 1), sample1d(lut, blue, 2)];
  }
  return sample3d(lut, red, green, blue);
}

/** Serialize a parsed LUT to a transferable plain object (for IPC / workers). */
export function serializeCubeLut(lut: CubeLut): SerializedCubeLut {
  return { type: lut.type, size: lut.size, data: Array.from(lut.data), title: lut.title, domainMin: lut.domainMin, domainMax: lut.domainMax };
}

export function deserializeCubeLut(plain: SerializedCubeLut): CubeLut {
  return {
    type: plain.type,
    size: plain.size,
    data: new Float32Array(plain.data),
    title: plain.title,
    domainMin: plain.domainMin ?? [0, 0, 0],
    domainMax: plain.domainMax ?? [1, 1, 1],
  };
}
