// @vitest-environment jsdom
//
// What the one graph draws for a selection. GraphPanel is mounted on the real
// tab model with the api served from a fixed graph, and the assertions read
// what it hands the canvas: the workspace's tree as far as the tab has it
// opened, with what the selected node reveals laid over it. The rules
// themselves are graph/selectionView's, tested there; these tests hold the
// panel to them.

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
import {
  canvas,
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
import { openedForPath } from "../graph/selectionView";
import { layout, type GraphTab } from "../state/tabs.svelte";

installGraphDom();

const A = "notes/a.md";
const B = "notes/b.md";
const C = "notes/c.md";
const DEEP = "notes/deep/d.md";
const MAIN = "src/main.rs";
const NOTES = "directory:notes";
const NOTES_DEEP = "directory:notes/deep";
const SRC = "directory:src";
const ROOT = "";

/// notes/{a,b,c}.md, notes/deep/d.md and src/main.rs under the root, with:
///   a -> #t, b -> #t, c -> #other            (tags)
///   c -> a, a -> b, d -> c                   (links)
///   b -> @@alice                             (mention)
///   main.rs -> rust                          (language)
function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("notes/deep"),
      g.dir("src"),
      g.file("notes/a.md"),
      g.file("notes/b.md"),
      g.file("notes/c.md"),
      g.file("notes/deep/d.md"),
      g.file("src/main.rs"),
      g.tag("t"),
      g.tag("other"),
      g.mention("alice"),
      g.language("rust"),
    ],
    edges: [
      g.edge(ROOT, NOTES, "contains"),
      g.edge(ROOT, SRC, "contains"),
      g.edge(NOTES, NOTES_DEEP, "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge(NOTES, B, "contains"),
      g.edge(NOTES, C, "contains"),
      g.edge(NOTES_DEEP, DEEP, "contains"),
      g.edge(SRC, MAIN, "contains"),
      g.edge(A, "#t", "tag"),
      g.edge(B, "#t", "tag"),
      g.edge(C, "#other", "tag"),
      g.edge(C, A, "link"),
      g.edge(A, B, "link"),
      g.edge(DEEP, C, "link"),
      g.edge(B, "@@alice", "mention"),
      g.edge(MAIN, "language:rust", "language"),
    ],
  };
}

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  serveGraph();
});

afterEach(() => {
  unmountGraphPanels();
  timers.release();
});

/// A graph tab opened on `select`, as the openers build one, and the ids the
/// canvas is told to draw.
async function selecting(select: string, over: Partial<GraphTab> = {}): Promise<string[]> {
  await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: select, ...over }));
  return visibleIds();
}

/// The root's own level, which every graph draws whatever is selected.
const ROOT_LEVEL = [ROOT, NOTES, SRC];

describe("a tag selected", () => {
  test("shows the notes that carry it, on the workspace's tree", async () => {
    const ids = await selecting("#t");
    expect(canvas.props?.selectedId).toBe("#t");
    expect(ids).toEqual(expect.arrayContaining([...ROOT_LEVEL, A, B, "#t"]));
    expect(ids, "c does not carry it and notes/ is closed").not.toContain(C);
    expect(ids, "src/ is closed").not.toContain(MAIN);
  });

  test("goes one hop of references further per depth step, both ways", async () => {
    const ids = await selecting("#t", { depth: 2 });
    expect(ids, "c links to a, one hop back from a").toContain(C);
    expect(ids, "d links to c, a third hop").not.toContain(DEEP);
  });

  test("draws a tag or mention wherever an edge reaches a note that is drawn", async () => {
    const ids = await selecting("#t");
    expect(ids, "b is drawn and mentions alice").toContain("@@alice");
    expect(ids, "only c carries #other, and c is not drawn").not.toContain("#other");
  });
});

describe("a mention selected", () => {
  test("shows what mentions it", async () => {
    const ids = await selecting("@@alice");
    expect(ids).toEqual(expect.arrayContaining([...ROOT_LEVEL, B, "@@alice"]));
    expect(ids, "a does not mention alice").not.toContain(A);
  });
});

describe("a file selected", () => {
  test("shows what it links to and what links to it, each on its directories", async () => {
    const ids = await selecting(A);
    expect(ids, "a links to b").toContain(B);
    expect(ids, "c links to a").toContain(C);
    expect(ids).toContain("#t");
    expect(ids, "d is two links away").not.toContain(DEEP);
  });

  test("is drawn with every directory down to the root, through closed ones", async () => {
    const ids = await selecting(DEEP);
    expect(ids).toEqual(expect.arrayContaining([DEEP, NOTES_DEEP, NOTES, ROOT]));
    expect(ids, "d links to c").toContain(C);
    expect(ids, "a is two links on").not.toContain(A);
  });
});

describe("a language selected", () => {
  test("shows its files, one hop whatever the depth", async () => {
    for (const depth of [1, 3]) {
      const ids = await selecting("language:rust", { depth });
      expect(ids, `depth ${depth}`).toEqual(expect.arrayContaining([...ROOT_LEVEL, MAIN, "language:rust"]));
      expect(ids, `depth ${depth}: no note is a rust file`).not.toContain(A);
      unmountGraphPanels();
    }
  });
});

describe("a directory selected", () => {
  test("opened by its opener, shows its own children and no deeper", async () => {
    const ids = await selecting("notes", { expanded: openedForPath("notes") });
    expect(canvas.props?.selectedId, "the path resolves to the directory's node").toBe(NOTES);
    expect(ids).toEqual(expect.arrayContaining([...ROOT_LEVEL, A, B, C, NOTES_DEEP]));
    expect(ids).not.toContain(DEEP);
    expect(ids, "src/ is another branch, still closed").not.toContain(MAIN);
  });

  test("still closed, is drawn with nothing below it", async () => {
    const ids = await selecting("notes/deep");
    expect(canvas.props?.selectedId).toBe(NOTES_DEEP);
    expect(ids).toEqual(expect.arrayContaining([...ROOT_LEVEL, NOTES_DEEP]));
    expect(ids).not.toContain(DEEP);
    expect(ids, "notes/ is on the path, not opened").not.toContain(A);
  });
});

describe("whatever is selected", () => {
  test.each(["", "#t", "@@alice", A, "language:rust", "notes"])(
    "%j: the workspace's node is pinned, the view takes the default framing",
    async (select) => {
      await selecting(select);
      expect(canvas.props?.focalIds).toEqual([""]);
      expect(canvas.props?.focalAnchor).toBeUndefined();
      expect(canvas.props?.scopeKey, "one graph, one view: no scope to change it").toBeUndefined();
    },
  );

  test("a new selection starts the depth over, and loads nothing", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ pendingSelectId: "#t", depth: 2 }),
    );
    expect(visibleIds(), "two hops from #t").toContain(C);
    const streams = graphServer.graphStreamCalls;

    canvas.props!.onSelect(B);
    await settle();
    expect(tab.depth).toBe(1);
    const ids = visibleIds();
    expect(ids, "b mentions alice").toContain("@@alice");
    expect(ids, "c neither links to b nor is linked from it").not.toContain(C);
    expect(graphServer.graphStreamCalls, "the selection chose from what was loaded").toBe(streams);
  });

  test("selecting the same node again keeps its depth", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ pendingSelectId: "#t", depth: 2 }),
    );
    canvas.props!.onSelect("#t");
    await settle();
    expect(tab.depth).toBe(2);
  });
});
