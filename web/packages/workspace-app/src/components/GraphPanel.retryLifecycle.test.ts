// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);
vi.mock("../graph/canvasNodes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph/canvasNodes")>();
  return { ...actual, directoryNodeId: vi.fn(actual.directoryNodeId) };
});

import GraphPanel from "./GraphPanel.svelte";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { request, setFetchImpl } from "../api/transport";
import { directoryNodeId } from "../graph/canvasNodes";
import {
  canvas,
  fsg,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  resetGraphServer,
  settle,
  visibleIds,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { invalidateGraph, noteGraphChanged, refreshGraph } from "../state/graphData.svelte";
import { graphReloadSignal, indexStatus } from "../state/store.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

const fixtureRead = vi.mocked(api.fsGraph).getMockImplementation()!;
type ReadOptions = Parameters<typeof api.fsGraph>[0];
const opened = { docs: true, notes: true, src: true };
const timeout = (path = "notes") => new ApiError(0,
  `request timed out after 10000 ms: GET /api/fs-graph?scope=directory&path=${encodeURIComponent(path)}&depth=1&limit=128`,
);
let timers: TimerTrack;
let releases: Array<() => void>;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  timers = trackTimers();
  releases = [];
  resetGraphServer();
  invalidateGraph();
  indexStatus.value = null;
  vi.mocked(api.fsGraph).mockReset().mockImplementation(fixtureRead);
  const dirs = ["docs", "notes", "src"];
  graphServer.fs = {
    nodes: [fsg.dir(""), ...dirs.map(fsg.dir), ...dirs.map((dir) => fsg.file(`${dir}/a.md`))],
    edges: dirs.flatMap((dir) => [fsg.contains("", dir), fsg.contains(dir, `${dir}/a.md`)]),
  };
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  invalidateGraph();
  for (const release of releases) release();
  await settle(2);
  indexStatus.value = null;
  vi.mocked(api.fsGraph).mockReset().mockImplementation(fixtureRead);
  timers.release();
});

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  releases.push(release);
  return { promise, release };
}

function recordRead(options: ReadOptions): void {
  graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
}

function warningText(target: HTMLElement): string {
  const warning = target.querySelector(".spine-warning");
  expect(warning, "an uncovered failed retry displays a warning").not.toBeNull();
  return warning!.textContent!.trim();
}

function reads(path: string): number {
  return graphServer.fsGraphCalls.filter((call) => call.path === path).length;
}

async function render(expanded: Record<string, boolean> = opened, finish: () => Promise<void> = settle): Promise<{
  target: HTMLElement;
  show: (active: boolean) => void;
}> {
  const tab = graphTab({ expanded: { ...expanded } });
  layout.nodes = {
    [GRAPH_PANE]: { kind: "leaf", id: GRAPH_PANE, tabs: [tab], activeTabId: tab.id },
  };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const pane = layout.nodes[GRAPH_PANE] as LeafNode;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(GraphPanel, {
    target,
    props: {
      tab: pane.tabs[0] as typeof tab,
      get active() { return pane.activeTabId === tab.id; },
    },
  }) as Record<string, unknown>);
  await finish();
  return { target, show: (active) => { pane.activeTabId = active ? tab.id : "other-tab"; } };
}

async function flushClock(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await tick();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

const publicationProbe = "notes/publication-probe";

function probePublications(): number {
  return vi.mocked(directoryNodeId).mock.calls.filter(([path]) => path === publicationProbe).length;
}

async function controlledRetries(lastFailure?: Error) {
  const shared = gate();
  graphServer.streamGate = shared.promise;
  graphServer.fs.nodes.push(fsg.dir(publicationProbe));
  graphServer.fs.edges.push(fsg.contains("notes", publicationProbe));
  const dirs = ["docs", "notes", "src"];
  const pending = new Map(dirs.map((dir) => [dir, gate()]));
  const started: string[] = [];
  vi.mocked(api.fsGraph).mockImplementation(async (options) => {
    if (!pending.has(options.path)) return fixtureRead(options);
    if (reads(options.path) === 0) {
      recordRead(options);
      throw timeout(options.path);
    }
    const response = await fixtureRead(options);
    started.push(options.path);
    await pending.get(options.path)!.promise;
    if (options.path === "src" && lastFailure !== undefined) throw lastFailure;
    return response;
  });
  const { target } = await render(opened, flushClock);
  expect(dirs.map(reads)).toEqual([1, 1, 1]);
  shared.release();
  await flushClock();
  expect(started).toEqual(["docs"]);
  return { target, dirs, pending, started };
}

function reload(): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }));
}

