// @vitest-environment jsdom
//
// The graph tab menu's filter chips: what each one counts and what turning it
// off hides. GraphPanel is mounted over a fixed graph; the chips are read from
// the tab menu the tab strip opens, and what they hide from the node and edge
// sets the panel hands the canvas.

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
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { fileBucket } from "../state/kinds";
import {
  DEFAULT_GRAPH_FILTERS,
  graphLinkFor,
  layout,
  openGraphInActivePane,
  parseGraphLink,
  type GraphTab,
} from "../state/tabs.svelte";

installGraphDom();

const README = "notes/readme.md";
const PLAN = "notes/plan.md";
const MAIN = "src/main.rs";
const PIC = "img/cat.png";
const ALICE = "Contacts/alice.md";
const NOTES = "directory:notes";
const SRC = "directory:src";
const IMG = "directory:img";
const CONTACTS = "directory:Contacts";
const EMPTY = "directory:empty";

/// Two markdown files, one source file, one image and one contact file in
/// their directories, an empty directory, two tags carried by several edges,
/// one mention node and one language.
function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("src"),
      g.dir("img"),
      g.dir("Contacts"),
      g.dir("empty"),
      g.file("notes/readme.md"),
      g.file("notes/plan.md"),
      g.file("src/main.rs"),
      g.file("img/cat.png"),
      g.file("Contacts/alice.md", { node_kind: "contact" }),
      g.tag("todo"),
      g.tag("idea"),
      g.mention("bob"),
      g.language("rust"),
    ],
    edges: [
      g.edge("", NOTES, "contains"),
      g.edge("", SRC, "contains"),
      g.edge("", IMG, "contains"),
      g.edge("", CONTACTS, "contains"),
      g.edge("", EMPTY, "contains"),
      g.edge(NOTES, README, "contains"),
      g.edge(NOTES, PLAN, "contains"),
      g.edge(SRC, MAIN, "contains"),
      g.edge(IMG, PIC, "contains"),
      g.edge(CONTACTS, ALICE, "contains"),
      // Five tag edges onto two tag nodes.
      g.edge(README, "#todo", "tag"),
      g.edge(PLAN, "#todo", "tag"),
      g.edge(MAIN, "#todo", "tag"),
      g.edge(README, "#idea", "tag"),
      g.edge(PLAN, "#idea", "tag"),
      g.edge(PLAN, "@@bob", "mention"),
      g.edge(README, PIC, "link"),
      g.edge(PLAN, ALICE, "link"),
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
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

/// The whole workspace, every directory expanded.
function workspaceTab(over: Partial<GraphTab> = {}): GraphTab {
  return graphTab({
    scopeId: "workspace",
    expanded: { "": true, notes: true, src: true, img: true, Contacts: true, empty: true },
    ...over,
  });
}

async function openChips(tab: GraphTab): Promise<Map<string, { count: number; button: HTMLButtonElement }>> {
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const rows = [...document.body.querySelectorAll<HTMLButtonElement>(".tab-menu-bubble .filter-row")];
  return new Map(
    rows.map((b) => [
      b.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
      { count: Number(b.querySelector(".filter-count")?.textContent), button: b },
    ]),
  );
}

function visibleEdgeKeys(): string[] {
  return (canvas.props?.visibleEdges ?? []).map((e) => `${e.source}>${e.target}`);
}

describe("the chips", () => {
  test("are the seven node kinds, with no link chip", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    const chips = await openChips(tab);
    expect([...chips.keys()]).toEqual(["tag", "contact", "language", "media", "folder", "markdown", "source"]);
  });

  test("count nodes, not edges", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    const chips = await openChips(tab);
    const count = (label: string) => chips.get(label)?.count;

    expect(count("tag"), "two tag nodes behind five tag edges").toBe(2);
    expect(count("contact"), "the mention node and the contact file").toBe(2);
    expect(count("language")).toBe(1);
    expect(count("media")).toBe(1);
    expect(count("folder"), "the root and five directories").toBe(6);
    expect(count("markdown")).toBe(2);
    expect(count("source")).toBe(1);
  });

  test("toggle from the menu and mark their state", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    const chips = await openChips(tab);
    const markdown = chips.get("markdown")!.button;
    expect(markdown.getAttribute("aria-checked")).toBe("true");

    markdown.click();
    await settle(2);
    expect(tab.filters.markdown).toBe(false);
    expect(markdown.getAttribute("aria-checked")).toBe("false");
  });
});

