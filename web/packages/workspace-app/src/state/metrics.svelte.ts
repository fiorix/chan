import { untrack } from "svelte";
import { api } from "../api/client";
import type { MetricSample, MetricsView } from "../api/metrics";

// The samples kept for the graphs. Mirrors the server's history capacity
// (HISTORY_CAPACITY in crates/chan-server/src/metrics.rs): one sample per
// second, ten minutes retained.
const HISTORY_CAPACITY = 600;

export const metrics = $state({ view: null as MetricsView | null, samples: [] as MetricSample[], error: null as string | null });
let readers = 0;
let stop: (() => void) | null = null;

export function mergeMetricHistory(previous: MetricSample[], view: MetricsView, sameProcess: boolean): MetricSample[] {
  const samples = new Map<number, MetricSample>();
  if (sameProcess) for (const sample of previous) samples.set(sample.sequence, sample);
  for (const sample of view.history) samples.set(sample.sequence, sample);
  if (view.latest) samples.set(view.latest.sequence, view.latest);
  return [...samples.values()].sort((a, b) => a.sequence - b.sequence).slice(-HISTORY_CAPACITY);
}

// One polling owner per window, regardless of how many dashboard tabs exist.
export function watchMetrics(): () => void {
  readers += 1;
  if (readers === 1) {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (cancelled) return;
      try {
        let view = await api.metrics(metrics.view?.latest?.sequence, controller.signal);
        if (cancelled) return;
        const same = metrics.view?.identity.instanceId === view.identity.instanceId;
        if (metrics.view && !same) view = await api.metrics(undefined, controller.signal);
        if (cancelled) return;
        metrics.samples = mergeMetricHistory(metrics.samples, view, same);
        metrics.view = view;
        metrics.error = null;
      } catch (error) {
        if (!cancelled) metrics.error = (error as Error).message;
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    // A component effect must depend on its visibility, not the cached view
    // read synchronously before the first await in poll().
    untrack(() => { void poll(); });
    stop = () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }
  return () => {
    readers -= 1;
    if (readers === 0) { stop?.(); stop = null; }
  };
}
