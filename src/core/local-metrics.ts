export interface TimingSummary {
  count: number;
  p50: number;
  p95: number;
}

/** Path/pixel-free percentile math shared by renderer and main diagnostics. */
export function summarizeTimings(values: readonly number[]): TimingSummary | undefined {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return undefined;
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))];
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95) };
}
