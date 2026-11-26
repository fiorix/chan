// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { api } from "../api/client";
import type { GraphView } from "../api/types";
import captured from "./fixtures/graph-stream/response.ndjson?raw";
import { GRAPH_STALL_MS, ensureGraphLoaded, graphData, invalidateGraph, refreshGraph } from "./graphData.svelte";

afterEach(() => {
  invalidateGraph();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Nodes = { type: "nodes"; nodes: GraphView["nodes"] };
type Edges = { type: "edges"; edges: GraphView["edges"] };
const [meta, initialNodes, initialEdges, replacementNodes, filesystemEdges, done] = captured.trimEnd().split("\n").map((line) => JSON.parse(line)) as [
  { type: "meta" }, Nodes, Edges, Nodes, Edges, { type: "done" },
];
const batches = [initialNodes, initialEdges, replacementNodes, filesystemEdges];
const a = initialNodes.nodes[1]!;
const firstView: GraphView = { nodes: initialNodes.nodes, edges: initialEdges.edges };
// The capture repeats the tag and both files with their report metadata.
// Their first occurrence fixes the order; the later record supplies the value.
const completed: GraphView = {
  nodes: [replacementNodes.nodes[1]!, replacementNodes.nodes[2]!, replacementNodes.nodes[3]!, replacementNodes.nodes[0]!, replacementNodes.nodes[4]!],
  edges: [...initialEdges.edges, ...filesystemEdges.edges],
};

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
  return {
    send(events: unknown[]) {
      controller.enqueue(new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
    },
    close() { controller.close(); },
    fail(error: Error) { controller.error(error); },
  };
}

function frames() {
  let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++next, callback);
    return next;
  });
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    callbacks,
    cancel,
    run() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(16);
    },
  };
}

async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Observe the accumulator's traversal separately from the store: ignoring a
// snapshot at publish time must not hide its whole-graph allocation.
function materializations() {
  let count = 0;
  const values = Map.prototype.values;
  vi.spyOn(Map.prototype, "values").mockImplementation(function (this: Map<unknown, unknown>) {
    if (this.has("a.md")) count++;
    return values.call(this);
  });
  return () => count;
}

test("a chunk of many events publishes only its completed graph without a frame", async () => {
  const source = stream();
  const clock = frames();
  const count = materializations();
  const publish = vi.spyOn(graphData, "view", "set");
  const load = ensureGraphLoaded();
  source.send([meta, ...Array.from({ length: 20 }, () => batches).flat(), done]);
  source.close();
  await load;

  expect(publish.mock.calls.map(([view]) => view)).toEqual([{ nodes: [], edges: [] }, completed]);
  expect(a).not.toHaveProperty("bucket");
  expect(graphData.view!.nodes.find((node) => node.id === "a.md")).toEqual(replacementNodes.nodes[2]);
  expect(graphData.view!.edges.filter((edge) => edge.kind === "link")).toEqual(initialEdges.edges.filter((edge) => edge.kind === "link"));
  expect(count(), "only completion materializes the accumulated maps").toBe(1);
  expect(graphData.partial).toBe(false);
  expect(graphData.loading).toBe(false);
  expect(graphData.error).toBeNull();
  expect(clock.callbacks.size, "completion cancels the pending partial frame").toBe(0);
  clock.run();
  expect(publish).toHaveBeenCalledTimes(2);
});

test("a first load builds and publishes one immutable view per animation frame", async () => {
  const source = stream();
  const clock = frames();
  const count = materializations();
  const publish = vi.spyOn(graphData, "view", "set");
  const streamCall = api.graphStream;
  const snapshots: GraphView[] = [];
  vi.spyOn(api, "graphStream").mockImplementation((scope, opts = {}) => streamCall(scope, {
    ...opts,
    onView(view) {
      snapshots.push(view);
      opts.onView?.(view);
    },
  }));
  const load = ensureGraphLoaded();
  source.send([meta, ...Array.from({ length: 20 }, () => batches.slice(0, 2)).flat()]);
  await drain();
  expect(count(), "events must not build the view before a frame").toBe(0);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(clock.callbacks.size).toBe(1);
  clock.run();
  expect(count()).toBe(1);
  expect(publish).toHaveBeenCalledTimes(2);
  const first = graphData.view;
  expect(first).toBe(snapshots[0]);
  expect(first).toEqual(firstView);

  source.send(batches.slice(2));
  await drain();
  expect(graphData.view).toBe(first);
  expect(count()).toBe(1);
  clock.run();
  expect(count()).toBe(2);
  expect(publish).toHaveBeenCalledTimes(3);
  expect(graphData.view).toBe(snapshots[1]);
  expect(graphData.view).toEqual(completed);
  expect(first, "later upserts cannot edit a published snapshot").toEqual(firstView);
  expect(graphData.partial).toBe(true);

  source.send([done]);
  source.close();
  await load;
  expect(count()).toBe(3);
  expect(publish).toHaveBeenCalledTimes(4);
  expect(graphData.view).toEqual(completed);
  expect(graphData.partial).toBe(false);
  expect(clock.callbacks.size).toBe(0);
});

