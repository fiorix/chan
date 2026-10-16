// @vitest-environment jsdom
//
// The shared graph through a burst of filesystem events: frames reach the
// store through onWatchEvent over the demo workspace, and every /api/graph
// stream is held by the test, which answers, fails or feeds it by hand. A
// window receives an event in a loaded directory as two frames (watch, fs).

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { GraphView } from "../api/types";
import { draftPath } from "../__tests__/drafts";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import WorkspaceInfoBody from "../components/WorkspaceInfoBody.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  GRAPH_QUIET_MS,
  GRAPH_STALL_MS,
  ensureGraphLoaded,
  graphData,
  invalidateGraph,
  reloadGraph,
} from "./graphData.svelte";
import {
  browserSelection,
  noteDraftCreated,
  onWatchEvent,
  pathPromptState,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
  teardown,
} from "./store.svelte";
import { saveDraftTabToWorkspace, type Tab } from "./tabs.svelte";

type GraphStreamOptions = NonNullable<Parameters<typeof api.graphStream>[1]>;
type HeldStream = {
  at: number;
  signal: AbortSignal | undefined;
  /// Send one batch of nodes, as the route does before it is done.
  batch(view: GraphView): void;
  answer(view: GraphView): void;
  fail(error: Error): void;
};

let timers: TimerTrack;
let streams: HeldStream[];

const view = (tag: string): GraphView => ({ nodes: [{ kind: "tag", id: `#${tag}`, label: `#${tag}` }], edges: [] });
const A = view("a");
const B = view("b");
const C = view("c");

function holdGraphStreams(): void {
  streams = [];
  vi.spyOn(api, "graphStream").mockImplementation(
    (_scope, opts: GraphStreamOptions = {}) =>
      new Promise<GraphView>((resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        streams.push({
          at: Date.now(),
          signal: opts.signal,
          batch: (v) => opts.onNodes?.(v.nodes, v),
          answer: (v) => {
            opts.onDone?.(v);
            resolve(v);
          },
          fail: reject,
        });
      }),
  );
}

const browserTab: Tab = { kind: "browser", id: "files", title: "Files", inspectorOpen: false };

/// The graph loaded once, answered with A.
async function loaded(tabs: Tab[] = [browserTab]): Promise<void> {
  resetLayout(tabs);
  const load = ensureGraphLoaded();
  streams[0]!.answer(A);
  await load;
  expect(graphData.view, "the graph before the burst").toEqual(A);
}

/// One filesystem event as a window receives it: a watch frame and an fs frame.
function event(path: string): number {
  onWatchEvent({ type: "watch", event: { kind: "Created", path } });
  onWatchEvent({ type: "fs", event: { kind: "Created", path } });
  return Date.now();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  timers = trackTimers();
  window.history.replaceState(null, "", "/?w=window-a");
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" }],
  });
  await refreshWorkspace();
  await refreshTree();
  vi.useFakeTimers();
  holdGraphStreams();
});

afterEach(() => {
  teardown();
  invalidateGraph();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLayout();
  window.history.replaceState(null, "", "/");
  timers.release();
  uninstallDemoWorkspace();
});

