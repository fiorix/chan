// @vitest-environment jsdom
//
// The graph tab menu's words and wiring. The menu types no action's words
// itself: each row is held to the title of the catalog command it runs, to an
// option of the Filters command, to the shortcut table's label for the
// launcher, or to a named exemption. Its filter rows and the options the
// launcher's Filters command lists are one list, in every graph mode, and a
// row and its option flip the same filter.

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
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
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
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.file("notes/a.md")],
    edges: [g.edge("", "directory:notes", "contains"), g.edge("directory:notes", "notes/a.md", "contains")],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("notes"), fsg.file("notes/a.md")],
    edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/a.md")],
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
    const { bubble } = await openMenu({ scopeId: "file:notes/a.md" });

    expect(lines(bubble)).toEqual([
      ...[
        {
          own: "notes/a.md",
          because: "names the scope the graph shows; its tooltip names the command it runs, Scope details",
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

  test("the scope row's tooltip names the command it runs and the scope", async () => {
    const { bubble } = await openMenu({ scopeId: "file:notes/a.md" });

    expect(bubble.querySelector<HTMLElement>(".graph-scope-row")!.title).toBe(
      `${command("app.graph.scopeDetails").title}: notes/a.md`,
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
  const MODES: { name: string; tab: Partial<GraphTab>; words: string[] }[] = [
    {
      name: "a semantic graph of the workspace",
      tab: { scopeId: "workspace" },
      words: ["tag", "contact", "language", "media", "folder", "markdown", "source"],
    },
    {
      name: "a semantic graph of a file, which has no folder filter",
      tab: { scopeId: "file:notes/a.md" },
      words: ["tag", "contact", "language", "media", "markdown", "source"],
    },
    {
      name: "a filesystem graph, in the filesystem's words",
      tab: { mode: "filesystem", scopeId: "dir:notes" },
      words: ["symlink", "hardlink", "directory", "markdown", "source"],
    },
    {
      name: "a language graph, which filters languages alone",
      tab: { mode: "language", scopeId: "workspace" },
      words: ["language"],
    },
  ];

  test.each(MODES)("are one list for $name", async ({ tab, words }) => {
    const { bubble } = await openMenu({
      ...tab,
      filters: { ...graphTab().filters, markdown: false },
    });

    const rows = filterRows(bubble);
    expect(rows.map((filter) => filter.label)).toEqual(words);
    expect(rows).toEqual(filterOptions().map(({ label, checked }) => ({ label, checked })));
  });

  test("a row and its option flip the same filter, and each shows the other's change", async () => {
    const { tab, bubble } = await openMenu({ mode: "filesystem", scopeId: "dir:notes" });
    const option = (): CommandOption => filterOptions().find((candidate) => candidate.label === "directory")!;
    expect(option().checked).toBe(true);

    row(bubble, "directory").click();
    await settle(2);
    expect(tab.filters.folder).toBe(false);
    expect(option().checked).toBe(false);
    expect(command("app.graph.filters").state!(commandContext())).toBe("4 of 5");

    await option().run();
    await settle(2);
    expect(tab.filters.folder).toBe(true);
    expect(row(bubble, "directory").getAttribute("aria-checked")).toBe("true");
  });
});

describe("the scope row and Scope details", () => {
  test("the row shows the scope's details and closes the menu", async () => {
    const { tab, bubble } = await openMenu({ scopeId: "file:notes/a.md" });
    expect(tab.inspectorOpen).toBe(false);

    bubble.querySelector<HTMLButtonElement>(".graph-scope-row")!.click();
    await settle(2);

    expect(tab.inspectorOpen).toBe(true);
    expect(canvas.props?.selectedId).toBe("notes/a.md");
    expect(tabMenu.openForTabId).toBeNull();
  });

  test("the command shows the same details", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "file:notes/a.md" }));
    expect(tab.inspectorOpen).toBe(false);

    command("app.graph.scopeDetails").run();
    await settle(2);

    expect(tab.inspectorOpen).toBe(true);
    expect(canvas.props?.selectedId).toBe("notes/a.md");
  });

  test("only the graph the launcher is aimed at answers", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "file:notes/a.md" }));
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
