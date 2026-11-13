// @vitest-environment jsdom
//
// The graph tab menu's words and wiring. The menu types no action's words
// itself: each row is held to the title of the catalog command it runs, to an
// option of the Filters command, to the shortcut table's label for the
// launcher, or to a named exemption. Its filter rows and the options the
// launcher's Filters command lists are one list, and a row and its option
// flip the same filter. The header row and the launcher's Select workspace
// select the workspace's node through one function. The launcher's depth
// steps report the depth the menu's slider shows.

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
  GRAPH_PANE,
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
import { invalidateGraph } from "../state/graphData.svelte";
import {
  commandById,
  commandContext,
  type Command,
  type CommandOption,
} from "../state/commands";
import { chordFor, SHORTCUTS } from "../state/shortcuts";
import { closeTabMenu, openTabMenu, tabMenu } from "../state/tabMenu.svelte";
import { layout, paneSide, type GraphTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.dir("notes/deep"), g.file("notes/a.md"), g.file("notes/deep/d.md")],
    edges: [
      g.edge("", "directory:notes", "contains"),
      g.edge("directory:notes", "directory:notes/deep", "contains"),
      g.edge("directory:notes", "notes/a.md", "contains"),
      g.edge("directory:notes/deep", "notes/deep/d.md", "contains"),
    ],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("notes/deep"), fsg.file("notes/a.md"), fsg.file("notes/deep/d.md")],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("notes", "notes/deep"),
      fsg.contains("notes", "notes/a.md"),
      fsg.contains("notes/deep", "notes/deep/d.md"),
    ],
  };
});

afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

function command(id: string): Command {
  const found = commandById(id);
  if (!found) throw new Error(`no catalog command ${id}`);
  return found;
}

function filterOptions(): readonly CommandOption[] {
  return command("app.graph.filters").options!(commandContext());
}

async function openMenu(over: Partial<GraphTab> = {}): Promise<{ tab: GraphTab; bubble: HTMLElement }> {
  const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab(over));
  return { tab, bubble: await reopen(tab) };
}

async function reopen(tab: GraphTab): Promise<HTMLElement> {
  closeTabMenu();
  await settle(2);
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const bubble = document.body.querySelector<HTMLElement>(".tab-menu-bubble");
  if (!bubble) throw new Error("graph tab menu did not open");
  return bubble;
}

/// The menu read top to bottom: "---" for a separator, a row's label
/// otherwise.
function lines(bubble: HTMLElement): string[] {
  return [...bubble.children].map((child) =>
    child.classList.contains("msep") ? "---" : (child.querySelector(".mbtn-label")?.textContent ?? "").trim(),
  );
}

