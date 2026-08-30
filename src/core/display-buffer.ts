/** Packs an RGB/RGBA processing result into the RGBA contract required by ImageData. */
export function packDisplayRgba(input: Uint8Array | Uint8ClampedArray, channels: number): Uint8ClampedArray {
  if (channels !== 3 && channels !== 4) throw new Error('显示缓冲区只支持 RGB 或 RGBA');
  if (input.length % channels !== 0) throw new Error('显示缓冲区长度与通道数不一致');
  if (channels === 4) return new Uint8ClampedArray(input);
  const output = new Uint8ClampedArray(input.length / 3 * 4);
  for (let source = 0, target = 0; source < input.length; source += 3, target += 4) {
    output[target] = input[source];
    output[target + 1] = input[source + 1];
    output[target + 2] = input[source + 2];
    output[target + 3] = 255;
  }
  return output;
}
