// @vitest-environment jsdom
//
// The workspace's drafts in the graph. A draft is kept outside the workspace,
// so the graph the server sends has no node for one. The panel still hands the
// canvas a Drafts group hung from the workspace's node and one node per listed
// draft: drawn and selectable, and nothing more. No chip counts one, the depth
// slider and a lens read the same with them and without, and only the
// whole-workspace content graph draws them.

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
  fsg,
  g,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  settle,
  unmountGraphPanels,
  visibleIds,
  type CanvasProps,
} from "../__tests__/graphPanel";
import { draftPath } from "../__tests__/drafts";
import { api } from "../api/client";
import type { DraftListEntry } from "../api/types";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshDrafts, resetDraftsForTests } from "../state/drafts.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, type FileTab, type GraphTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

const MARK = String.fromCharCode(0);
/// The mark as a serializer would spell it.
const MARK_TEXT = "\\" + "u0000";
const GROUP = "drafts:";
const SENTENCE =
  "Drafts are kept outside the workspace. They are not in search or the graph until saved to the workspace.";

const A = "notes/a.md";
const B = "notes/b.md";
const MAIN = "src/main.rs";
const NOTES = "directory:notes";
const SRC = "directory:src";

/// The root with notes/{a,b}.md and src/main.rs, a tag on a.md and b.md and
/// one language; the same tree on disk for the depth probe.
function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("src"),
      g.file(A),
      g.file(B),
      g.file(MAIN),
      g.tag("t"),
      g.language("rust"),
    ],
    edges: [
      g.edge("", NOTES, "contains"),
      g.edge("", SRC, "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge(NOTES, B, "contains"),
      g.edge(SRC, MAIN, "contains"),
      g.edge(A, "#t", "tag"),
      g.edge(B, "#t", "tag"),
      g.edge(MAIN, "language:rust", "language"),
    ],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("src"), fsg.file(A), fsg.file(B), fsg.file(MAIN)],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("", "src"),
      fsg.contains("notes", A),
      fsg.contains("notes", B),
      fsg.contains("src", MAIN),
    ],
  };
}

function row(name: string, over: Partial<DraftListEntry> = {}): DraftListEntry {
  return { name, draftId: `life-${name}`, path: draftPath(name), hasAttachments: false, busy: false, ...over };
}

let timers: TimerTrack;
/// A spy this file installed, to take off again.
type Spy = { mockRestore(): void };
let listSpy: Spy | null = null;
let readSpy: Spy | null = null;

/// What the server's drafts list answers from here on.
function listed(rows: DraftListEntry[]): void {
  listSpy?.mockRestore();
  listSpy = vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: rows, warnings: [] });
}

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  resetDraftsForTests();
  serveGraph();
});

afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  listSpy?.mockRestore();
  listSpy = null;
  readSpy?.mockRestore();
  readSpy = null;
  resetDraftsForTests();
  timers.release();
});

/// The whole workspace's content graph, every directory expanded.
function workspaceTab(over: Partial<GraphTab> = {}): GraphTab {
  return graphTab({ scopeId: "workspace", expanded: { "": true, notes: true, src: true }, ...over });
}

type Drawn = { id: string; kind: string; label?: string; group?: boolean };

/// What the canvas holds now. Read through a call, so a test that clears it
/// before a second mount reads the second mount's.
function handed(): CanvasProps | null {
  return canvas.props;
}

/// The nodes the canvas was handed that are a draft's or the group's.
function draftNodes(): Drawn[] {
  return (canvas.props?.nodes ?? []).filter((n) => n.kind === "draft");
}

function draftEdges(edges: Array<{ source: string; target: string; kind: string }> | undefined): string[] {
  return (edges ?? [])
    .filter((e) => e.source === GROUP || e.target === GROUP)
    .map((e) => `${e.source} -> ${e.target} (${e.kind})`);
}

/// Everything the canvas was handed, as text.
function handedText(): string {
  const p = canvas.props!;
  return JSON.stringify([p.nodes, p.edges, [...p.visibleNodeIds], p.visibleEdges, p.focalIds]);
}