function row(bubble: HTMLElement, label: string): HTMLButtonElement {
  const found = [...bubble.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
    (button) => button.querySelector(".mbtn-label")?.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no menu row ${label}`);
  return found;
}

function filterRows(bubble: HTMLElement): { label: string; checked: boolean }[] {
  return [...bubble.querySelectorAll<HTMLButtonElement>(".filter-row")].map((button) => ({
    label: button.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
    checked: button.getAttribute("aria-checked") === "true",
  }));
}

/// Where a menu row takes its words: the title of a catalog command, the
/// shortcut table's label for a chord the catalog does not list, or words of
/// its own with the reason it has them.
type Words = { command: string } | { shortcut: string } | { own: string; because: string };

function wordsOf(source: Words | "---"): string {
  if (source === "---") return source;
  if ("command" in source) return command(source.command).title;
  if ("shortcut" in source) {
    const shortcut = SHORTCUTS.find((candidate) => candidate.id === source.shortcut);
    if (!shortcut) throw new Error(`no shortcut ${source.shortcut}`);
    return shortcut.label;
  }
  return source.own;
}

describe("the menu's words", () => {
  test("every row is a command's title, a Filters option, the launcher's shortcut label or a named exemption", async () => {
    const { bubble } = await openMenu();

    expect(lines(bubble)).toEqual([
      ...[
        {
          own: "Workspace",
          because: "names what the graph is of; its tooltip is the title of the command it runs, Select workspace",
        },
        "---" as const,
        { own: "Depth", because: "a slider's caption, not an action" },
        "---" as const,
      ].map(wordsOf),
      ...filterOptions().map((option) => option.label),
      ...[
        "---" as const,
        { command: "app.pane.flip" },
        { command: "app.tab.close" },
        "---" as const,
        { shortcut: "app.launcher.toggle" },
      ].map(wordsOf),
    ]);
    expect(filterOptions().length).toBeGreaterThan(0);
  });

  test("the header row's tooltip is the title of the command it runs", async () => {
    const { bubble } = await openMenu();

    expect(command("app.graph.scopeDetails").title).toBe("Select workspace");
    expect(bubble.querySelector<HTMLElement>(".graph-scope-row")!.title).toBe(
      command("app.graph.scopeDetails").title,
    );
  });

  test("Close tab and Flip pane carry the chords of their commands", async () => {
    const { bubble } = await openMenu();
    const chord = (id: string): string =>
      row(bubble, command(id).title).querySelector(".mbtn-chord")?.textContent ?? "";

    expect(chord("app.tab.close")).toBe(chordFor("app.tab.close") ?? "");
    expect(chord("app.pane.flip")).toBe(chordFor("app.pane.flip") ?? "");
  });
});

describe("the filter rows and the Filters command's options", () => {
  test("are one list, every graph tab offering all seven", async () => {
    const { bubble } = await openMenu({ filters: { ...graphTab().filters, markdown: false } });

    const rows = filterRows(bubble);
    expect(rows.map((filter) => filter.label)).toEqual([
      "tag", "contact", "language", "media", "folder", "markdown", "source",
    ]);
    expect(rows).toEqual(filterOptions().map(({ label, checked }) => ({ label, checked })));
    expect(rows.filter((filter) => !filter.checked).map((filter) => filter.label)).toEqual(["markdown"]);
  });

  test("a row and its option flip the same filter, and each shows the other's change", async () => {
    const { tab, bubble } = await openMenu();
    const option = (): CommandOption => filterOptions().find((candidate) => candidate.label === "folder")!;
    expect(option().checked).toBe(true);

    row(bubble, "folder").click();
    await settle(2);
    expect(tab.filters.folder).toBe(false);
    expect(option().checked).toBe(false);
    expect(command("app.graph.filters").state!(commandContext())).toBe("6 of 7");

    await option().run();
    await settle(2);
    expect(tab.filters.folder).toBe(true);
    expect(row(bubble, "folder").getAttribute("aria-checked")).toBe("true");
  });
});

describe("the header row and Select workspace", () => {
  test("the row selects the workspace's node, shows its details and closes the menu", async () => {
    const { tab, bubble } = await openMenu();
    expect(tab.inspectorOpen).toBe(false);
    expect(canvas.props?.selectedId).toBeNull();

    bubble.querySelector<HTMLButtonElement>(".graph-scope-row")!.click();
    await settle(2);

    expect(tab.inspectorOpen).toBe(true);
    expect(canvas.props?.selectedId).toBe("");
    expect(tabMenu.openForTabId).toBeNull();
  });

  test("the command makes the same selection", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    expect(tab.inspectorOpen).toBe(false);

    command("app.graph.scopeDetails").run();
    await settle(2);

    expect(tab.inspectorOpen).toBe(true);
    expect(canvas.props?.selectedId).toBe("");
  });

  test("the command takes the place of a selection, with its hops and what it revealed", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    canvas.props!.onSelect("notes/a.md");
    await settle(2);
    expect(tab.selectedNodeId).toBe("notes/a.md");
    expect(visibleIds(), "the selected file is revealed in its closed directory").toContain("notes/a.md");

    command("app.graph.scopeDetails").run();
    await settle(2);

    expect(canvas.props?.selectedId).toBe("");
    expect(tab.selectedNodeId, "the tab records the workspace's node").toBe("");
    expect(visibleIds()).not.toContain("notes/a.md");
  });

  test("a selection still waiting on the graph does not take it back when it lands", async () => {
    let release = (): void => {};
    graphServer.streamGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    graphServer.view.nodes.push(g.tag("t"));
    graphServer.view.edges.push(g.edge("notes/a.md", "#t", "tag"));
    // A tag is known only to the index, whose answer is held back.
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "#t" }));
    expect(canvas.props?.selectedId).toBeNull();
    expect(tab.pendingSelectId).toBe("#t");

    command("app.graph.scopeDetails").run();
    await settle(2);
    expect(canvas.props?.selectedId).toBe("");

    release();
    await settle();
    expect(canvas.props?.nodes.some((node) => node.id === "#t"), "the tag has arrived").toBe(true);
    expect(canvas.props?.selectedId).toBe("");
    expect(tab.pendingSelectId).toBeNull();
  });

  test("only the graph the launcher is aimed at answers", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    // Another tab takes the pane: the graph stays mounted, as a pane keeps
    // it, and the launcher is no longer aimed at it.
    const pane = layout.nodes[GRAPH_PANE] as LeafNode;
    pane.tabs.push(graphTab({ id: "graph-2" }));
    pane.activeTabId = "graph-2";

    command("app.graph.scopeDetails").run();
    await settle(2);

    expect(tab.inspectorOpen).toBe(false);
  });
});

describe("the depth steps", () => {
  const shown = (id: string) => command(id).state!(commandContext());

  async function sliderValue(tab: GraphTab): Promise<string> {
    return (await reopen(tab)).querySelector<HTMLInputElement>(".depth-row input[type='range']")!.value;
  }

  test("report the depth the slider shows, which a step moves", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    expect(await sliderValue(tab), "nothing selected reads as the root, one level opened").toBe("1");
    expect(shown("app.graph.depth.increase")).toBe("1");
    expect(shown("app.graph.depth.decrease")).toBe("1");

    command("app.graph.depth.increase").run();
    await settle(2);
    expect(tab.expanded.notes, "the step opened a level of the tree").toBe(true);
    expect(tab.depth, "the tab's own depth is a selected file's hops, which did not move").toBe(1);
    expect(await sliderValue(tab)).toBe("2");
    expect(shown("app.graph.depth.increase")).toBe("2");

    command("app.graph.depth.decrease").run();
    await settle(2);
    expect(await sliderValue(tab)).toBe("1");
    expect(shown("app.graph.depth.decrease")).toBe("1");
  });

  test("follow the selection: a closed directory reads 0", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());

    canvas.props!.onSelect("directory:notes");
    await settle(2);

    expect(await sliderValue(tab)).toBe("0");
    expect(shown("app.graph.depth.increase")).toBe("0");
  });

  test("report nothing for a graph no panel has shown", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const pane = layout.nodes[GRAPH_PANE] as LeafNode;
    pane.tabs.push(graphTab({ id: "graph-2" }));
    pane.activeTabId = "graph-2";

    expect(shown("app.graph.depth.increase")).toBeNull();
  });
});

describe("the menu's tail", () => {
  test("Flip pane flips the pane that holds the graph, whichever pane has the focus", async () => {
    const { bubble } = await openMenu();
    const other: LeafNode = { kind: "leaf", id: "other-pane", tabs: [], activeTabId: null };
    layout.nodes["other-pane"] = other;
    layout.activePaneId = "other-pane";
    const before = paneSide(layout.nodes[GRAPH_PANE] as LeafNode);

    row(bubble, command("app.pane.flip").title).click();
    await settle(2);

    expect(paneSide(layout.nodes[GRAPH_PANE] as LeafNode)).not.toBe(before);
    expect(paneSide(layout.nodes["other-pane"] as LeafNode)).toBe(paneSide(other));
    expect(tabMenu.openForTabId).toBeNull();
  });

  test("the launcher row closes the menu and asks for the launcher, holding no row of the menu", async () => {
    const { bubble } = await openMenu();
    const launcher = row(bubble, wordsOf({ shortcut: "app.launcher.toggle" }));
    expect(launcher.querySelector(".mbtn-chord")?.textContent ?? "").toBe(chordFor("app.launcher.toggle") ?? "");
    const heldAtOpen: (Element | null)[] = [];
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent).detail?.name === "app.launcher.toggle") heldAtOpen.push(document.activeElement);
    };
    window.addEventListener("chan:command", onCommand);
    try {
      launcher.focus();
      launcher.click();
      await settle(2);
    } finally {
      window.removeEventListener("chan:command", onCommand);
    }

    expect(heldAtOpen).toEqual([document.body]);
    expect(tabMenu.openForTabId).toBeNull();
  });
});
