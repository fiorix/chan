// @vitest-environment jsdom

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
  g,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  settle,
  unmountGraphPanels,
  visibleIds,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { directoryNodeId } from "../graph/canvasNodes";
import { invalidateGraph, noteGraphChanged, refreshGraph } from "../state/graphData.svelte";
import { graphReloadSignal, indexStatus } from "../state/store.svelte";
import { layout } from "../state/tabs.svelte";

installGraphDom();

const fixtureRead = vi.mocked(api.fsGraph).getMockImplementation()!;
const opened = { docs: true, notes: true, src: true };
const timeout = (path = "notes") => new ApiError(0,
  `request timed out after 10000 ms: GET /api/fs-graph?scope=directory&path=${encodeURIComponent(path)}&depth=1&limit=128`,
);
let timers: TimerTrack;
let releaseStreams: Array<() => void>;

beforeEach(() => {
  timers = trackTimers();
  releaseStreams = [];
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

afterEach(() => {
  unmountGraphPanels();
  invalidateGraph();
  for (const release of releaseStreams) release();
  indexStatus.value = null;
  vi.mocked(api.fsGraph).mockReset().mockImplementation(fixtureRead);
  timers.release();
});

function holdSharedGraph(): () => void {
  let release!: () => void;
  graphServer.streamGate = new Promise<void>((resolve) => (release = resolve));
  releaseStreams.push(release);
  return release;
}

function coverNotes(): void {
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.file("notes/a.md")],
    edges: [
      g.edge(directoryNodeId(""), directoryNodeId("notes"), "contains"),
      g.edge(directoryNodeId("notes"), "notes/a.md", "contains"),
    ],
  };
}

function failLevel(path: string, failures = Infinity, error: (path: string) => Error = timeout): void {
  vi.mocked(api.fsGraph).mockImplementation(async (options) => {
    if (options.path === path && failures-- > 0) {
      graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
      throw error(options.path);
    }
    return fixtureRead(options);
  });
}

function warningText(target: HTMLElement): string {
  const warning = target.querySelector(".spine-warning");
  expect(warning, "an uncovered failed retry displays a warning").not.toBeNull();
  return warning!.textContent!.trim();
}

function reads(path: string): number {
  return graphServer.fsGraphCalls.filter((call) => call.path === path).length;
}

function reloadCommand(): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }));
}

async function change(paths: string[]): Promise<string[]> {
  vi.useFakeTimers();
  try {
    const before = graphServer.fsGraphCalls.length;
    noteGraphChanged(() => true);
    graphReloadSignal.paths = paths;
    graphReloadSignal.nonce += 1;
    await vi.runAllTimersAsync();
    return graphServer.fsGraphCalls.slice(before).map((call) => call.path);
  } finally {
    vi.useRealTimers();
  }
}

describe("a failed nonroot filesystem level", () => {
  test.each([
    ["timeout", timeout],
    ["dropped connection", () => new TypeError("Failed to fetch")],
  ] as const)("keeps successful levels through a %s and retries after the shared graph is whole", async (_kind, error) => {
    const release = holdSharedGraph();
    failLevel("notes", 1, error);
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));

    expect(reads("notes"), "no retry while the shared graph is pending").toBe(1);
    expect.soft(visibleIds(), "levels before and after notes both survive").toEqual(
      expect.arrayContaining(["docs/a.md", "src/a.md"]),
    );
    expect.soft(target.querySelector(".cy.dim")).toBeNull();
    expect.soft(target.querySelector(".placeholder.error")).toBeNull();

    release();
    await settle();
    expect(reads("notes"), "one retry when the shared graph becomes whole").toBe(2);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));
    expect(target.querySelector(".cy.dim")).toBeNull();
    expect(target.querySelector(".placeholder.error")).toBeNull();
  });

  test("a second failure covered by the whole shared graph stays quiet and is not retried again", async () => {
    const release = holdSharedGraph();
    coverNotes();
    failLevel("notes");
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));
    expect(reads("notes")).toBe(1);

    release();
    await settle();
    expect.soft(reads("notes")).toBe(2);
    expect.soft(target.querySelector(".placeholder.error")).toBeNull();
    expect.soft(target.querySelector(".cy.dim")).toBeNull();
    expect.soft(target.querySelector(".spine-warning")).toBeNull();
    expect.soft(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));

    await refreshGraph();
    await settle();
    expect(reads("notes"), "another complete shared graph does not spend another retry").toBe(2);
    expect(target.querySelector(".spine-warning")).toBeNull();
  });

  test.each([
    ["timeout", timeout, "request timed out after 10000 ms"],
    ["dropped connection", () => new TypeError("Failed to fetch"), "Failed to fetch"],
  ] as const)("a second uncovered %s names its directory and short reason without dimming the retained graph", async (_kind, error, reason) => {
    failLevel("notes", Infinity, error);
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));

    expect.soft(reads("notes")).toBe(2);
    expect(warningText(target)).toBe(`Could not read directory notes: ${reason}`);
    expect.soft(target.querySelector(".placeholder.error")).toBeNull();
    expect.soft(target.querySelector(".cy.dim")).toBeNull();
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "src/a.md"]));
  });

  test("successful levels remain the patch base for later filesystem changes", async () => {
    failLevel("notes", 1);
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));
    graphServer.fs.nodes.push(fsg.file("src/late.md"));
    graphServer.fs.edges.push(fsg.contains("src", "src/late.md"));

    expect(await change(["src/late.md"]), "only the changed level is fetched").toEqual(["src"]);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md", "src/late.md"]));
    expect(reads(""), "the root is not fetched again").toBe(1);
  });

  test("several failures keep filling the bounded read queue", async () => {
    const dirs = ["a", "b", "c", "d", "e", "f"];
    graphServer.fs = {
      nodes: [fsg.dir(""), ...dirs.map(fsg.dir)],
      edges: dirs.map((dir) => fsg.contains("", dir)),
    };
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path !== "") {
        graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
        throw timeout(options.path);
      }
      return fixtureRead(options);
    });
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({
      expanded: Object.fromEntries(dirs.map((dir) => [dir, true])),
    }));

    expect(dirs.map(reads)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(target.querySelector(".placeholder.error")).toBeNull();
    expect(target.querySelector(".cy.dim")).toBeNull();
    const warning = warningText(target);
    for (const dir of dirs) expect(warning).toContain(`directory ${dir}:`);
  });

  test("a failed later page retries the directory from its first page", async () => {
    graphServer.fsPageSize = 1;
    let fail = true;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path === "notes" && options.cursor !== undefined && fail) {
        fail = false;
        graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
        throw timeout(options.path);
      }
      return fixtureRead(options);
    });
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));

    expect(graphServer.fsGraphCalls.filter((call) => call.path === "notes").map((call) => call.cursor)).toEqual([
      undefined, "1", undefined, "1",
    ]);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));
    expect(target.querySelector(".placeholder.error")).toBeNull();
  });
});

