// @vitest-environment jsdom
//
// The graph tab's inspector and the scope row of its menu: what selecting a
// node shows, and where its Open, Graph from here and chip actions lead.
// GraphPanel is mounted over a fixed graph while the rest of the api runs on
// the in-memory demo workspace, so the inspector finds real tree entries and
// the actions open real tabs.

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
} from "../__tests__/graphPanel";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  browserSelection,
  loadTreeDir,
  refreshTree,
  refreshWorkspace,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import {
  layout,
  type BrowserTab,
  type FileTab,
  type GraphTab,
  type LeafNode,
} from "../state/tabs.svelte";

installGraphDom();
Element.prototype.scrollIntoView = () => {};

const A = "notes/a.md";
const D = "notes/deep/d.md";
const README = "README.md";
const NOTES = "directory:notes";

function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("notes/deep"),
      g.dir("Contacts"),
      g.file("README.md"),
      g.file("notes/a.md"),
      g.file("notes/deep/d.md"),
      g.file("Contacts/alice.md", { node_kind: "contact" }),
      g.tag("t"),
      g.mention("alice"),
      g.mention("bob"),
    ],
    edges: [
      g.edge("", NOTES, "contains"),
      g.edge("", "README.md", "contains"),
      g.edge(NOTES, "directory:notes/deep", "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge("directory:notes/deep", D, "contains"),
      g.edge(A, "#t", "tag"),
      g.edge(A, "@@alice", "mention"),
      g.edge(A, "@@bob", "mention"),
    ],
  };
  graphServer.fs = {
    nodes: [
      fsg.dir(""),
      fsg.dir("notes"),
      fsg.dir("notes/deep"),
      fsg.file("README.md"),
      fsg.file("notes/a.md"),
      fsg.file("notes/deep/d.md"),
    ],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("", "README.md"),
      fsg.contains("notes", "notes/deep"),
      fsg.contains("notes", "notes/a.md"),
      fsg.contains("notes/deep", "notes/deep/d.md"),
    ],
  };
}

let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  resetGraphServer();
  serveGraph();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 4, textCount: 4 },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "# a" },
      { path: "notes/deep/d.md", kind: "document", size: 5, mtime: 100, content: "# d" },
      { path: "Contacts/alice.md", kind: "contact", size: 5, mtime: 100, content: "# Alice" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  await loadTreeDir("Contacts");
  browserSelection.path = null;
});