describe("turning a chip off", () => {
  test("markdown and source hide their files and the edges touching them", async () => {
    await mountGraphPanel(
      GraphPanel,
      layout,
      workspaceTab({ filters: { ...graphTab().filters, markdown: false, source: false } }),
    );
    const ids = visibleIds();
    for (const id of [README, PLAN, MAIN]) expect(ids).not.toContain(id);
    expect(ids).toContain(PIC);
    expect(visibleEdgeKeys().some((k) => k.includes(README) || k.includes(MAIN))).toBe(false);
  });

  test("media hides images and contact hides contact files and mention edges", async () => {
    await mountGraphPanel(
      GraphPanel,
      layout,
      workspaceTab({ filters: { ...graphTab().filters, img: false, mention: false } }),
    );
    const ids = visibleIds();
    expect(ids).not.toContain(PIC);
    expect(ids).not.toContain(ALICE);
    expect(ids).not.toContain("@@bob");
    expect(ids).toContain(README);
    expect(visibleEdgeKeys()).not.toContain(`${PLAN}>@@bob`);
  });

  test("link edges have no chip and stay drawn", async () => {
    await mountGraphPanel(
      GraphPanel,
      layout,
      workspaceTab({ filters: { ...graphTab().filters, tag: false, mention: false, language: false } }),
    );
    expect(visibleEdgeKeys()).toContain(`${README}>${PIC}`);
    expect(visibleEdgeKeys()).not.toContain(`${README}>#todo`);
  });

  test("folder hides only directories off the spine of a visible file", async () => {
    await mountGraphPanel(
      GraphPanel,
      layout,
      workspaceTab({ filters: { ...graphTab().filters, folder: false } }),
    );
    const ids = visibleIds();
    expect(ids, "an empty directory is clutter").not.toContain(EMPTY);
    for (const id of ["", NOTES, SRC, IMG, CONTACTS]) expect(ids, id).toContain(id);
    expect(visibleEdgeKeys(), "the containment spine still draws").toContain(`${NOTES}>${README}`);
  });
});

describe("file buckets", () => {
  test("each file chip hides exactly the files the shared fileBucket puts in it", async () => {
    const paths = [
      "note.md",
      "readme.txt",
      "lib.rs",
      "main.py",
      "data.csv",
      "Makefile",
      "board.excalidraw",
      "photo.png",
      "paper.pdf",
      "archive.zip",
    ];
    graphServer.view = { nodes: [g.dir(""), ...paths.map((p) => g.file(p))], edges: [] };
    const chips: Array<["markdown" | "source" | "img", string]> = [
      ["markdown", "doc"],
      ["source", "source"],
      ["img", "img"],
    ];
    for (const [chip, bucket] of chips) {
      await mountGraphPanel(
        GraphPanel,
        layout,
        workspaceTab({ filters: { ...graphTab().filters, [chip]: false } }),
      );
      const shown = new Set(visibleIds());
      const hidden = paths.filter((p) => !shown.has(p));
      expect(hidden, `${chip} off`).toEqual(paths.filter((p) => fileBucket(p) === bucket));
      unmountGraphPanels();
    }
  });
});

describe("the chip state a tab keeps", () => {
  test("starts with every chip on, markdown and source included", async () => {
    await mountGraphPanel(GraphPanel, layout, workspaceTab());
    const tab = openGraphInActivePane({ scopeId: "workspace" });
    expect(tab.filters).toEqual({
      link: true,
      tag: true,
      mention: true,
      language: true,
      img: true,
      folder: true,
      markdown: true,
      source: true,
    });
    expect(DEFAULT_GRAPH_FILTERS.markdown && DEFAULT_GRAPH_FILTERS.source).toBe(true);
  });

  test("round-trips markdown and source through a graph link", () => {
    const tab = graphTab({ filters: { ...graphTab().filters, markdown: false, source: false } });
    const parsed = parseGraphLink(graphLinkFor(tab));
    expect(parsed?.filters).toEqual(tab.filters);
  });

  test("reads a link from before the markdown and source chips with both on", () => {
    const link = graphLinkFor(graphTab()).replace(/([?&]f=)2[a-z]*/, "$1ltmaif");
    expect(link).toContain("f=ltmaif");
    const parsed = parseGraphLink(link);
    expect(parsed?.filters.markdown).toBe(true);
    expect(parsed?.filters.source).toBe(true);
    expect(parsed?.filters.tag).toBe(true);
  });
});

