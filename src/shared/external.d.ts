declare module 'heic-decode' {
  interface DecodeInput {
    buffer: Buffer;
  }

  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  function decode(input: DecodeInput): Promise<DecodedImage>;

  export = decode;
}