test("refresh builds no partial views and retains the completed view until replacement", async () => {
  const previous = { nodes: [a], edges: [] } as GraphView;
  graphData.view = previous;
  const source = stream();
  const clock = frames();
  const count = materializations();
  const publish = vi.spyOn(graphData, "view", "set");
  const load = refreshGraph();
  source.send([meta, ...Array.from({ length: 20 }, () => batches).flat()]);
  await drain();
  expect(count(), "refresh must not build views it discards").toBe(0);
  expect(publish).not.toHaveBeenCalled();
  expect(clock.callbacks.size).toBe(0);
  expect(graphData.view).toBe(previous);
  source.send([done]);
  source.close();
  await load;
  expect(count()).toBe(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(graphData.view).toEqual(completed);
});

test.each(["error", "incomplete", "abort"])("a %s stream cancels its pending view", async (kind) => {
  const source = stream();
  const clock = frames();
  const count = materializations();
  const publish = vi.spyOn(graphData, "view", "set");
  const load = ensureGraphLoaded();
  source.send(batches);
  await drain();
  expect(count()).toBe(0);
  expect(clock.callbacks.size).toBe(1);
  if (kind === "error") source.fail(new Error("stream fixture failure"));
  if (kind === "incomplete") source.close();
  if (kind === "abort") {
    invalidateGraph();
    expect(clock.callbacks.size, "abort cancels even before fetch rejects").toBe(0);
    source.fail(new DOMException("aborted", "AbortError"));
  }
  await load;
  const publications = publish.mock.calls.length;
  expect(clock.callbacks.size).toBe(0);
  clock.run();
  expect(publish).toHaveBeenCalledTimes(publications);
  expect(count()).toBe(0);
  expect(graphData.loading).toBe(false);
  if (kind === "abort") {
    expect(graphData.view).toBeNull();
    expect(graphData.partial).toBe(false);
    expect(graphData.error).toBeNull();
  } else {
    expect(graphData.error).toContain(kind === "error" ? "stream fixture failure" : "before done");
  }
});

test("an invalidate during a load leaves nothing loading and publishes nothing stale", async () => {
  let land: (view: GraphView) => void = () => {};
  vi.spyOn(api, "graphStream").mockImplementation(() => new Promise<GraphView>((resolve) => (land = resolve)));
  const load = ensureGraphLoaded();
  expect(graphData.loading).toBe(true);
  invalidateGraph();
  expect(graphData.loading).toBe(false);
  land({ nodes: [a] as GraphView["nodes"], edges: [] });
  await load;
  expect(graphData.view).toBeNull();
});

test("an obsolete stream callback cannot overwrite its replacement", async () => {
  let obsolete!: (view: GraphView) => void;
  let finish!: (view: GraphView) => void;
  vi.spyOn(api, "graphStream").mockImplementationOnce(async (_scope, opts = {}) => {
    obsolete = (view) => opts.onView?.(view);
    return new Promise<GraphView>((resolve) => { finish = resolve; });
  }).mockResolvedValueOnce(completed as GraphView);
  const old = ensureGraphLoaded();
  await reload();
  obsolete({ nodes: [a], edges: [] } as GraphView);
  expect(graphData.view).toEqual(completed);
  finish({ nodes: [a], edges: [] } as GraphView);
  await old;
  expect(graphData.view).toEqual(completed);
  expect(graphData.loading).toBe(false);

  async function reload() {
    invalidateGraph();
    await ensureGraphLoaded();
  }
});

test("metadata and batches keep the watchdog alive without any animation frames", async () => {
  vi.useFakeTimers();
  const source = stream();
  const clock = frames();
  const count = materializations();
  const load = ensureGraphLoaded();
  await drain();
  const signal = vi.mocked(globalThis.fetch).mock.calls[0]![1]!.signal!;
  for (const events of [
    [meta],
    batches.slice(0, 2),
    batches.slice(2),
  ]) {
    await vi.advanceTimersByTimeAsync(GRAPH_STALL_MS - 1);
    source.send(events);
    await drain();
    expect(signal.aborted, "wire progress keeps the stream alive without a painted frame").toBe(false);
  }
  expect(count()).toBe(0);
  expect(clock.callbacks.size).toBe(1);
  source.send([done]);
  source.close();
  await load;
  expect(graphData.view).toEqual(completed);
  expect(graphData.error).toBeNull();
  expect(graphData.loading).toBe(false);
  expect(count()).toBe(1);
  expect(clock.callbacks.size).toBe(0);
});

test("done cancels the partial frame even while transport EOF is pending", async () => {
  const source = stream();
  const clock = frames();
  const count = materializations();
  const load = ensureGraphLoaded();
  source.send(batches);
  await drain();
  expect(clock.callbacks.size).toBe(1);
  source.send([done]);
  await drain();
  expect(clock.callbacks.size).toBe(0);
  clock.run();
  expect(count()).toBe(0);
  source.close();
  await load;
  expect(count()).toBe(1);
  expect(graphData.view).toEqual(completed);
});

test("abort refuses buffered events before any final snapshot", async () => {
  const source = stream();
  const clock = frames();
  const count = materializations();
  const abort = new AbortController();
  const onDone = vi.fn();
  const load = api.graphStream({}, {
    signal: abort.signal,
    onMeta: () => abort.abort(),
    onView: vi.fn(),
    onDone,
  });
  const refused = expect(load).rejects.toMatchObject({ name: "AbortError" });
  source.send([meta, ...batches, done]);
  source.close();
  await refused;
  expect(onDone).not.toHaveBeenCalled();
  expect(clock.callbacks.size).toBe(0);
  expect(count()).toBe(0);
});

test.each(["folders", "depth"] as const)("a first load over the listing cap publishes its tree mark (%s) when the second meta comes, behind a keep-alive's empty batch", async (tree) => {
  const source = stream();
  const clock = frames();
  const load = ensureGraphLoaded();
  source.send([meta, { type: "nodes", nodes: [] }]);
  await drain();
  clock.run();
  expect(graphData.tree, "the opening meta never carries the mark").toBeNull();

  source.send([{ ...meta, tree }]);
  await drain();
  expect(graphData.partial).toBe(true);
  expect(graphData.tree, "published as it arrives, ahead of the first node").toBe(tree);

  source.send(batches);
  await drain();
  clock.run();
  expect(graphData.view).toEqual(completed);
  expect(graphData.tree).toBe(tree);

  source.send([done]);
  source.close();
  await load;
  expect(graphData.partial).toBe(false);
  expect(graphData.tree).toBe(tree);

  invalidateGraph();
  expect(graphData.tree).toBeNull();
});

test("a refresh keeps the drawn answer's tree mark until its own answer replaces the view", async () => {
  const first = stream();
  frames();
  const loaded = ensureGraphLoaded();
  first.send([meta, { ...meta, tree: "folders" }, ...batches, done]);
  first.close();
  await loaded;
  const previous = graphData.view;
  expect(graphData.tree).toBe("folders");

  const next = stream();
  const refreshed = refreshGraph();
  next.send([meta, ...batches]);
  await drain();
  expect(graphData.view, "a refresh keeps the previous view on screen").toBe(previous);
  expect(graphData.tree, "and the mark of the answer that view came from").toBe("folders");

  next.send([done]);
  next.close();
  await refreshed;
  expect(graphData.view).not.toBe(previous);
  expect(graphData.tree, "an answer that holds the whole tree carries no mark").toBeNull();
});

test.each(["superseded", "failed"])("a first load starts with no tree mark after a first load over the listing cap was %s", async (end) => {
  const first = stream();
  const clock = frames();
  const loadA = ensureGraphLoaded();
  first.send([meta, { ...meta, tree: "folders" }, ...batches.slice(0, 2)]);
  await drain();
  clock.run();
  expect(graphData.partial).toBe(true);
  expect(graphData.tree).toBe("folders");
  if (end === "failed") {
    first.fail(new Error("dropped"));
    await loadA;
    expect(graphData.tree, "the failed load's partial view keeps its mark").toBe("folders");
  }

  const second = stream();
  const loadB = end === "superseded" ? refreshGraph() : ensureGraphLoaded();
  expect(graphData.partial).toBe(true);
  expect(graphData.view).toEqual({ nodes: [], edges: [] });
  expect(graphData.tree, "the old mark goes with the view it described").toBeNull();
  second.send([meta, ...batches, done]);
  second.close();
  await loadB;
  expect(graphData.tree).toBeNull();
});

test("a load an invalidate dropped publishes no tree mark from a stream that goes on after the abort", async () => {
  const opened: Array<() => void> = [];
  // A stream that ignores its abort, which the real client never does: the
  // store's own guard is all that drops what it delivers.
  vi.spyOn(api, "graphStream").mockImplementation(async (_scope, opts = {}) => {
    await new Promise<void>((resolve) => opened.push(resolve));
    opts.onMeta?.({ type: "meta", scope: "workspace", path: "", depth: 6 });
    opts.onMeta?.({ type: "meta", scope: "workspace", path: "", depth: 6, tree: "folders" });
    opts.onView?.(firstView);
    return completed;
  });
  void ensureGraphLoaded();
  await drain();
  invalidateGraph();
  void ensureGraphLoaded();
  await drain();
  expect(opened).toHaveLength(2);

  opened[0]!();
  await drain();
  expect(graphData.tree, "the dropped load's mark").toBeNull();
  expect(graphData.view, "nor its view").toEqual({ nodes: [], edges: [] });
  expect(graphData.partial).toBe(true);

  opened[1]!();
  await drain();
  expect(graphData.tree, "the live load's own mark").toBe("folders");
  expect(graphData.view).toEqual(completed);
});
