import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { MetricSample, MetricsView } from "../api/metrics";
import { mergeMetricHistory, metrics, watchMetrics } from "./metrics.svelte";
const sample = (sequence: number) => ({ sequence, elapsedMs: sequence * 1000 }) as MetricSample;
const view = (instanceId: string, sequence: number, history = [sample(sequence)]) => ({
  schemaVersion: 1, identity: { instanceId }, latest: sample(sequence), history,
}) as MetricsView;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); metrics.view = null; metrics.samples = []; metrics.error = null; });
test("history deduplicates, stays bounded and clears at a process restart", () => {
  const old = Array.from({ length: 600 }, (_, i) => sample(i + 1));
  const next = mergeMetricHistory(old, view("a", 602, [sample(600), sample(601), sample(602)]), true);
  expect(next).toHaveLength(600);
  expect(next[0].sequence).toBe(3);
  expect(mergeMetricHistory(next, view("b", 1), false).map((s) => s.sequence)).toEqual([1]);
});
test("several viewers share one request and release it when the last viewer leaves", async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(api, "metrics").mockResolvedValue(view("a", 1));
  const closeA = watchMetrics(); const closeB = watchMetrics();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  closeA(); await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
  closeB(); await vi.advanceTimersByTimeAsync(5000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]?.aborted).toBe(true);
});
test("a restart refetches history without the previous instance's sequence cursor", async () => {
  vi.useFakeTimers(); metrics.view = view("old", 600);
  const fetch = vi.spyOn(api, "metrics").mockResolvedValueOnce(view("new", 3, [])).mockResolvedValueOnce(view("new", 3, [sample(1), sample(2), sample(3)]));
  const close = watchMetrics();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls.map((args) => args[0])).toEqual([600, undefined]);
  expect(metrics.samples.map((s) => s.sequence)).toEqual([1, 2, 3]);
  close();
});
