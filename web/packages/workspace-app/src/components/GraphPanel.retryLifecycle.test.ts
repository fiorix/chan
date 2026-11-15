// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
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
const timeout = () => new Error("request timed out");
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

function reads(path: string): number {
  return graphServer.fsGraphCalls.filter((call) => call.path === path).length;
}

async function render(expanded: Record<string, boolean> = opened): Promise<{
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
  await settle();
  return { target, show: (active) => { pane.activeTabId = active ? tab.id : "other-tab"; } };
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
  test.each(["success", "failure"] as const)("does not warn while an uncovered retry is waiting for %s", async (result) => {
    const pending = gate();
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      if (++attempts === 1) {
        recordRead(options);
        throw timeout();
      }
      const response = await fixtureRead(options);
      await pending.promise;
      if (result === "failure") throw timeout();
      return response;
    });
    const { target } = await render();

    expect(reads("notes")).toBe(2);
    expect(target.querySelector(".spine-warning"), "an in-flight retry has not failed").toBeNull();
    expectUsable(target);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
    pending.release();
    await settle();

    if (result === "success") {
      expect(target.querySelector(".spine-warning")).toBeNull();
      expect(visibleIds()).toContain("notes/a.md");
    } else {
      expect(target.querySelector(".spine-warning")?.textContent).toContain("notes");
      expect(target.querySelector(".spine-warning")?.textContent).toContain("request timed out");
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
        throw timeout();
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
      throw timeout();
    });
    const { target } = await render({ ...opened, "notes/sub": true });
    expect(reads("notes/sub")).toBe(2);
    expect(target.querySelector(".spine-warning")?.textContent).toContain("notes/sub");

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
        throw timeout();
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
      throw timeout();
    });
    const { target } = await render({ ...opened, "notes/sub": true });
    expect(reads("notes")).toBe(2);
    expect(reads("notes/sub")).toBe(2);
    expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("directory:notes/sub");
    expect(target.querySelector(".spine-warning")?.textContent).toContain("notes/sub");
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
      throw timeout();
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
        throw timeout();
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

  test("an old retry cannot replace a newer whole load", async () => {
    const old = gate();
    graphServer.fs.nodes.push(fsg.file("notes/old.md"));
    graphServer.fs.edges.push(fsg.contains("notes", "notes/old.md"));
    let attempts = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      if (++attempts === 1) {
        recordRead(options);
        throw timeout();
      }
      const response = await fixtureRead(options);
      if (attempts === 2) await old.promise;
      return response;
    });
    const { target } = await render();
    expect(reads("notes")).toBe(2);
    graphServer.fs.nodes = graphServer.fs.nodes.filter((node) => node.path !== "notes/old.md");
    graphServer.fs.edges = graphServer.fs.edges.filter((edge) => edge.target !== "notes/old.md");
    graphServer.fs.nodes.push(fsg.file("notes/new.md"));
    graphServer.fs.edges.push(fsg.contains("notes", "notes/new.md"));
    reload();
    await settle();
    expect(reads("notes")).toBe(3);
    old.release();
    await settle();

    expect(visibleIds()).toContain("notes/new.md");
    expect(visibleIds(), "the stale response is discarded").not.toContain("notes/old.md");
    expect(reads("notes")).toBe(3);
    expect(reads("")).toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
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
        throw timeout();
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
      if (++attempts === 1) throw timeout();
      throw new ApiError(status, "directory is gone", { error: "directory is gone" });
    });
    const { target } = await render();

    expect(reads("notes")).toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
    expectUsable(target);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
  });

  test("a retry reporting a missing workspace root remains fatal", async () => {
    let attempts = 0;
    const words = "workspace root does not exist: /ws";
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "notes") return fixtureRead(options);
      recordRead(options);
      if (++attempts === 1) throw timeout();
      throw new ApiError(404, words, { error: words, code: "workspace_root_missing" });
    });
    const { target } = await render();

    expect(reads("notes")).toBe(2);
    expect(target.querySelector(".placeholder.error")?.textContent).toBe(words);
    expect(target.querySelector(".cy.dim")).not.toBeNull();
    expect(canvas.props!.nodes).toHaveLength(0);
    expect(target.querySelector(".spine-warning")).toBeNull();
  });
});