async function select(id: string): Promise<void> {
  canvas.props!.onSelect(id);
  await settle();
}

/// What a person can read or hear in the inspector: its text, titles and
/// aria labels.
function readable(target: HTMLElement): string {
  const inspector = target.querySelector<HTMLElement>(".inspector");
  if (!inspector) return "";
  const parts = [inspector.textContent ?? ""];
  for (const el of inspector.querySelectorAll("[title], [aria-label]")) {
    parts.push(el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ");
}

function inspectorButton(target: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...target.querySelectorAll<HTMLButtonElement>(".inspector button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

function paneTabs(): LeafNode["tabs"] {
  return (layout.nodes[GRAPH_PANE] as LeafNode).tabs;
}

async function chipCounts(tab: GraphTab): Promise<Record<string, number>> {
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const rows = [...document.body.querySelectorAll<HTMLButtonElement>(".tab-menu-bubble .filter-row")];
  return Object.fromEntries(
    rows.map((b) => [
      b.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
      Number(b.querySelector(".filter-count")?.textContent),
    ]),
  );
}

function depthMax(): string | undefined {
  return document.body.querySelector<HTMLInputElement>(".tab-menu-bubble .depth-row input[type='range']")?.max;
}

describe("the workspace's drafts in its graph", () => {
  test("the canvas is handed a Drafts group under the workspace's node and one node per listed draft", async () => {
    listed([row("untitled"), row("sketch", { hasAttachments: true })]);
    await mountGraphPanel(GraphPanel, layout, workspaceTab());

    expect.soft(listSpy, "the list is asked for once as the graph is first shown").toHaveBeenCalledTimes(1);
    expect.soft(draftNodes()).toEqual([
      { kind: "draft", id: GROUP, label: "Drafts", group: true },
      { kind: "draft", id: "draft:untitled", label: "untitled", group: false },
      { kind: "draft", id: "draft:sketch", label: "sketch", group: false },
    ]);
    const hung = [
      ` -> ${GROUP} (contains)`,
      `${GROUP} -> draft:untitled (contains)`,
      `${GROUP} -> draft:sketch (contains)`,
    ];
    expect.soft(draftEdges(canvas.props?.edges), "the group hangs from the root, each draft from the group").toEqual(hung);
    expect.soft(draftEdges(canvas.props?.visibleEdges), "and those edges are drawn").toEqual(hung);
    expect.soft(visibleIds(), "all three are drawn").toEqual(
      expect.arrayContaining([GROUP, "draft:untitled", "draft:sketch"]),
    );
    // A draft's node is named by the draft's name alone.
    const text = handedText();
    expect.soft(text.includes(MARK) || text.includes(MARK_TEXT), "no path mark reaches the canvas").toBe(false);
    expect.soft(text, "nor the id of a draft's lifetime").not.toContain("life-");
  });

  test("a draft that leaves the list leaves the graph", async () => {
    listed([row("untitled"), row("sketch")]);
    await mountGraphPanel(GraphPanel, layout, workspaceTab());
    expect.soft(draftNodes().map((n) => n.id)).toEqual([GROUP, "draft:untitled", "draft:sketch"]);

    listed([row("sketch")]);
    await refreshDrafts();
    await settle();
    expect.soft(draftNodes().map((n) => n.id)).toEqual([GROUP, "draft:sketch"]);
    expect.soft(visibleIds()).not.toContain("draft:untitled");

    listed([]);
    await refreshDrafts();
    await settle();
    expect(draftNodes(), "with no draft listed there is no group either").toEqual([]);
  });

  test("the Drafts group's inspector says where drafts are kept", async () => {
    listed([row("untitled")]);
    const { target } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    await select(GROUP);

    const said = readable(target);
    expect.soft(target.querySelector(".inspector .drafts-chip")?.textContent).toBe("DRAFTS");
    expect.soft(target.querySelector(".inspector .info .title")?.textContent).toBe("Drafts");
    expect.soft(said).toContain(SENTENCE);
    expect.soft(inspectorButton(target, "Open"), "the group opens nothing").toBeUndefined();
  });

  test("a draft's inspector names it and opens its primary in the editor", async () => {
    readSpy = vi
      .spyOn(api, "readStream")
      .mockResolvedValue({ path: "untitled/draft.md", content: "# Draft\n", mtime: 1, writable: true });
    listed([row("untitled")]);
    const { target } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    await select("draft:untitled");

    const said = readable(target);
    expect.soft(target.querySelector(".inspector .drafts-chip")?.textContent).toBe("DRAFTS");
    expect.soft(target.querySelector(".inspector .info .title")?.textContent).toBe("untitled");
    expect.soft(said).toContain(SENTENCE);
    expect.soft(said, "the path as a person reads it").toContain("Drafts/untitled/draft.md");
    expect.soft(said.includes(MARK), "never the mark").toBe(false);
    expect.soft(said, "nor the id of the draft's lifetime").not.toContain("life-");

    const open = inspectorButton(target, "Open");
    expect.soft(open, "an Open button").toBeDefined();
    open?.click();
    await settle();
    const opened = paneTabs().find((t): t is FileTab => t.kind === "file");
    expect.soft(opened?.path, "the draft's own file, by its client path").toBe(draftPath("untitled"));
  });

  test("a busy draft the server names no file for is drawn, says so and opens nothing", async () => {
    listed([row("closing", { path: null, busy: true })]);
    const { target } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    await select("draft:closing");

    expect.soft(draftNodes().map((n) => n.id)).toEqual([GROUP, "draft:closing"]);
    expect.soft(target.querySelector(".inspector .info .title")?.textContent).toBe("closing");
    expect.soft(target.querySelector(".inspector .draft-busy")?.textContent).toBe("This draft is busy.");
    expect.soft(inspectorButton(target, "Open")).toBeUndefined();
    expect.soft(target.querySelector(".inspector .draft-path"), "there is no file to name").toBeNull();
  });

  test("a selected draft or group is not kept as the tab's saved selection", async () => {
    listed([row("untitled")]);
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());

    await select(A);
    expect(tab.selectedNodeId, "a workspace file's node is kept").toBe(A);
    await select("draft:untitled");
    expect.soft(canvas.props?.selectedId, "the canvas shows the draft selected").toBe("draft:untitled");
    expect.soft(tab.selectedNodeId, "a draft's node is not").toBeNull();
    expect.soft(tab.selectedNodeLabel).toBeNull();
    await select(GROUP);
    expect.soft(tab.selectedNodeId, "nor the group's").toBeNull();
  });

  test("a selected draft that leaves the list takes its selection with it", async () => {
    listed([row("untitled"), row("sketch")]);
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    await select("draft:untitled");
    expect(canvas.props?.selectedId).toBe("draft:untitled");

    listed([row("sketch")]);
    await refreshDrafts();
    await settle();
    expect.soft(handed()?.selectedId ?? null, "the node is gone, and the selection with it").toBeNull();
    expect.soft(tab.selectedNodeId ?? null, "nothing of it is saved").toBeNull();

    // The last draft gone takes the group's selection the same way.
    await select(GROUP);
    listed([]);
    await refreshDrafts();
    await settle();
    expect.soft(handed()?.selectedId ?? null, "the group's selection").toBeNull();
    expect.soft(tab.selectedNodeId ?? null).toBeNull();

    // A workspace node selected next is left alone.
    await select(A);
    expect.soft(handed()?.selectedId).toBe(A);
    expect.soft(tab.selectedNodeId).toBe(A);
  });

  test("a node of the workspace's graph keeps an id a draft's node would take", async () => {
    // A file at the workspace's root can be named like a draft's node id.
    graphServer.view.nodes.push(g.file("draft:untitled"));
    graphServer.view.edges.push(g.edge("", "draft:untitled", "contains"));
    listed([row("untitled"), row("sketch")]);
    const { target } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ inspectorOpen: true }));

    const same = (canvas.props?.nodes ?? []).filter((n) => n.id === "draft:untitled");
    expect.soft(same.map((n) => n.kind), "one node of that id, the file's").toEqual(["file"]);
    expect.soft(draftNodes().map((n) => n.id), "the other draft and the group are drawn").toEqual([
      GROUP,
      "draft:sketch",
    ]);
    await select("draft:untitled");
    expect.soft(target.querySelector(".inspector .drafts-chip"), "and its selection is the file's").toBeNull();
  });
});

