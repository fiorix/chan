// @vitest-environment jsdom
//
// What graphData publishes while the graph streams in: the view after each
// batch, read over the real api.graphStream from a streamed response.

import { afterEach, expect, test, vi } from "vitest";

import { api } from "../api/client";
import type { GraphView } from "../api/types";
import { ensureGraphLoaded, graphData, invalidateGraph } from "./graphData.svelte";

afterEach(() => {
  invalidateGraph();
  vi.restoreAllMocks();
});

function streamed(events: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
      );
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const a = { kind: "file", id: "a.md", label: "a", path: "a.md" };
const root = { kind: "directory", id: "", label: "", path: "", files: 1, code: 1 };
const tag = { kind: "tag", id: "#x", label: "#x" };
/// The stream's edge key is source, target, kind and rank, so two edges that
/// differ only in `files` are one edge and the later one wins.
const tagEdge = (rank: number, files: number) => ({
  source: "a.md",
  target: "#x",
  kind: "tag",
  rank,
  files,
});

test("publishes the accumulated view after every batch, upserting nodes and edges", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    streamed([
      { type: "meta", scope: "workspace", path: "", depth: 1 },
      { type: "nodes", nodes: [a, root] },
      { type: "edges", edges: [tagEdge(1, 1)] },
      { type: "nodes", nodes: [{ ...a, label: "A" }, tag] },
      { type: "edges", edges: [tagEdge(1, 9), tagEdge(2, 1)] },
      { type: "done" },
    ]),
  );
  const seen: GraphView[] = [];
  const record = () => seen.push(JSON.parse(JSON.stringify(graphData.view)) as GraphView);
  const stream = api.graphStream;
  vi.spyOn(api, "graphStream").mockImplementation((scope, opts = {}) => {
    record();
    return stream(scope, {
      ...opts,
      onNodes(nodes, view) {
        opts.onNodes?.(nodes, view);
        record();
      },
      onEdges(edges, view) {
        opts.onEdges?.(edges, view);
        record();
      },
    });
  });

  await ensureGraphLoaded();
  record();

  const renamed = [{ ...a, label: "A" }, root, tag];
  expect(seen).toEqual([
    { nodes: [], edges: [] },
    { nodes: [a, root], edges: [] },
    { nodes: [a, root], edges: [tagEdge(1, 1)] },
    { nodes: renamed, edges: [tagEdge(1, 1)] },
    { nodes: renamed, edges: [tagEdge(1, 9), tagEdge(2, 1)] },
    { nodes: renamed, edges: [tagEdge(1, 9), tagEdge(2, 1)] },
  ]);
  expect(graphData.loading).toBe(false);
  expect(graphData.error).toBeNull();
});

// A watcher event drops the cached graph while a load is in flight. The
// dropped load must neither keep the loading flag up nor publish its view
// over the drop.
test("an invalidate during a load leaves nothing loading and publishes nothing stale", async () => {
  let land: (view: GraphView) => void = () => {};
  vi.spyOn(api, "graphStream").mockImplementation(
    () => new Promise<GraphView>((resolve) => (land = resolve)),
  );
  const load = ensureGraphLoaded();
  expect(graphData.loading).toBe(true);

  invalidateGraph();
  expect(graphData.loading, "the drop ends the dropped load's loading").toBe(false);
  land({ nodes: [a] as GraphView["nodes"], edges: [] });
  await load;

  expect(graphData.view, "the dropped load publishes nothing").toBeNull();
});