describe("a burst of filesystem events fetches the shared graph once, after its last frame", () => {
  test("ten events with a File Browser open fetch once, a quiet window after the last frame", async () => {
    await loaded();
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      last = event(`notes/n${i}.md`);
      await advance(20);
    }
    expect(streams.length - 1, "no fetch while the frames keep coming").toBe(0);
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1, "one fetch for the burst").toBe(1);
    expect(streams[1]!.at - last, "the fetch starts a quiet window after the last frame").toBeGreaterThanOrEqual(GRAPH_QUIET_MS);
    streams[1]!.answer(B);
    await advance(0);
    expect(graphData.view).toEqual(B);
  });

  test("a frame while the fetch is out aborts nothing, and one more fetch follows that fetch's answer", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1).toBe(1);
    const frameAt = event("notes/n2.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams[1]!.signal?.aborted, "the fetch out is not aborted").toBe(false);
    expect(streams.length - 1, "the burst's end waits for the fetch out").toBe(1);
    streams[1]!.answer(B);
    await advance(0);
    expect(graphData.view, "the first answer is published").toEqual(B);
    expect(streams.length - 1, "then one more fetch").toBe(2);
    expect(streams[2]!.at - frameAt).toBeGreaterThanOrEqual(GRAPH_QUIET_MS);
    streams[2]!.answer(C);
    await advance(0);
    expect(graphData.view).toEqual(C);
  });

  test("two bursts that end while one fetch is out fetch once after it and keep the view that fetch brings", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1, "the first burst's fetch").toBe(1);
    event("notes/n2.md");
    await advance(GRAPH_QUIET_MS);
    event("notes/n3.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1, "both later ends wait on the fetch out").toBe(1);
    streams[1]!.answer(B);
    await advance(0);
    expect(streams.length - 1, "the waiting ends fetch once").toBe(2);
    streams[2]!.answer(C);
    await advance(0);
    expect({ fetches: streams.length - 1, view: graphData.view }).toEqual({ fetches: 2, view: C });
  });

  test("two bursts a second apart fetch once each, after each burst", async () => {
    await loaded();
    for (const path of ["notes/a1.md", "notes/a2.md", "notes/a3.md"]) event(path);
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1, "the first burst's fetch").toBe(1);
    streams[1]!.answer(B);
    await advance(1000);
    let last = 0;
    for (const path of ["notes/b1.md", "notes/b2.md", "notes/b3.md"]) last = event(path);
    await advance(GRAPH_QUIET_MS - 1);
    expect(streams.length - 1, "nothing before the second burst ends").toBe(1);
    await advance(1);
    expect(streams.length - 1, "the second burst's fetch").toBe(2);
    expect(streams[2]!.at - last).toBeGreaterThanOrEqual(GRAPH_QUIET_MS);
  });

  test("a fetch that fails keeps the last view, sets the error and ends the burst; the next burst fetches again", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS);
    streams[1]!.fail(new Error("graph exploded"));
    await advance(0);
    expect(graphData.view, "the last complete view stays").toEqual(A);
    expect(graphData.error).toBe("graph exploded");
    await advance(10_000);
    expect(streams.length - 1, "no retry without a frame").toBe(1);
    const retry = ensureGraphLoaded();
    expect(streams.length - 1, "a surface's own load retries the failed fetch").toBe(2);
    streams[2]!.fail(new Error("graph exploded again"));
    await retry;
    expect(graphData.view, "the retry keeps the view too").toEqual(A);
    event("notes/n2.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1, "the next burst fetches").toBe(3);
    streams[3]!.answer(B);
    await advance(0);
    expect({ view: graphData.view, error: graphData.error }).toEqual({ view: B, error: null });
  });

  test("a first load that fails keeps what it streamed, and its retry streams afresh", async () => {
    resetLayout([browserTab]);
    const partial = view("partial");
    const load = ensureGraphLoaded();
    streams[0]!.batch(partial);
    await advance(0);
    expect(graphData.view, "a first load publishes its batch").toEqual(partial);
    streams[0]!.fail(new Error("graph exploded"));
    await load;
    expect({ view: graphData.view, error: graphData.error }, "the failure keeps what it streamed").toEqual({
      view: partial,
      error: "graph exploded",
    });
    const retry = ensureGraphLoaded();
    expect(streams.length, "a surface's own load retries the failed fetch").toBe(2);
    expect({ view: graphData.view, error: graphData.error }, "the retry starts afresh").toEqual({
      view: { nodes: [], edges: [] },
      error: null,
    });
    streams[1]!.batch(B);
    await advance(0);
    expect(graphData.view, "and publishes as it streams").toEqual(B);
    streams[1]!.answer(C);
    await retry;
    expect({ view: graphData.view, error: graphData.error }).toEqual({ view: C, error: null });
  });

  test("the view through a burst and a refresh that has sent a batch is the last complete one", async () => {
    await loaded();
    const seen: GraphView[] = [];
    const read = () => seen.push(JSON.parse(JSON.stringify(graphData.view)) as GraphView);
    for (let i = 0; i < 5; i += 1) {
      event(`notes/n${i}.md`);
      read();
      await advance(20);
    }
    await advance(GRAPH_QUIET_MS);
    read();
    streams[1]!.batch(view("partial"));
    await advance(0);
    read();
    expect(seen, "every reading is the last complete view").toEqual(seen.map(() => A));
    streams[1]!.answer(B);
    await advance(0);
    expect(graphData.view).toEqual(B);
  });

  test("with no File Browser or graph tab open the burst fetches nothing and drops the view at its end", async () => {
    await loaded([]);
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS - 1);
    expect(graphData.view, "kept through the burst").toEqual(A);
    await advance(1);
    expect({ fetches: streams.length - 1, view: graphData.view }).toEqual({ fetches: 0, view: null });
  });

  test("a tab closed while the burst's end waits on a fetch out gets no fetch after it", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS);
    event("notes/n2.md");
    await advance(GRAPH_QUIET_MS);
    resetLayout([]);
    streams[1]!.answer(B);
    await advance(0);
    expect({ fetches: streams.length - 1, view: graphData.view }).toEqual({ fetches: 1, view: null });
  });

  test("a dashboard's workspace inspector with no tab open fetches once per burst", async () => {
    resetLayout([]);
    const target = document.createElement("div");
    document.body.append(target);
    const body = mount(WorkspaceInfoBody, { target, props: { variant: "dashboard" } });
    try {
      flushSync();
      await advance(0);
      expect(streams, "the inspector's own load").toHaveLength(1);
      streams[0]!.answer(A);
      await advance(0);
      for (let i = 0; i < 10; i += 1) {
        event(`notes/n${i}.md`);
        await advance(20);
        flushSync();
      }
      expect(streams.length - 1, "nothing during the burst").toBe(0);
      await advance(GRAPH_QUIET_MS);
      flushSync();
      await advance(0);
      expect(streams.length - 1, "one fetch for the burst").toBe(1);
    } finally {
      unmount(body);
      target.remove();
    }
  });

  test("an explicit reload inside a quiet window is the burst's only fetch", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(100);
    const reload = reloadGraph();
    streams.at(-1)!.answer(B);
    await reload;
    await advance(GRAPH_QUIET_MS * 2);
    expect({ fetches: streams.length - 1, view: graphData.view }).toEqual({ fetches: 1, view: B });
  });

  test("a stream that sends nothing is aborted at the stall bound, keeps the view and frees the next burst", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(GRAPH_QUIET_MS);
    expect(streams.length - 1).toBe(1);
    event("notes/n2.md");
    await advance(GRAPH_STALL_MS);
    expect(streams[1]!.signal?.aborted, "the stalled stream is aborted").toBe(true);
    expect(graphData.view, "the last complete view stays").toEqual(A);
    expect(graphData.error).toMatch(/sent nothing/);
    expect(streams.length - 1, "the burst that waited on it fetches").toBe(2);
    streams[2]!.answer(B);
    await advance(0);
    expect({ view: graphData.view, error: graphData.error }).toEqual({ view: B, error: null });
  });

  test("a teardown inside a quiet window fetches nothing after it", async () => {
    await loaded();
    event("notes/n1.md");
    await advance(100);
    teardown();
    await advance(GRAPH_QUIET_MS * 2);
    expect(streams.length - 1).toBe(0);
  });
});

