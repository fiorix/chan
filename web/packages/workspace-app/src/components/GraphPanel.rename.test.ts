// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
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
import { openedForPath } from "../graph/selectionView";
import { parentDir } from "../state/format";
import { invalidateGraph, noteGraphChanged } from "../state/graphData.svelte";
import { graphReloadSignal, indexStatus } from "../state/store.svelte";
import { layout } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  indexStatus.value = null;
});

afterEach(() => {
  unmountGraphPanels();
  indexStatus.value = null;
  timers.release();
});

const OLD = "releases/v2/old.md";
const NEW = "releases/v2/new.md";
const MOVED = "releases/v3/old.md";
const RENAME_PATHS = ["releases/v2", "releases/v3", "releases/v1", "releases/v2"];

function serveTree(renamed: boolean, shared = false): void {
  const versions = renamed ? ["releases/v2", "releases/v3"] : ["releases/v1", "releases/v2"];
  const files = renamed ? [NEW, MOVED, "docs/d.md"] : ["releases/v1/new.md", OLD, "docs/d.md"];
  const dirs = ["", "releases", "docs", ...versions];
  graphServer.fs = {
    nodes: [...dirs.map(fsg.dir), ...files.map(fsg.file)],
    edges: [...dirs.slice(1), ...files].map((path) => fsg.contains(parentDir(path), path)),
  };
  graphServer.view = shared
    ? {
        nodes: [...dirs.map(g.dir), ...files.map((path) => g.file(path))],
        edges: [
          ...dirs.slice(1).map((path) => g.edge(directoryNodeId(parentDir(path)), directoryNodeId(path), "contains")),
          ...files.map((path) => g.edge(directoryNodeId(parentDir(path)), path, "contains")),
        ],
      }
    : { nodes: [], edges: [] };
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

test.each([
  ["the spine alone", false],
  ["the shared graph over the spine", true],
] as const)("a replacement directory's children are drawn from %s", async (_source, shared) => {
  serveTree(false, shared);
  await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("releases/v2") }));
  expect(visibleIds()).toContain(OLD);
  expect(visibleIds()).not.toContain(NEW);

  serveTree(true, shared);
  const reads = await change(RENAME_PATHS);

  expect(visibleIds(), "the old file moved to a different directory").not.toContain(OLD);
  expect(visibleIds(), "the replacement directory's child is drawn without a reload").toContain(NEW);
  expect(canvas.props!.nodes.map((node) => node.id)).not.toContain(OLD);
  if (shared) expect(canvas.props!.nodes.map((node) => node.id)).toContain(MOVED);
  expect(reads, "only the parent and the held directory need new levels").toEqual(["releases", "releases/v2"]);
});

test("a named directory whose children were never held does not widen the patch", async () => {
  serveTree(false);
  await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("releases") }));
  expect(graphServer.fsGraphCalls.map((call) => call.path)).toEqual(["", "releases"]);

  expect(await change(["releases/v1"])).toEqual(["releases"]);
  expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("releases/v1/new.md");
});

test("a renamed directory refreshes its retained children while closed", async () => {
  serveTree(false);
  const { tab } = await mountGraphPanel(
    GraphPanel,
    layout,
    graphTab({ expanded: { ...openedForPath("releases/v2"), docs: true } }),
  );
  expect(visibleIds()).toContain(OLD);
  delete tab.expanded["releases/v2"];
  await settle();
  expect(visibleIds()).not.toContain(OLD);
  expect(canvas.props!.nodes.map((node) => node.id), "closing retains the read level").toContain(OLD);

  serveTree(true);
  const reads = await change(RENAME_PATHS);

  expect(reads).toEqual(["releases", "releases/v2"]);
  expect(canvas.props!.nodes.map((node) => node.id)).toContain(NEW);
  expect(canvas.props!.nodes.map((node) => node.id)).not.toContain(OLD);
  expect(visibleIds()).not.toContain(NEW);

  tab.expanded["releases/v2"] = true;
  await settle();
  expect(visibleIds()).toContain(NEW);
  expect(visibleIds()).not.toContain(OLD);
});

test("a patch with as many directories as a whole fetch reads the open tree instead", async () => {
  serveTree(false);
  const { tab } = await mountGraphPanel(
    GraphPanel,
    layout,
    graphTab({ expanded: { ...openedForPath("releases/v2"), docs: true } }),
  );
  expect(visibleIds()).toContain("docs/d.md");
  delete tab.expanded.docs;
  await settle();

  serveTree(true);
  // docs/ remains held after closing, so these changes name three held
  // levels. A whole fetch reads the root and the two opened directories.
  const reads = await change([...RENAME_PATHS, "docs/changed.md"]);

  expect(reads).toEqual(["", "releases", "releases/v2"]);
  expect(visibleIds()).toContain(NEW);
  expect(visibleIds()).not.toContain(OLD);
  expect(canvas.props!.nodes.map((node) => node.id)).not.toContain("docs/d.md");
});
