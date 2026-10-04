// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { GraphView, IndexStatus } from "../api/types";
import { ensureGraphLoaded, graphData, invalidateGraph } from "./graphData.svelte";
import { indexStatus, startIndexStatusPoller, stopIndexStatusPoller } from "./store.svelte";

afterEach(() => {
  stopIndexStatusPoller();
  invalidateGraph();
  indexStatus.value = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a cached empty graph reloads when index recovery reaches ready", async () => {
  vi.useFakeTimers();
  const empty: GraphView = { nodes: [], edges: [] };
  const ready: GraphView = { nodes: [{ kind: "tag", id: "#ready", label: "#ready" }], edges: [] };
  const graph = vi.spyOn(api, "graphStream").mockResolvedValueOnce(empty).mockResolvedValueOnce(ready);
  const recovering: IndexStatus = { state: "recovering", readiness: { state: "recovering" } };
  const idle: IndexStatus = { state: "idle", indexed_docs: 1, indexed_vectors: 0, model: "" };
  vi.spyOn(api, "indexStatus").mockResolvedValueOnce(recovering).mockResolvedValue(idle);

  await ensureGraphLoaded();
  expect(graphData.view).toEqual(empty);

  startIndexStatusPoller();
  await vi.advanceTimersByTimeAsync(0);
  expect({ status: indexStatus.value?.state, loads: graph.mock.calls.length }).toEqual({ status: "recovering", loads: 1 });

  await vi.advanceTimersByTimeAsync(1500);
  expect({ status: indexStatus.value?.state, loads: graph.mock.calls.length, view: graphData.view }).toEqual({
    status: "idle", loads: 2, view: ready,
  });

  await vi.advanceTimersByTimeAsync(10_000);
  expect(graph.mock.calls.length, "one reload on the transition").toBe(2);
});