async function change(paths: string[]): Promise<void> {
  vi.useFakeTimers();
  try {
    noteGraphChanged(() => true);
    graphReloadSignal.paths = paths;
    graphReloadSignal.nonce += 1;
    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
  await settle();
}

function expectUsable(target: HTMLElement): void {
  expect(target.querySelector(".placeholder.error")).toBeNull();
  expect(target.querySelector(".cy.dim")).toBeNull();
}

describe("the directory retry's lifetime", () => {
  test("publishes the first retry promptly and batches later reads until the final flush", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { target, dirs, pending, started } = await controlledRetries();
      const initial = canvas.props!.nodes;
      pending.get("docs")!.release();
      await flushClock();
      const first = canvas.props!.nodes;
      expect(first, "a recovered level is published before awaiting another request").not.toBe(initial);
      expect(visibleIds()).toContain("docs/a.md");
      expect(started).toEqual(["docs", "notes"]);

      await vi.advanceTimersByTimeAsync(200);
      scheduled.mockClear();
      pending.get("notes")!.release();
      await flushClock();
      expect(canvas.props!.nodes, "a second read inside the cadence stays buffered").toBe(first);
      expect(started).toEqual(dirs);
      const publications = scheduled.mock.calls.flatMap(([, delay], index) => delay === 800 ? [scheduled.mock.results[index].value] : []);
      expect(publications, "the buffered level owns one pending publication timer").toHaveLength(1);
      cleared.mockClear();
      pending.get("src")!.release();
      await flushClock();

      expect(canvas.props!.nodes, "the final flush need not wait for the cadence").not.toBe(first);
      expect(cleared, "the completed run releases its pending timer immediately").toHaveBeenCalledWith(publications[0]);
      expect(dirs.map(reads)).toEqual([2, 2, 2]);
      expect(visibleIds()).toEqual(expect.arrayContaining(dirs.map((dir) => `${dir}/a.md`)));
      const finished = canvas.props!.nodes;
      await vi.advanceTimersByTimeAsync(1000);
      await flushClock();
      expect(canvas.props!.nodes, "the completed run cancels its pending publication").toBe(finished);
      expect(target.querySelector(".spine-warning")).toBeNull();
      expectUsable(target);
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
      vi.useRealTimers();
    }
  });

  test("publishes a buffered second retry by the cadence while the third request is still pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const { target, pending, started } = await controlledRetries();
      pending.get("docs")!.release();
      await flushClock();
      const first = canvas.props!.nodes;
      expect(visibleIds()).toContain("docs/a.md");
      await vi.advanceTimersByTimeAsync(200);
      pending.get("notes")!.release();
      await flushClock();
      expect(started).toEqual(["docs", "notes", "src"]);
      expect(canvas.props!.nodes).toBe(first);
      await vi.advanceTimersByTimeAsync(799);
      await flushClock();
      expect(canvas.props!.nodes, "buffered work waits until the publication cadence").toBe(first);
      await vi.advanceTimersByTimeAsync(1);
      await flushClock();

      expect(visibleIds(), "the recovered second level does not wait for the third request").toContain("notes/a.md");
      expect(canvas.props!.nodes).not.toBe(first);
      expect(visibleIds()).not.toContain("src/a.md");
      pending.get("src")!.release();
      await flushClock();
      expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));
      expectUsable(target);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["new generation", "destroy"] as const)("clears a pending publication timer on %s", async (transition) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { pending } = await controlledRetries();
      pending.get("docs")!.release();
      await flushClock();
      await vi.advanceTimersByTimeAsync(200);
      scheduled.mockClear();
      pending.get("notes")!.release();
      await flushClock();
      const publications = scheduled.mock.calls.flatMap(([, delay], index) => delay === 800 ? [scheduled.mock.results[index].value] : []);
      expect(publications, "the buffered level owns exactly one pending publication timer").toHaveLength(1);
      const handle = publications[0];
      cleared.mockClear();
      vi.mocked(directoryNodeId).mockClear();
      const replacement = gate();
      if (transition === "new generation") {
        const original = vi.mocked(api.fsGraph).getMockImplementation()!;
        vi.mocked(api.fsGraph).mockImplementation(async (options) => {
          if (options.path === "") {
            const response = await fixtureRead(options);
            await replacement.promise;
            return response;
          }
          return original(options);
        });
        reload();
      } else {
        for (const app of mounted.splice(0)) await unmount(app);
      }
      await flushClock();

      expect(cleared, "the abandoned run releases its pending timer immediately").toHaveBeenCalledWith(handle);
      await vi.advanceTimersByTimeAsync(1000);
      await flushClock();
      expect(probePublications(), "an abandoned timer never normalizes its buffered directory").toBe(0);
      pending.get("src")!.release();
      replacement.release();
      await flushClock();
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
      vi.useRealTimers();
    }
  });

  test("shortens a timeout produced by the real transport", async () => {
    const path = "/api/fs-graph?scope=directory&path=notes&depth=1&limit=128";
    let actual: unknown;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setFetchImpl((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }));
      const outcome = request("GET", path).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      actual = await outcome;
    } finally {
      setFetchImpl(null);
      vi.useRealTimers();
    }
    expect(actual).toBeInstanceOf(ApiError);
    const error = actual as ApiError;
    expect(error.status).toBe(0);
    const suffix = `: GET ${path}`;
    expect(error.message.endsWith(suffix)).toBe(true);
    const reason = error.message.slice(0, -suffix.length);
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      recordRead(options);
      throw error;
    });
    const { target } = await render();
    expect(reads("notes")).toBe(2);
    expect(warningText(target)).toBe(`Could not read directory notes: ${reason}`);
    expectUsable(target);
  });

  test.each(["hidden", "shared refresh"] as const)("flushes a completed retry when %s stops the remaining queue", async (transition) => {
    const shared = gate();
    graphServer.streamGate = shared.promise;
    const pending = new Map(["docs", "notes"].map((dir) => [dir, gate()]));
    const started: string[] = [];
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (!pending.has(options.path)) return fixtureRead(options);
      if (reads(options.path) === 0) {
        recordRead(options);
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      started.push(options.path);
      await pending.get(options.path)!.promise;
      return response;
    });
    const { target, show } = await render();
    shared.release();
    await settle();
    expect(started).toHaveLength(1);
    const first = started[0];
    const remaining = first === "docs" ? "notes" : "docs";
    let finishRefresh: (() => void) | undefined;
    let refreshing: Promise<void> | undefined;
    if (transition === "hidden") show(false);
    else {
      const refresh = gate();
      graphServer.streamGate = refresh.promise;
      finishRefresh = refresh.release;
      refreshing = refreshGraph();
    }
    await settle();
    pending.get(first)!.release();
    await settle();

    expect(reads(remaining), "the next retry waits for a visible, whole graph").toBe(1);
    expect(visibleIds(), "an early loop exit still publishes the successful level").toContain(`${first}/a.md`);
    if (transition === "hidden") show(true);
    else finishRefresh!();
    await refreshing;
    await settle();
    expect(reads(first), "the completed retry is not spent again").toBe(2);
    expect(reads(remaining)).toBe(2);
    pending.get(remaining)!.release();
    await settle();

    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
  });

  test.each(["success", "failure"] as const)("does not warn while an uncovered retry is waiting for %s", async (result) => {
    const pending = gate();
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      if (++attempts === 1) {
        recordRead(options);
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      await pending.promise;
      if (result === "failure") throw timeout(options.path);
      return response;
    });
    const { target } = await render();

    expect(reads("notes")).toBe(2);
    expect(target.querySelector(".spine-warning"), "an in-flight retry has not failed").toBeNull();
    expectUsable(target);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
    const waitingNodes = canvas.props!.nodes;
    pending.release();
    await settle();

    if (result === "success") {
      expect(target.querySelector(".spine-warning")).toBeNull();
      expect(visibleIds()).toContain("notes/a.md");
    } else {
      expect(warningText(target)).toBe("Could not read directory notes: request timed out after 10000 ms");
      expect(canvas.props!.nodes, "a failed retry does not republish an unchanged spine").toBe(waitingNodes);
    }
    expectUsable(target);
    expect(reads("notes")).toBe(2);
  });

  test.each(["hidden", "shared refresh"] as const)("keeps a successful retry that lands during %s", async (transition) => {
    const pending = gate();
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      if (++attempts === 1) {
        recordRead(options);
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      await pending.promise;
      return response;
    });
    const { target, show } = await render();
    expect(reads("notes")).toBe(2);
    let finishRefresh: (() => void) | undefined;
    let refreshing: Promise<void> | undefined;
    if (transition === "hidden") show(false);
    else {
      const shared = gate();
      graphServer.streamGate = shared.promise;
      finishRefresh = shared.release;
      refreshing = refreshGraph();
    }
    await settle();
    pending.release();
    await settle();
    if (transition === "hidden") show(true);
    else finishRefresh!();
    await refreshing;
    await settle();

    expect(visibleIds(), "the completed read remains the spine's answer").toContain("notes/a.md");
    expect(reads("notes"), "showing the tab or finishing the stream spends no second retry").toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
  });

  test.each(["deleted", "file", "empty directory"] as const)("drops a descendant warning when its parent becomes %s", async (replacement) => {
    graphServer.fs.nodes.push(fsg.dir("notes/sub"), fsg.file("notes/sub/a.md"));
    graphServer.fs.edges.push(fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/a.md"));
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes/sub") return fixtureRead(options);
      recordRead(options);
      throw timeout(options.path);
    });
    const { target } = await render({ ...opened, "notes/sub": true });
    expect(reads("notes/sub")).toBe(2);
    expect(warningText(target)).toContain("notes/sub");

    graphServer.fs.nodes = graphServer.fs.nodes.filter((node) => node.path !== "notes" && !node.path.startsWith("notes/"));
    graphServer.fs.edges = graphServer.fs.edges.filter((edge) => edge.target !== "notes" && !edge.target.startsWith("notes/"));
    if (replacement !== "deleted") {
      graphServer.fs.nodes.push(replacement === "file" ? fsg.file("notes") : fsg.dir("notes"));
      graphServer.fs.edges.push(fsg.contains("", "notes"));
    }
    await change(["notes"]);

    expect(target.querySelector(".spine-warning"), "the missing subtree no longer belongs to the spine").toBeNull();
    expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("directory:notes/sub");
    expect(reads("notes/sub"), "an authoritative parent answer cancels the failed child").toBe(2);
    expectUsable(target);
  });

  test("an ordinary patch can satisfy a retry queued behind it", async () => {
    const shared = gate();
    graphServer.streamGate = shared.promise;
    const patch = gate();
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      if (++attempts === 1) {
        recordRead(options);
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      if (attempts === 2) await patch.promise;
      return response;
    });
    const { target } = await render();
    expect(reads("notes")).toBe(1);
    await change(["notes/a.md"]);
    expect(reads("notes"), "the normal patch is already reading the failed directory").toBe(2);
    shared.release();
    await settle();
    expect(reads("notes"), "the retry waits behind the patch").toBe(2);
    patch.release();
    await settle();

    expect(reads("notes"), "the successful patch cancels the queued retry").toBe(2);
    expect(reads("")).toBe(1);
    expect(visibleIds()).toContain("notes/a.md");
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
  });

  test("a parent patch clears a failed child whose node never arrived", async () => {
    graphServer.fs.nodes.push(fsg.dir("notes/sub"), fsg.file("notes/sub/a.md"));
    graphServer.fs.edges.push(fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/a.md"));
    let failing = true;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (!failing || (options.path !== "notes" && options.path !== "notes/sub")) return fixtureRead(options);
      recordRead(options);
      throw timeout(options.path);
    });
    const { target } = await render({ ...opened, "notes/sub": true });
    expect(reads("notes")).toBe(2);
    expect(reads("notes/sub")).toBe(2);
    expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("directory:notes/sub");
    expect(warningText(target)).toContain("notes/sub");
    failing = false;
    graphServer.fs.nodes = graphServer.fs.nodes.filter((node) => node.path !== "notes/sub" && !node.path.startsWith("notes/sub/"));
    graphServer.fs.edges = graphServer.fs.edges.filter((edge) => edge.target !== "notes/sub" && !edge.target.startsWith("notes/sub/"));
    await change(["notes/a.md"]);

    expect(reads("notes")).toBe(3);
    expect(reads("notes/sub"), "the parent answer removes the failed child's pending state").toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expect(visibleIds()).toContain("notes/a.md");
    expectUsable(target);
  });

  test("a successful parent retry removes a queued child whose node never arrived", async () => {
    const shared = gate();
    graphServer.streamGate = shared.promise;
    graphServer.fs.nodes.push(fsg.dir("notes/sub"), fsg.file("notes/sub/a.md"));
    graphServer.fs.edges.push(fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/a.md"));
    let failing = true;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (!failing || (options.path !== "notes" && options.path !== "notes/sub")) return fixtureRead(options);
      recordRead(options);
      throw timeout(options.path);
    });
    const { target } = await render({ ...opened, "notes/sub": true });
    expect(reads("notes")).toBe(1);
    expect(reads("notes/sub")).toBe(1);
    expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("directory:notes/sub");
    graphServer.fs.nodes = graphServer.fs.nodes.filter((node) => !node.path.startsWith("notes/"));
    graphServer.fs.edges = graphServer.fs.edges.filter((edge) => !edge.target.startsWith("notes/"));
    failing = false;
    shared.release();
    await settle();

    expect(reads("notes")).toBe(2);
    expect(reads("notes/sub"), "the parent retry prunes the child from the queued snapshot").toBe(1);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
    expectUsable(target);
  });

  test.each(["hidden", "shared refresh"] as const)("defers a queued retry during %s before its request starts", async (transition) => {
    const firstShared = gate();
    graphServer.streamGate = firstShared.promise;
    const patch = gate();
    let noteAttempts = 0;
    let docAttempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path === "notes" && ++noteAttempts === 1) {
        recordRead(options);
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      if (options.path === "docs" && ++docAttempts === 2) await patch.promise;
      return response;
    });
    const { target, show } = await render();
    expect(reads("notes")).toBe(1);
    graphServer.fs.nodes.push(fsg.file("docs/late.md"));
    graphServer.fs.edges.push(fsg.contains("docs", "docs/late.md"));
    await change(["docs/late.md"]);
    expect(reads("docs"), "an unrelated normal patch holds the retry queue").toBe(2);
    firstShared.release();
    await settle();
    expect(reads("notes"), "shared completion queues the retry behind the patch").toBe(1);

    let finishRefresh: (() => void) | undefined;
    let refreshing: Promise<void> | undefined;
    if (transition === "hidden") show(false);
    else {
      const shared = gate();
      graphServer.streamGate = shared.promise;
      finishRefresh = shared.release;
      refreshing = refreshGraph();
    }
    await settle();
    patch.release();
    await settle();
    expect(reads("notes"), "a queued request rechecks visibility and the current complete graph").toBe(1);

    if (transition === "hidden") show(true);
    else finishRefresh!();
    await refreshing;
    await settle();
    expect(reads("notes"), "the deferred retry is still available").toBe(2);
    expect(reads("docs")).toBe(2);
    expect(reads("")).toBe(1);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/late.md", "notes/a.md"]));
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
  });

  test.each(["pending", "complete"] as const)("a buffered old retry cannot publish when the replacement root is %s", async (rootState) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      graphServer.fs.nodes.push(fsg.file("notes/old.md"));
      graphServer.fs.edges.push(fsg.contains("notes", "notes/old.md"));
      const { target, pending } = await controlledRetries();
      pending.get("docs")!.release();
      await flushClock();
      expect(visibleIds()).toContain("docs/a.md");
      await vi.advanceTimersByTimeAsync(200);
      pending.get("notes")!.release();
      await flushClock();
      expect(reads("src"), "the old queue waits on a third retry after buffering the second").toBe(2);
      expect(visibleIds()).not.toContain("notes/old.md");

      graphServer.fs.nodes = graphServer.fs.nodes.filter((node) => node.path !== "notes/old.md");
      graphServer.fs.edges = graphServer.fs.edges.filter((edge) => edge.target !== "notes/old.md");
      graphServer.fs.nodes.push(fsg.file("notes/new.md"));
      graphServer.fs.edges.push(fsg.contains("notes", "notes/new.md"));
      const replacement = gate();
      vi.mocked(api.fsGraph).mockImplementation(async (options) => {
        const response = await fixtureRead(options);
        if (options.path === "" && rootState === "pending") await replacement.promise;
        return response;
      });
      reload();
      await flushClock();
      expect(reads("")).toBe(2);
      expect(reads("notes")).toBe(3);
      if (rootState === "complete") expect(visibleIds()).toContain("notes/new.md");
      else expect(visibleIds()).not.toContain("notes/new.md");
      const replacementNodes = canvas.props!.nodes;
      const replacementIds = visibleIds();
      pending.get("src")!.release();
      await flushClock();

      expect(canvas.props!.nodes, "the old run cannot flush its buffered level over the replacement").toBe(replacementNodes);
      expect(visibleIds()).toEqual(replacementIds);
      expect(visibleIds()).not.toContain("notes/old.md");
      replacement.release();
      await flushClock();

      expect(visibleIds()).toContain("notes/new.md");
      expect(visibleIds()).not.toContain("notes/old.md");
      expect(reads("")).toBe(2);
      expect(reads("notes")).toBe(3);
      expect(target.querySelector(".spine-warning")).toBeNull();
      expectUsable(target);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a new load retries after an old retry finishes", async () => {
    const old = gate();
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      const attempt = ++attempts;
      if (attempt <= 3) {
        recordRead(options);
        if (attempt === 2) await old.promise;
        throw timeout(options.path);
      }
      return fixtureRead(options);
    });
    const { target } = await render();
    expect(reads("notes")).toBe(2);
    reload();
    await settle();
    expect(reads("notes"), "the new load runs while the old retry is pending").toBe(3);
    old.release();
    await settle();

    expect(reads("notes"), "the new generation receives its own retry").toBe(4);
    expect(visibleIds()).toContain("notes/a.md");
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
  });

  test.each([400, 404])("a retry answering %s treats the directory as gone", async (status) => {
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      recordRead(options);
      if (++attempts === 1) throw timeout(options.path);
      throw new ApiError(status, "directory is gone", { error: "directory is gone" });
    });
    const { target } = await render();

    expect(reads("notes")).toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
  });

  test("a retry reporting a missing workspace root remains fatal", async () => {
    const words = "workspace root does not exist: /ws";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const { target, pending } = await controlledRetries(new ApiError(404, words, { error: words, code: "workspace_root_missing" }));
      pending.get("docs")!.release();
      await flushClock();
      await vi.advanceTimersByTimeAsync(200);
      pending.get("notes")!.release();
      await flushClock();
      vi.mocked(directoryNodeId).mockClear();
      pending.get("src")!.release();
      await flushClock();

      expect(reads("docs"), "a retry succeeded before the later root failure").toBe(2);
      expect(reads("notes"), "a second successful level is buffered when the root fails").toBe(2);
      expect(target.querySelector(".placeholder.error")?.textContent).toBe(words);
      expect(target.querySelector(".cy.dim")).not.toBeNull();
      expect(canvas.props!.nodes).toHaveLength(0);
      expect(probePublications(), "a fatal error skips even the hidden final publication work").toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      await flushClock();
      expect(probePublications(), "a fatal run leaves no delayed publication").toBe(0);
      expect(target.querySelector(".spine-warning")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