describe("the draft sites join the burst", () => {
  test("a created draft fetches the graph once, after a quiet window", async () => {
    await loaded();
    await noteDraftCreated(draftPath("untitled"));
    await advance(GRAPH_QUIET_MS - 1);
    expect(streams.length - 1, "nothing before the window ends").toBe(0);
    await advance(1);
    expect(streams.length - 1).toBe(1);
  });

  test("a promoted draft and its own watch frame fetch the graph once", async () => {
    await loaded([browserTab, fileTab({ id: "draft", path: draftPath("untitled"), content: "body", saved: "body" })]);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path: "untitled/draft.md",
      name: "untitled",
      file_count: 1,
      dir_count: 0,
      total_size: 4,
      has_attachments: false,
    });
    vi.spyOn(api, "promoteDraft").mockResolvedValue({ path: "notes/saved.md", name: "untitled", mode: "file" });
    const saved = saveDraftTabToWorkspace(readTab("draft")!);
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    resolvePathPrompt("notes/saved.md");
    for (let i = 0; i < 5; i += 1) await advance(0);
    expect(await saved, "the draft is saved to the workspace").toBe(true);
    expect(browserSelection.path, "the promotion has reached the store").toBe("notes/saved.md");
    event("notes/saved.md");
    await advance(0);
    expect(streams.length - 1, "nothing before the window ends").toBe(0);
    await advance(GRAPH_QUIET_MS * 2);
    expect(streams.length - 1, "one fetch for the promotion and its frame").toBe(1);
  });
});
