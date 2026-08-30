import { srgbToLinear } from '../core/image';

const IS_LITTLE_ENDIAN = (() => {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 0x1234, true);
  return new Uint16Array(buffer)[0] === 0x1234;
})();

// TIFF field type codes.
const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_SRATIONAL = 10;
const TYPE_SIZE: Record<number, number> = {
  [TYPE_BYTE]: 1, [TYPE_ASCII]: 1, [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_RATIONAL]: 8, [TYPE_SRATIONAL]: 8,
};

// DNG tags.
const TAG_DNG_VERSION = 50706;
const TAG_DNG_BACKWARD_VERSION = 50707;
const TAG_UNIQUE_CAMERA_MODEL = 50708;
const TAG_BLACK_LEVEL = 50714;
const TAG_WHITE_LEVEL = 50717;
const TAG_COLOR_MATRIX_1 = 50721;
const TAG_AS_SHOT_NEUTRAL = 50728;
const TAG_CALIBRATION_ILLUMINANT_1 = 50778;

/** sRGB (D65) → XYZ matrix, scaled by 10 000, for ColorMatrix1 (SRATIONAL). */
const SRGB_TO_XYZ_10K: number[] = [
  4124, 3576, 1805,
  2126, 7152, 722,
  193, 1192, 9505,
];

interface Field {
  tag: number;
  type: number;
  count: number;
  /** Inline value (type BYTE/SHORT/LONG, size <= 4) or array of raw numbers. */
  value: number | number[] | Uint8Array;
}

/**
 * Encodes interleaved sRGB-encoded 16-bit RGB samples into a minimal Linear
 * DNG (PhotometricInterpretation = LinearRaw 34892). The samples are converted
 * to linear light (scene-referred, sRGB primaries) and tagged with the sRGB
 * ColorMatrix1 / AsShotNeutral so Lightroom, Capture One and rawtherapee
 * interpret the primaries correctly. Uncompressed, 16-bit, strips of 16 rows.
 */