afterEach(async () => {
  closeTabMenu();
  unmountGraphPanels();
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

function paneTabs(): LeafNode["tabs"] {
  return (layout.nodes[GRAPH_PANE] as LeafNode).tabs;
}

function newGraphTabs(except: string): GraphTab[] {
  return paneTabs().filter((t): t is GraphTab => t.kind === "graph" && t.id !== except);
}

async function select(id: string): Promise<void> {
  canvas.props!.onSelect(id);
  await settle();
}

async function inspectorButton(target: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const inspector = target.querySelector<HTMLElement>(".inspector");
  if (!inspector) throw new Error("the inspector is not open");
  const pill = inspector.querySelector<HTMLButtonElement>(".pill-main");
  if (pill?.textContent?.trim() === label) return pill;
  const caret = inspector.querySelector<HTMLButtonElement>(".pill-caret");
  if (caret && !inspector.querySelector(".action-menu")) {
    caret.click();
    await settle(1);
  }
  const item = [...inspector.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no inspector action ${label}`);
  return item;
}

describe("a file node", () => {
  test("opens in the editor from its inspector", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select(A);

    (await inspectorButton(target, "Open")).click();
    await settle();
    const opened = paneTabs().find((t): t is FileTab => t.kind === "file");
    expect(opened?.path).toBe("notes/a.md");
  });

  test("in the filesystem graph, opens in the editor too", async () => {
    const { target } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", mode: "filesystem", expanded: { "": true, notes: true } }),
    );
    await select("notes/a.md");

    (await inspectorButton(target, "Open")).click();
    await settle();
    expect(paneTabs().find((t): t is FileTab => t.kind === "file")?.path).toBe("notes/a.md");
  });

  test("Graph from here opens a new semantic tab on its directory, preselected", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select(A);

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    const [spawned] = newGraphTabs(tab.id);
    expect(spawned).toMatchObject({
      mode: "semantic",
      scopeId: "dir:notes",
      depth: 1,
      pendingSelectId: "notes/a.md",
    });
    expect(tab.scopeId, "the tab it came from keeps its scope").toBe("workspace");
  });

  test("Graph from here on a root-level file opens the workspace", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select(README);

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "workspace" });
  });
});

describe("a directory node", () => {
  test("Open shows it in a new File Browser tab, entered and expanded", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("directory:notes/deep");

    (await inspectorButton(target, "Open")).click();
    await settle();
    const files = paneTabs().find((t): t is BrowserTab => t.kind === "browser");
    expect(files).toBeDefined();
    expect(files!.inspectorOpen).toBe(true);
    expect(files!.expanded, "the directory itself and its ancestors").toEqual(["notes", "notes/deep"]);
    expect(browserSelection.path).toBe("notes/deep");
  });

  test("Graph from here re-roots a new tab at the directory itself", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select(NOTES);

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({
      mode: "semantic",
      scopeId: "dir:notes",
      depth: 1,
      pendingSelectId: "notes",
    });
  });

  test("in the filesystem graph, Open and Graph from here treat it as a directory too", async () => {
    const { tab, target } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", mode: "filesystem", expanded: { "": true, notes: true } }),
    );
    await select("notes");

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "dir:notes" });

    (await inspectorButton(target, "Open")).click();
    await settle();
    const files = paneTabs().find((t): t is BrowserTab => t.kind === "browser");
    expect(files?.expanded).toEqual(["notes"]);
  });

  test("a filesystem directory scope's slider reaches past the loaded depth", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "dir:notes", mode: "filesystem", depth: 1 }),
    );
    openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);
    const slider = document.body.querySelector<HTMLInputElement>(".depth-row input[type='range']")!;
    expect(slider.max, "d.md sits two levels below notes").toBe("2");

    tab.depth = 2;
    await settle();
    expect(tab.depth, "the dragged depth holds").toBe(2);
  });
});

describe("a mention node", () => {
  test("Graph from here opens the contact's lens when the mention names a contact file", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("@@alice");

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "contact:Contacts/alice.md" });
  });

  test("Graph from here opens the mention's own lens otherwise", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("@@bob");

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "mention:@@bob" });
  });

  test("its kind chip opens a mention lens and a tag's opens a tag lens", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("@@bob");
    target.querySelector<HTMLButtonElement>(".inspector .head button.kind-chip")!.click();
    await settle();
    await select("#t");
    target.querySelector<HTMLButtonElement>(".inspector .head button.kind-chip")!.click();
    await settle();

    expect(newGraphTabs(tab.id).map((t) => t.scopeId)).toEqual(["mention:@@bob", "tag:#t"]);
  });
});

describe("the menu's scope row", () => {
  async function scopeRow(tab: GraphTab): Promise<HTMLButtonElement> {
    openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);
    const row = document.body.querySelector<HTMLButtonElement>(".tab-menu-bubble .graph-scope-row");
    if (!row) throw new Error("no scope row");
    return row;
  }

  const cases: Array<[string, string, string, string]> = [
    ["workspace", "Workspace", "lucide-hard-drive", ""],
    ["dir:notes", "notes", "lucide-folder", NOTES],
    ["file:notes/a.md", "notes/a.md", "lucide-file-text", A],
    ["tag:#t", "#t", "lucide-hash", "#t"],
  ];
  for (const [scopeId, text, icon, node] of cases) {
    test(`on ${scopeId} names the scope and selects its node into the inspector`, async () => {
      const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId }));
      const row = await scopeRow(tab);

      expect(row.textContent?.trim()).toBe(text);
      expect(row.querySelector(`svg.${icon}`), icon).not.toBeNull();
      expect(row.nextElementSibling?.getAttribute("role")).toBe("separator");
      expect(row.nextElementSibling?.nextElementSibling?.classList.contains("depth-row")).toBe(true);

      row.click();
      await settle();
      expect(canvas.props!.selectedId).toBe(node);
      expect(tab.inspectorOpen).toBe(true);
      expect(target.querySelector(".inspector")).not.toBeNull();
      expect(document.body.querySelector(".tab-menu-bubble"), "the menu closes").toBeNull();
    });
  }
});