describe("the filesystem graph's chips", () => {
  function groupedFile(path: string) {
    return { ...fsg.file(path), link_group: "0123456789abcdef" };
  }

  function serveLinked(paths: string[], withEdge?: { source: string; target: string }): void {
    graphServer.fs = {
      nodes: [fsg.dir(""), ...paths.map(groupedFile)],
      edges: [
        ...paths.map((path) => fsg.contains("", path)),
        ...(withEdge ? [{ ...withEdge, kind: "hardlink" as const }] : []),
      ],
    };
  }

  function hardlinkEdges(): string[] {
    return (canvas.props?.visibleEdges ?? [])
      .filter((edge) => edge.kind === "mention")
      .map((edge) => [edge.source, edge.target].sort().join(">"));
  }

  test("joins a pair split across filesystem pages and filters the joined edge", async () => {
    serveLinked(["a.md", "b.md"]);
    graphServer.fsPageSize = 2;
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    expect(graphServer.fsGraphCalls.some((call) => call.cursor)).toBe(true);
    expect((await openChips(tab)).get("hardlink")?.count).toBe(2);
    expect(hardlinkEdges()).toEqual(["a.md>b.md"]);
    tab.filters.mention = false;
    await settle(2);
    expect(hardlinkEdges()).toEqual([]);
  });

  test("joins a file loaded by a later directory expansion", async () => {
    graphServer.fs = {
      nodes: [fsg.dir(""), groupedFile("a.md"), fsg.dir("notes"), groupedFile("notes/b.md")],
      edges: [fsg.contains("", "a.md"), fsg.contains("", "notes"), fsg.contains("notes", "notes/b.md")],
    };
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem", expanded: { "": true } }));
    expect((await openChips(tab)).get("hardlink")?.count).toBe(0);
    closeTabMenu();
    canvas.props!.onSelect("notes");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
    expect(graphServer.fsGraphCalls.some((call) => call.path === "notes")).toBe(true);
    expect((await openChips(tab)).get("hardlink")?.count).toBe(2);
    expect(hardlinkEdges()).toEqual(["a.md>notes/b.md"]);
  });

  test("joins every pair of three loaded paths", async () => {
    serveLinked(["a.md", "b.md", "c.md"]);
    graphServer.fsPageSize = 2;
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    expect((await openChips(tab)).get("hardlink")?.count).toBe(3);
    expect(hardlinkEdges().sort()).toEqual(["a.md>b.md", "a.md>c.md", "b.md>c.md"]);
  });

  test("does not count a group with only one loaded path", async () => {
    serveLinked(["a.md"]);
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    expect((await openChips(tab)).get("hardlink")?.count).toBe(0);
    expect(hardlinkEdges()).toEqual([]);
  });

  test.each([
    ["a.md", "b.md"],
    ["b.md", "a.md"],
  ])("deduplicates a delivered edge ordered %s to %s", async (source, target) => {
    serveLinked(["a.md", "b.md"], { source, target });
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    expect((await openChips(tab)).get("hardlink")?.count).toBe(2);
    expect(hardlinkEdges()).toEqual(["a.md>b.md"]);
  });

  test("count loaded symlinks and the files joined by hardlinks", async () => {
    graphServer.fs = {
      nodes: [
        { id: "", kind: "directory", name: "", path: "", size: 0 },
        { id: "a.md", kind: "file", name: "a.md", path: "a.md", size: 1 },
        { id: "b.md", kind: "file", name: "b.md", path: "b.md", size: 1 },
        { id: "link.md", kind: "symlink", name: "link.md", path: "link.md", size: 1 },
      ],
      edges: [
        { source: "", target: "a.md", kind: "contains" },
        { source: "", target: "b.md", kind: "contains" },
        { source: "", target: "link.md", kind: "contains" },
        { source: "link.md", target: "a.md", kind: "symlink" },
        { source: "a.md", target: "b.md", kind: "hardlink" },
      ],
    };
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    const chips = await openChips(tab);
    expect(chips.get("symlink")?.count).toBe(1);
    expect(chips.get("hardlink")?.count).toBe(2);
  });

  test("are named for what each one filters", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab({ mode: "filesystem" }));
    openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);
    const labels = [...document.body.querySelectorAll(".tab-menu-bubble .filter-row .mbtn-label")].map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(["symlink", "hardlink", "directory", "markdown", "source"]);
  });
});

describe("the semantic graph's filesystem spine", () => {
  function servePair(grouped: boolean, edge?: { source: string; target: string }): void {
    graphServer.view = { nodes: [], edges: [] };
    const group = grouped ? { link_group: "0123456789abcdef" } : {};
    graphServer.fs = {
      nodes: [fsg.dir(""), { ...fsg.file("a.md"), ...group }, { ...fsg.file("b.md"), ...group }],
      edges: [
        fsg.contains("", "a.md"),
        fsg.contains("", "b.md"),
        ...(edge ? [{ ...edge, kind: "hardlink" as const }] : []),
      ],
    };
    graphServer.fsPageSize = 2;
  }

  function mentionPairs(): string[] {
    return (canvas.props?.visibleEdges ?? [])
      .filter((edge) => edge.kind === "mention")
      .map((edge) => [edge.source, edge.target].sort().join(">"));
  }

  test("draws a pair split across spine pages under the contact chip", async () => {
    servePair(true);
    const { tab } = await mountGraphPanel(GraphPanel, layout, workspaceTab());
    expect(graphServer.fsGraphCalls.some((call) => call.cursor)).toBe(true);
    expect(mentionPairs()).toEqual(["a.md>b.md"]);
    tab.filters.mention = false;
    await settle(2);
    expect(mentionPairs()).toEqual([]);
  });

  test.each([
    ["a.md", "b.md"],
    ["b.md", "a.md"],
  ])("draws one pair when the server delivers %s to %s and a group", async (source, target) => {
    servePair(true, { source, target });
    await mountGraphPanel(GraphPanel, layout, workspaceTab());
    expect(mentionPairs()).toEqual(["a.md>b.md"]);
  });

  test("keeps the delivered edge when the nodes have no group", async () => {
    servePair(false, { source: "b.md", target: "a.md" });
    await mountGraphPanel(GraphPanel, layout, workspaceTab());
    expect(mentionPairs()).toEqual(["a.md>b.md"]);
  });

  test("does not invent an edge for nodes without a group", async () => {
    servePair(false);
    await mountGraphPanel(GraphPanel, layout, workspaceTab());
    expect(mentionPairs()).toEqual([]);
  });
});