describe("root failures remain fatal", () => {
  test.each([
    ["timeout", () => timeout("")],
    ["404", () => new ApiError(404, "no such path: /ws", { error: "no such path: /ws" })],
  ] as const)("a root %s still fails the tab load", async (_kind, error) => {
    coverNotes();
    failLevel("", Infinity, error);
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab());

    expect(target.querySelector(".placeholder.error")?.textContent).toBe(error().message);
    expect(target.querySelector(".cy.dim")).not.toBeNull();
    expect(reads("")).toBe(1);
  });

  test.each(["", "notes"])("a missing workspace root reported by level '%s' discards the shared graph", async (path) => {
    coverNotes();
    const words = "workspace root does not exist: /ws";
    failLevel(path, Infinity, () => new ApiError(404, words, { error: words, code: "workspace_root_missing" }));
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));

    expect(target.querySelector(".placeholder.error")?.textContent).toBe(words);
    expect(canvas.props!.nodes).toHaveLength(0);
    expect(reads(path)).toBe(1);
  });
});

describe("a failed level belongs to its load", () => {
  test("a superseded rejection cannot retry or fail the replacement load", async () => {
    const release = holdSharedGraph();
    let rejectOld!: (reason: Error) => void;
    let first = true;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path === "notes" && first) {
        first = false;
        graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
        return new Promise<Awaited<ReturnType<typeof api.fsGraph>>>((_resolve, reject) => (rejectOld = reject));
      }
      return fixtureRead(options);
    });
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));

    reloadCommand();
    await settle();
    rejectOld(timeout());
    release();
    await settle();

    expect(reads("notes")).toBe(2);
    expect(visibleIds()).toEqual(expect.arrayContaining(["docs/a.md", "notes/a.md", "src/a.md"]));
    expect(target.querySelector(".placeholder.error")).toBeNull();
    expect(target.querySelector(".cy.dim")).toBeNull();
  });

  test("closing the panel cancels its queued retry", async () => {
    const release = holdSharedGraph();
    let releasePatch!: () => void;
    const patch = new Promise<void>((resolve) => (releasePatch = resolve));
    releaseStreams.push(releasePatch);
    let docsReads = 0;
    vi.mocked(api.fsGraph).mockImplementation(async (options) => {
      if (options.path === "notes") {
        graphServer.fsGraphCalls.push({ path: options.path, depth: options.depth ?? 1, cursor: options.cursor });
        throw timeout(options.path);
      }
      const response = await fixtureRead(options);
      if (options.path === "docs" && ++docsReads === 2) await patch;
      return response;
    });
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...opened } }));
    expect(reads("notes")).toBe(1);
    await change(["docs/a.md"]);
    expect(reads("docs")).toBe(2);
    release();
    await settle();
    expect(reads("notes"), "the retry waits behind the normal patch").toBe(1);

    unmountGraphPanels();
    releasePatch();
    await settle();

    expect(reads("notes")).toBe(1);
  });
});
