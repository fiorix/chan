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
  paneWidths,
  refreshTree,
  refreshWorkspace,
} from "../state/store.svelte";
import { setFetchImpl } from "../api/transport";
import { applyGraphColorPrefs } from "../state/graphPalette.svelte";
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
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};

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
      g.language("rust"),
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
      { path: "notes/bundle.zip", kind: "binary", size: 2, mtime: 100, content: "PK" },
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

describe("a file the editor cannot open", () => {
  test("offers no Open: its inspector leads with Download", async () => {
    graphServer.view.nodes.push(g.file("notes/bundle.zip"));
    graphServer.view.edges.push(g.edge(NOTES, "notes/bundle.zip", "contains"));
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("notes/bundle.zip");

    const main = await inspectorButton(target, "Download file");
    expect(main.classList.contains("pill-main")).toBe(true);
    await expect(inspectorButton(target, "Open")).rejects.toThrow("no inspector action Open");
    expect(paneTabs().some((t) => t.kind === "file"), "no editor tab").toBe(false);
  });
});

describe("the scope breadcrumb", () => {
  test("lists the scope's ancestors, and a crumb re-scopes this tab in place", async () => {
    const { tab, target } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "file:notes/deep/d.md", depth: 2, inspectorOpen: true }),
    );
    const crumbs = [...target.querySelectorAll<HTMLElement>(".scope-crumbs .crumb")];
    expect(crumbs.map((c) => [c.textContent?.trim(), c.classList.contains("current")])).toEqual([
      ["workspace", false],
      ["notes", false],
      ["deep", false],
      ["d.md", true],
    ]);

    crumbs[1]!.click();
    await settle();
    expect(tab.scopeId).toBe("dir:notes");
    expect(tab.depth).toBe(1);
    expect(newGraphTabs(tab.id), "no new tab").toEqual([]);
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

describe("the workspace root", () => {
  test("shows the workspace inspector; Open reveals the workspace, Graph from here re-roots there", async () => {
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "dir:notes" }));
    await select("");
    expect(target.querySelector(".inspector .kind-chip.workspace")).not.toBeNull();

    (await inspectorButton(target, "Graph from here")).click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "workspace", pendingSelectId: "" });

    (await inspectorButton(target, "Open")).click();
    await settle();
    const files = paneTabs().find((t): t is BrowserTab => t.kind === "browser");
    expect(files?.showWorkspace).toBe(true);
    expect(browserSelection.path).toBeNull();
  });
});

describe("a folder node's inspector", () => {
  test("is the File Browser's directory inspector, titled with the graph's label", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select(NOTES);

    const inspector = target.querySelector<HTMLElement>(".inspector")!;
    expect(inspector.querySelector("h3.title")?.textContent?.trim()).toBe("notes/");
    expect(inspector.querySelector(".pill-main")?.textContent?.trim()).toBe("Open");
    expect(inspector.querySelector(".meta-grid")?.textContent).toContain("subdirectories");
  });

  test("asks the report cache for a directory by its path", async () => {
    const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
    const urls: string[] = [];
    setFetchImpl(async (input) => {
      urls.push(String(input));
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    });
    await actual.api.reportDir("notes/a b");
    expect(urls.some((u) => u.includes("/api/report/dir?path=notes%2Fa%20b"))).toBe(true);
  });
});

describe("a language node", () => {
  test("shows the language inspector, and its Graph from here opens the language's lens", async () => {
    graphServer.languageDetail = {
      language: "rust",
      files: 1,
      code: 12,
      cocomo: {
        model: "organic",
        effort_person_months: 0.1,
        schedule_months: 0.2,
        developers: 0.1,
        estimated_cost_usd: 1,
      },
      directories: [{ path: "src/core", label: "core", rank: 1, files: 1, code: 12 }],
    };
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("language:rust");

    const inspector = target.querySelector<HTMLElement>(".inspector")!;
    expect(inspector.querySelector(".kind-chip.language")?.textContent).toBe("language");
    expect(inspector.querySelector("h3.title")?.textContent).toBe("rust");
    [...inspector.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === "Graph from here")!
      .click();
    await settle();
    expect(newGraphTabs(tab.id).map((t) => t.scopeId)).toEqual(["language:rust"]);
  });

  test("a directory row of its detail opens that directory's graph", async () => {
    graphServer.languageDetail = {
      language: "rust",
      files: 1,
      code: 12,
      cocomo: {
        model: "organic",
        effort_person_months: 0.1,
        schedule_months: 0.2,
        developers: 0.1,
        estimated_cost_usd: 1,
      },
      directories: [{ path: "src/core", label: "core", rank: 1, files: 1, code: 12 }],
    };
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
    await select("language:rust");
    await settle();

    target.querySelector<HTMLButtonElement>(".inspector .dir-row .dir-name")!.click();
    await settle();
    expect(newGraphTabs(tab.id)[0]).toMatchObject({ scopeId: "dir:src/core", pendingSelectId: "src/core" });
  });
});

describe("the inspector's width", () => {
  function drag(handle: Element, dx: number): void {
    const at = (type: string, clientX: number) =>
      handle.dispatchEvent(
        Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }),
      );
    at("pointerdown", 500);
    at("pointermove", 500 + dx);
    at("pointerup", 500 + dx);
  }

  test("is the tab's own when it has one, the shared one otherwise, and a drag writes only the tab's", async () => {
    const own = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", inspectorOpen: true, inspectorWidth: 321 }),
    );
    expect(own.target.querySelector<HTMLElement>("aside.inspector")!.style.width).toBe("321px");
    unmountGraphPanels();

    const shared = paneWidths.graph;
    const { tab, target } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", inspectorOpen: true }),
    );
    const aside = target.querySelector<HTMLElement>("aside.inspector")!;
    expect(aside.style.width).toBe(`${shared}px`);
    drag(aside.previousElementSibling!, -40);
    await settle(2);
    expect(tab.inspectorWidth).toBe(shared + 40);
    expect(paneWidths.graph, "the shared width is left alone").toBe(shared);
  });
});

describe("a custom graph palette", () => {
  test("is applied on the graph surface and its menu, not on the page", async () => {
    applyGraphColorPrefs({ mode: "custom", dark: { doc: "#ff0000" }, light: { doc: "#ff0000" } });
    try {
      const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
      expect(target.querySelector<HTMLElement>(".graph-tab")!.style.getPropertyValue("--g-doc")).toBe("#ff0000");
      openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
      await settle(2);
      expect(
        document.body.querySelector<HTMLElement>(".tab-menu-bubble")!.style.getPropertyValue("--g-doc"),
      ).toBe("#ff0000");
      expect(document.documentElement.getAttribute("style") ?? "").not.toContain("--g-doc");
      expect(document.body.getAttribute("style") ?? "").not.toContain("--g-doc");
    } finally {
      applyGraphColorPrefs(undefined);
    }
  });
});
