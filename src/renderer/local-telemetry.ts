import { summarizeTimings } from '../core/local-metrics';

const samples = new Map<string, number[]>();
/** BUG-051：键数上限，防止动态指标名让 Map 无界增长（DEV only）。 */
const MAX_METRIC_KEYS = 64;

/** Local-only development timing; never contains paths or image pixels. */
export function recordLocalTiming(metric: string, durationMs: number): void {
  if (!import.meta.env.DEV || !Number.isFinite(durationMs)) return;
  const values = [...(samples.get(metric) ?? []), durationMs].slice(-120).sort((a, b) => a - b);
  samples.set(metric, values);
  while (samples.size > MAX_METRIC_KEYS) {
    const oldest = samples.keys().next().value;
    if (oldest === undefined) break;
    samples.delete(oldest);
  }
  if (values.length % 20 !== 0) return;
  const summary = summarizeTimings(values)!;
  console.info(`[chromik-perf] ${metric} n=${summary.count} p50=${summary.p50.toFixed(1)}ms p95=${summary.p95.toFixed(1)}ms`);
}
