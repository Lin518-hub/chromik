export type Matrix3x3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

export function parseCameraToSrgbMatrix(value: unknown): Matrix3x3 | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const rows = value.slice(0, 3).map((row) => Array.isArray(row) ? row.slice(0, 3).map(Number) : []);
  if (rows.some((row) => row.length !== 3 || row.some((item) => !Number.isFinite(item)))) return undefined;
  return rows as unknown as Matrix3x3;
}

function compressSignedLinearSrgb(red: number, green: number, blue: number): [number, number, number] {
  // BUG-030：NaN 会命中 `!(luminance > 0)` 分支被静默抹成纯黑，掩盖上游
  // 坏数据；改为显式抛出，让调用方回退/报错而不是输出错误像素。
  if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) {
    throw new Error('相机色彩矩阵产生了非有限值（NaN/Infinity）');
  }
  let output: [number, number, number] = [red, green, blue];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const minimum = Math.min(...output);
  if (minimum < 0) {
    if (!(luminance > 0)) return [0, 0, 0];
    // Pull out-of-gamut chroma toward the neutral axis until the lowest
    // channel reaches zero. This preserves linear luminance and hue direction
    // instead of clipping a signed matrix result channel-by-channel.
    const chromaScale = luminance / (luminance - minimum);
    output = output.map((value) => luminance + (value - luminance) * chromaScale) as [number, number, number];
  }
  const maximum = Math.max(...output);
  if (maximum > 1) {
    // The canonical carrier is normalized 16-bit. Scale a super-white triplet
    // as a unit so overflow does not alter its channel ratios.
    output = output.map((value) => value / maximum) as [number, number, number];
  }
  return output.map((value) => Math.max(0, Math.min(1, value))) as [number, number, number];
}

/**
 * Applies LibRaw's camera-to-sRGB matrix in signed floating-point arithmetic,
 * then gamut-compresses before quantizing into the canonical 16-bit linear
 * carrier. No unsigned intermediate can clip a negative matrix component.
 */
export function cameraRgb16ToLinearSrgb16(source: Uint16Array, matrix: Matrix3x3): Uint16Array {
  return cameraRgb16ToLinearSrgb16Into(source, matrix, new Uint16Array(source.length));
}

/** Memory-bounded variant used for full-resolution RAW imports. */
export function cameraRgb16ToLinearSrgb16InPlace(source: Uint16Array, matrix: Matrix3x3): Uint16Array {
  return cameraRgb16ToLinearSrgb16Into(source, matrix, source);
}

/**
 * RAW-01：分段就地转换。渲染器主线程把 ~1 亿次浮点迭代切成小块，
 * 块间让出事件循环，保证单次阻塞远低于 100 ms（§13.2）。
 */
export function cameraRgb16ToLinearSrgb16InPlaceRange(source: Uint16Array, matrix: Matrix3x3, start: number, end: number): void {
  // BUG-018：与完整版一致的长度校验；非 3 倍数长度的尾部会让
  // transformCameraTriplet 越界读取并写入 NaN。
  if (source.length % 3 !== 0) throw new Error('相机 RGB 数据长度必须是三通道');
  const from = Math.max(0, Math.floor(start / 3) * 3);
  const to = Math.min(source.length, Math.ceil(end / 3) * 3);
  for (let index = from; index < to; index += 3) transformCameraTriplet(source, matrix, index, source);
}

function cameraRgb16ToLinearSrgb16Into(source: Uint16Array, matrix: Matrix3x3, output: Uint16Array): Uint16Array {
  if (source.length % 3 !== 0) throw new Error('相机 RGB 数据长度必须是三通道');
  for (let index = 0; index < source.length; index += 3) transformCameraTriplet(source, matrix, index, output);
  return output;
}

function transformCameraTriplet(source: Uint16Array, matrix: Matrix3x3, index: number, output: Uint16Array): void {
  // Read the complete triplet before writing so source === output is safe.
  const cameraRed = source[index] / 65535;
  const cameraGreen = source[index + 1] / 65535;
  const cameraBlue = source[index + 2] / 65535;
  const [red, green, blue] = compressSignedLinearSrgb(
    matrix[0][0] * cameraRed + matrix[0][1] * cameraGreen + matrix[0][2] * cameraBlue,
    matrix[1][0] * cameraRed + matrix[1][1] * cameraGreen + matrix[1][2] * cameraBlue,
    matrix[2][0] * cameraRed + matrix[2][1] * cameraGreen + matrix[2][2] * cameraBlue,
  );
  output[index] = Math.round(red * 65535);
  output[index + 1] = Math.round(green * 65535);
  output[index + 2] = Math.round(blue * 65535);
}