export function encodeLinearDng(width: number, height: number, srgb16: Uint16Array, inputEncoding: 'srgb' | 'linear' = 'srgb'): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('无效的 DNG 尺寸');
  }
  if (srgb16.length !== width * height * 3) throw new Error('DNG 像素尺寸不匹配');

  // Density conversion already produces display-reference values intended to
  // be stored as LinearRaw. Ordinary positive/slide input still arrives in
  // sRGB encoding and must be decoded once. Keeping the contract explicit
  // prevents the negative workflow from being linearized twice.
  const linear = new Uint16Array(srgb16.length);
  for (let index = 0; index < srgb16.length; index += 1) {
    linear[index] = inputEncoding === 'linear'
      ? srgb16[index]
      : Math.round(srgbToLinear(srgb16[index] / 65535) * 65535);
  }

  const rowsPerStrip = 16;
  const stripCount = Math.ceil(height / rowsPerStrip);
  const stride = width * 3 * 2;
  const strips: Buffer[] = [];
  const stripOffsets: number[] = [];
  const stripByteCounts: number[] = [];
  for (let row = 0; row < height; row += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - row);
    const raw = Buffer.from(linear.buffer, linear.byteOffset + row * width * 3 * 2, rows * stride);
    if (!IS_LITTLE_ENDIAN) raw.swap16();
    strips.push(raw);
    stripByteCounts.push(raw.length);
    // Offsets are assigned below once the header size is known.
  }

  const ascii = (text: string) => Buffer.from(`${text}\0`, 'ascii');
  const make = ascii('Chromik');
  const model = ascii('Chromik 珂影');
  const cameraModel = ascii('Chromik Linear DNG');
  const dngVersion = new Uint8Array([1, 4, 0, 0]);
  const dngBackward = new Uint8Array([1, 1, 0, 0]);
  const blackLevel = [0, 0, 0];
  const asShotNeutral = [1, 1, 1];

  const fields: Field[] = [
    { tag: 256, type: TYPE_LONG, count: 1, value: width },
    { tag: 257, type: TYPE_LONG, count: 1, value: height },
    { tag: 258, type: TYPE_SHORT, count: 3, value: [16, 16, 16] },
    { tag: 259, type: TYPE_SHORT, count: 1, value: 1 }, // no compression
    { tag: 262, type: TYPE_SHORT, count: 1, value: 34892 }, // LinearRaw
    { tag: 271, type: TYPE_ASCII, count: make.length, value: make },
    { tag: 272, type: TYPE_ASCII, count: model.length, value: model },
    { tag: 273, type: TYPE_LONG, count: stripCount, value: stripOffsets },
    { tag: 274, type: TYPE_SHORT, count: 1, value: 1 },
    { tag: 277, type: TYPE_SHORT, count: 1, value: 3 },
    { tag: 278, type: TYPE_LONG, count: 1, value: rowsPerStrip },
    { tag: 279, type: TYPE_LONG, count: stripCount, value: stripByteCounts },
    { tag: 284, type: TYPE_SHORT, count: 1, value: 1 },
    { tag: TAG_DNG_VERSION, type: TYPE_BYTE, count: 4, value: dngVersion },
    { tag: TAG_DNG_BACKWARD_VERSION, type: TYPE_BYTE, count: 4, value: dngBackward },
    { tag: TAG_UNIQUE_CAMERA_MODEL, type: TYPE_ASCII, count: cameraModel.length, value: cameraModel },
    { tag: TAG_BLACK_LEVEL, type: TYPE_RATIONAL, count: 3, value: blackLevel },
    { tag: TAG_WHITE_LEVEL, type: TYPE_LONG, count: 1, value: 65535 },
    { tag: TAG_COLOR_MATRIX_1, type: TYPE_SRATIONAL, count: 9, value: SRGB_TO_XYZ_10K },
    { tag: TAG_AS_SHOT_NEUTRAL, type: TYPE_RATIONAL, count: 3, value: asShotNeutral },
    { tag: TAG_CALIBRATION_ILLUMINANT_1, type: TYPE_SHORT, count: 1, value: 21 }, // D65
  ];

  const ifdSize = 2 + fields.length * 12 + 4;
  let cursor = 8 + ifdSize;
  // Assign offsets for out-of-line values (alignment = 2 for all our types).
  const arrayOffsets = new Map<Field, number>();
  for (const field of fields) {
    const byteSize = TYPE_SIZE[field.type] * field.count;
    if (byteSize <= 4) continue;
    cursor += cursor % 2;
    arrayOffsets.set(field, cursor);
    cursor += byteSize;
  }
  // Strip data offsets.
  for (let index = 0; index < stripCount; index += 1) {
    cursor += cursor % 2;
    stripOffsets.push(cursor);
    cursor += stripByteCounts[index];
  }
  // Single-strip images inline the strip offset/count values (size <= 4);
  // replace the placeholder arrays with plain numbers for those fields.
  if (stripCount === 1) {
    const stripOffsetField = fields.find((field) => field.tag === 273)!;
    const stripByteCountField = fields.find((field) => field.tag === 279)!;
    stripOffsetField.value = stripOffsets[0];
    stripByteCountField.value = stripByteCounts[0];
  }

  const buffer = Buffer.alloc(cursor);
  buffer.writeUInt16LE(0x4949, 0);
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  let entryCursor = 8;
  buffer.writeUInt16LE(fields.length, entryCursor);
  entryCursor += 2;
  for (const field of fields) {
    const byteSize = TYPE_SIZE[field.type] * field.count;
    buffer.writeUInt16LE(field.tag, entryCursor);
    buffer.writeUInt16LE(field.type, entryCursor + 2);
    buffer.writeUInt32LE(field.count, entryCursor + 4);
    if (byteSize <= 4) {
      const value = field.value as number;
      if (field.type === TYPE_SHORT) {
        buffer.writeUInt16LE(value, entryCursor + 8);
        buffer.writeUInt16LE(0, entryCursor + 10);
      } else if (field.type === TYPE_LONG) {
        buffer.writeUInt32LE(value, entryCursor + 8);
      } else {
        const bytes = field.value as Uint8Array;
        for (let index = 0; index < bytes.length; index += 1) buffer.writeUInt8(bytes[index], entryCursor + 8 + index);
      }
    } else {
      buffer.writeUInt32LE(arrayOffsets.get(field)!, entryCursor + 8);
    }
    entryCursor += 12;
  }
  buffer.writeUInt32LE(0, entryCursor);

  for (const field of fields) {
    const byteSize = TYPE_SIZE[field.type] * field.count;
    if (byteSize <= 4) continue;
    const offset = arrayOffsets.get(field)!;
    if (field.type === TYPE_SHORT) {
      (field.value as number[]).forEach((value, index) => buffer.writeUInt16LE(value, offset + index * 2));
    } else if (field.type === TYPE_LONG) {
      (field.value as number[]).forEach((value, index) => buffer.writeUInt32LE(value, offset + index * 4));
    } else if (field.type === TYPE_BYTE || field.type === TYPE_ASCII) {
      Buffer.from(field.value as Uint8Array).copy(buffer, offset);
    } else if (field.type === TYPE_RATIONAL || field.type === TYPE_SRATIONAL) {
      (field.value as number[]).forEach((value, index) => {
        const at = offset + index * 8;
        if (field.type === TYPE_SRATIONAL && value < 0) {
          buffer.writeUInt32LE(-value, at);
          buffer.writeInt32LE(-1, at + 4);
        } else {
          buffer.writeUInt32LE(value, at);
          buffer.writeUInt32LE(1, at + 4);
        }
      });
    }
  }
  for (let index = 0; index < stripCount; index += 1) {
    strips[index].copy(buffer, stripOffsets[index]);
  }
  return buffer;
}