describe("what the drafts leave as it was", () => {
  test("the chip counts, the depth slider and the loaded graph read the same with and without listed drafts", async () => {
    async function reading(rows: DraftListEntry[]) {
      listed(rows);
      const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
      const counts = await chipCounts(tab);
      const depth = depthMax();
      const isDraft = (id: string) => id === GROUP || id.startsWith("draft:");
      const out = {
        counts,
        depth,
        nodes: (canvas.props?.nodes ?? []).filter((n) => n.kind !== "draft").map((n) => n.id),
        edges: (canvas.props?.edges ?? []).filter((e) => !isDraft(e.source) && !isDraft(e.target)).length,
        visible: visibleIds().filter((id) => !isDraft(id)),
        focal: canvas.props?.focalIds,
        drawnDrafts: draftNodes().length,
      };
      closeTabMenu();
      unmountGraphPanels();
      resetDraftsForTests();
      canvas.props = null;
      return out;
    }

    const without = await reading([]);
    const withDrafts = await reading([row("untitled"), row("sketch"), row("plan")]);

    // What the graph reads on its own, so the comparison is of something.
    expect(without.drawnDrafts).toBe(0);
    expect(without.counts, "the fixture's own counts").toMatchObject({ folder: 3, markdown: 2, source: 1, tag: 1 });
    expect(without.depth, "notes/a.md is two levels down").toBe("2");
    // The premise: with drafts listed they are drawn.
    expect(withDrafts.drawnDrafts, "the group and three drafts").toBe(4);
    expect(withDrafts.counts).toEqual(without.counts);
    expect(withDrafts.depth).toBe(without.depth);
    expect(withDrafts.nodes).toEqual(without.nodes);
    expect(withDrafts.edges).toBe(without.edges);
    expect(withDrafts.visible).toEqual(without.visible);
    expect(withDrafts.focal).toEqual(without.focal);
  });

  const elsewhere: Array<[string, Partial<GraphTab>]> = [
    ["a directory's graph", { scopeId: "dir:notes", expanded: { "": true, notes: true } }],
    ["a file's graph", { scopeId: `file:${A}` }],
    ["a tag's lens", { scopeId: "tag:#t" }],
    ["the filesystem graph of the workspace", { scopeId: "workspace", mode: "filesystem", expanded: { "": true, notes: true, src: true } }],
    ["the language graph", { scopeId: "workspace", mode: "language" }],
  ];
  test.each(elsewhere)("%s draws no draft and reads the same with drafts listed", async (_name, over) => {
    await mountGraphPanel(GraphPanel, layout, graphTab(over));
    const without = { ids: visibleIds(), nodes: canvas.props?.nodes.length, edges: canvas.props?.edges.length };
    unmountGraphPanels();
    canvas.props = null;

    // The list is known to the window before the graph is shown.
    listed([row("untitled"), row("sketch")]);
    await refreshDrafts();
    await mountGraphPanel(GraphPanel, layout, graphTab(over));

    expect(draftNodes()).toEqual([]);
    expect(visibleIds()).toEqual(without.ids);
    expect(handed()?.nodes.length).toBe(without.nodes);
    expect(handed()?.edges.length).toBe(without.edges);
  });

  test("where the workspace's own node is not drawn, no draft is", async () => {
    // No file anchors the root, so the folder chip takes it with the rest.
    graphServer.view = { nodes: [g.dir(""), g.dir("empty")], edges: [g.edge("", "directory:empty", "contains")] };
    graphServer.fs = { nodes: [fsg.dir(""), fsg.dir("empty")], edges: [fsg.contains("", "empty")] };
    listed([row("untitled")]);
    const tab = workspaceTab({ expanded: { "": true } });
    tab.filters.folder = false;
    await mountGraphPanel(GraphPanel, layout, tab);

    expect(visibleIds(), "the root is hidden with the other directories").toEqual([]);
    expect(draftNodes()).toEqual([]);
  });
});
