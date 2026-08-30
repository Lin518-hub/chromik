export function calculateHistogram(data: ArrayLike<number>, channels: number, maxValue = 255): [number[], number[], number[]] {
  const bins: [number[], number[], number[]] = [
    Array.from({ length: 64 }, () => 0),
    Array.from({ length: 64 }, () => 0),
    Array.from({ length: 64 }, () => 0),
  ];
  const step = Math.max(channels, Math.ceil(data.length / channels / 60_000) * channels);
  for (let index = 0; index < data.length; index += step) {
    for (let channel = 0; channel < 3; channel += 1) {
      const bin = Math.min(63, Math.floor((data[index + channel] ?? 0) / Math.max(1, maxValue) * 64));
      bins[channel][bin] += 1;
    }
  }
  return bins;
}

export interface WaveformData {
  columns: number;
  levels: number;
  bins: [number[], number[], number[]];
}

export function calculateWaveform(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  columns = 72,
  levels = 40,
  maxValue = 255,
): WaveformData {
  const bins: WaveformData['bins'] = [
    Array.from({ length: columns * levels }, () => 0),
    Array.from({ length: columns * levels }, () => 0),
    Array.from({ length: columns * levels }, () => 0),
  ];
  // Keep analysis work bounded to roughly a 512px-class sample. A waveform is
  // a distribution view, not a per-pixel deliverable; scanning every pixel of
  // a 1080p interactive preview only delays the next slider frame.
  const sampleStride = Math.max(1, Math.ceil(Math.sqrt(width * height / 60_000)));
  const stepY = Math.max(sampleStride, Math.floor(height / 360));
  const stepX = Math.max(sampleStride, Math.floor(width / 720));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const source = (y * width + x) * channels;
      const column = Math.min(columns - 1, Math.floor(x / Math.max(1, width) * columns));
      for (let channel = 0; channel < 3; channel += 1) {
        const level = Math.min(levels - 1, Math.floor((data[source + channel] ?? 0) / Math.max(1, maxValue) * levels));
        bins[channel][(levels - 1 - level) * columns + column] += 1;
      }
    }
  }
  return { columns, levels, bins };
}
