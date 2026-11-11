// @vitest-environment jsdom
//
// The pane tree overlay: it lists every pane, side and tab of the window,
// the filter narrows the tabs, the arrow keys walk the rows, Enter or a click
// shows the picked tab in its pane and side, and Escape, the chord or a press
// outside closes it. While open it owns the keyboard, so no app chord acts
// behind it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import PaneTreeOverlay from "./PaneTreeOverlay.svelte";
import { fileTab, terminalTab } from "../__tests__/tabs";
import { closePaneTree, openPaneTree, paneTree, PANE_TREE_ANCHOR_ATTR } from "../state/paneTree.svelte";
import type { ProgramStatusRecord } from "../state/programStatus";
import {
  applyTerminalRoster,
  layout,
  paneMode,
  tabFocusPulse,
  type LeafNode,
  type Node,
  type Tab,
  type TerminalTab,
} from "../state/tabs.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { loadWindowTitle, windowName, __resetWindowTitle } from "../state/windowTitle.svelte";
import { privacy } from "@chan/web-shared/privacy";
import { loadScopedLibrarySnapshot, type ScopedLibrarySnapshot } from "../api/libraryCommand";
import { sessionWindowId } from "../api/client";
import { onWatchEvent } from "../state/store.svelte";

vi.mock("../api/libraryCommand", () => ({ loadScopedLibrarySnapshot: vi.fn() }));

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

const mounted: Array<Record<string, unknown>> = [];

function record(partial: Partial<ProgramStatusRecord>): ProgramStatusRecord {
  return {
    source: "program",
    id: null,
    state: "idle",
    kind: null,
    progress: null,
    app: null,
    title: null,
    msg: null,
    seen: false,
    update_order: 1,
    ...partial,
  };
}

function leaf(id: string, tabs: Tab[], over: Partial<LeafNode> = {}): LeafNode {
  return { kind: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null, ...over };
}

/// Two panes side by side. The left one shows side A (Shell, plan.md) and
/// holds Logs on side B; the right one is active and shows side A (Build),
/// with an empty side B.
function seedLayout(): void {
  const nodes: Record<string, Node> = {
    root: { id: "root", kind: "split", direction: "row", a: "left", b: "right", ratio: 0.5 },
    left: leaf("left", [terminalTab({ id: "shell", title: "Shell" }), fileTab({ id: "plan", path: "notes/plan.md" })], {
      bTabs: [
        terminalTab({
          id: "logs",
          title: "Logs",
          programStatus: { revision: 1, records: [record({ state: "blocked", kind: "question", title: "Proceed?" })] },
        }),
      ],
      bActiveTabId: "logs",
    }),
    right: leaf("right", [terminalTab({ id: "build", title: "Build" })]),
  };
  layout.rootId = "root";
  layout.nodes = nodes;
  layout.activePaneId = "right";
}

async function mountOverlay(): Promise<void> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(PaneTreeOverlay, { target }));
  await tick();
}

async function open(): Promise<void> {
  openPaneTree();
  await tick();
  await tick();
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Panes and tabs"]');
}

function filter(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[aria-label="Filter tabs"]')!;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function rowTitles(): string[] {
  return rows().map((row) => row.querySelector(".title")!.textContent!.trim());
}

function selectedTitle(): string | undefined {
  return rows()
    .find((row) => row.getAttribute("aria-selected") === "true")
    ?.querySelector(".title")
    ?.textContent?.trim();
}

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function type(text: string): Promise<void> {
  const input = filter();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

function ownSnapshot(): ScopedLibrarySnapshot {
  return {
    library_id: "local",
    workspaces: [],
    windows: [{
      window_id: sessionWindowId(), kind: "terminal", ordinal: 2,
      label: "deploy shell", title: "Unrelated terminal title",
      control: false, tmux: false, workspace_path: null,
      connected: true, hidden: false, launch_path: "/terminal/",
    }],
  };
}

beforeEach(async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC);
  vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(ownSnapshot());
  seedLayout();
  closePaneTree();
  await mountOverlay();
});

afterEach(async () => {
  paneMode.active = false;
  closePaneTree();
  for (const component of mounted.splice(0)) await unmount(component);
  windowTabBar.on = false;
  privacy.enabled = false;
  __resetWindowTitle();
  applyTerminalRoster([]);
  vi.mocked(loadScopedLibrarySnapshot).mockReset();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("rendering", () => {
  test("carries no window title of its own: the window tab bar shows it", async () => {
    windowTabBar.on = true;
    await loadWindowTitle();
    expect(windowName()).toBe("Terminal Window 2 [deploy shell]");
    vi.mocked(loadScopedLibrarySnapshot).mockClear();
    await open();
    expect(panel()!.textContent).not.toContain("Terminal Window 2");
    expect(panel()!.hasAttribute("aria-describedby")).toBe(false);
    expect(panel()!.firstElementChild, "the filter leads the panel").toBe(filter().parentElement);
    expect(document.activeElement).toBe(filter());
    expect(loadScopedLibrarySnapshot, "opening the tree reads nothing").not.toHaveBeenCalled();
  });

  test("draws nothing while closed", () => {
    expect(panel()).toBeNull();
  });

  test("lists each pane with its glyph and label, each side with the shown one marked, and every tab", async () => {
    await open();
    const panes = [...document.querySelectorAll<HTMLElement>('.list > [role="group"]')];
    expect(panes.map((pane) => pane.getAttribute("aria-label"))).toEqual([
      "Pane 1: Shell",
      "Pane 2: Build, active",
    ]);
    expect(panes[0]!.querySelectorAll(".glyph rect")).toHaveLength(2);
    expect(panes[0]!.querySelectorAll(".glyph rect.on")).toHaveLength(1);
    const sides = [...document.querySelectorAll<HTMLElement>('.pane > [role="group"]')].map((side) => side.getAttribute("aria-label"));
    expect(sides).toEqual(["Side A, shown", "Side B", "Side A, shown", "Side B"]);
    expect(rowTitles()).toEqual(["Shell", "plan.md", "Logs", "Build"]);
    expect(rows().map((row) => row.querySelector(".kind")!.textContent)).toEqual(["Terminal", "Editor", "Terminal", "Terminal"]);
    expect(document.querySelectorAll(".side-empty"), "the right pane's empty side B").toHaveLength(1);
  });

  test("marks the current tab, each side's active tab and a tab's program status", async () => {
    await open();
    const [shell, plan, logs, build] = rows();
    expect(build!.getAttribute("aria-current")).toBe("true");
    expect(shell!.getAttribute("aria-current")).toBeNull();
    expect([shell, plan, logs, build].map((row) => row!.querySelector('[aria-label="active tab"]') !== null)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(logs!.dataset.programMark).toBe("blocked");
    expect(logs!.querySelector(".mark.blocked")?.getAttribute("aria-label")).toBe("blocked \u00B7 question \u00B7 Proceed?");
  });

  test("opens with the filter focused and the current tab selected", async () => {
    await open();
    expect(document.activeElement).toBe(filter());
    expect(selectedTitle()).toBe("Build");
    expect(filter().getAttribute("aria-activedescendant")).toBe(rows()[3]!.id);
  });

  test("hangs under the anchor when one is shown, else at the top-left corner", async () => {
    await open();
    expect([panel()!.style.top, panel()!.style.left]).toEqual(["8px", "8px"]);
    closePaneTree();
    await tick();

    const anchor = document.createElement("button");
    anchor.setAttribute(PANE_TREE_ANCHOR_ATTR, "");
    anchor.getBoundingClientRect = () => new DOMRect(80, 4, 28, 24);
    document.body.append(anchor);
    await open();
    expect([panel()!.style.top, panel()!.style.left]).toEqual(["34px", "80px"]);
  });
});

describe("the keyboard", () => {
  test("Up and Down walk the tab rows and wrap; Tab and Shift+Tab do the same", async () => {
    await open();
    keydown(filter(), { key: "ArrowDown" });
    await tick();
    expect(selectedTitle(), "wraps from the last row").toBe("Shell");
    keydown(filter(), { key: "ArrowDown" });
    await tick();
    expect(selectedTitle()).toBe("plan.md");
    keydown(filter(), { key: "ArrowUp" });
    keydown(filter(), { key: "ArrowUp" });
    await tick();
    expect(selectedTitle(), "wraps from the first row").toBe("Build");
    keydown(filter(), { key: "Tab", shiftKey: true });
    await tick();
    expect(selectedTitle()).toBe("Logs");
    const tab = keydown(filter(), { key: "Tab" });
    await tick();
    expect(selectedTitle()).toBe("Build");
    expect(tab.defaultPrevented, "Tab stays in the tree").toBe(true);
  });

  test("typing narrows the rows by title, keeps their headers and selects the first match", async () => {
    await open();
    await type("l");
    expect(rowTitles()).toEqual(["Shell", "plan.md", "Logs", "Build"]);
    await type("lo");
    expect(rowTitles()).toEqual(["Logs"]);
    expect(selectedTitle()).toBe("Logs");
    expect([...document.querySelectorAll('.list > [role="group"]')].map((pane) => pane.getAttribute("aria-label"))).toEqual([
      "Pane 1: Shell",
    ]);
    expect([...document.querySelectorAll('.pane > [role="group"]')].map((side) => side.getAttribute("aria-label"))).toEqual([
      "Side B",
    ]);
    await type("zzz");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".none")?.textContent).toBe("No matching tabs");
  });

  test("Enter shows the selected tab: its pane, its side and the tab, with a focus pulse, and closes", async () => {
    await open();
    await type("logs");
    const pulse = tabFocusPulse.value;
    keydown(filter(), { key: "Enter" });
    await tick();

    const left = layout.nodes.left as LeafNode;
    expect(layout.activePaneId).toBe("left");
    expect(left.side).toBe("b");
    expect(left.bActiveTabId).toBe("logs");
    expect(tabFocusPulse.value).toBe(pulse + 1);
    expect(paneTree.open).toBe(false);
    expect(panel()).toBeNull();
  });

  test("Escape closes and hands the keyboard back to where it was", async () => {
    const opener = document.createElement("input");
    document.body.append(opener);
    opener.focus();
    await open();
    expect(document.activeElement).toBe(filter());

    const escape = keydown(filter(), { key: "Escape" });
    await tick();
    await Promise.resolve();
    expect(escape.defaultPrevented).toBe(true);
    expect(paneTree.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(layout.activePaneId, "nothing was picked").toBe("right");
  });

  test("Escape with no element to go back to sends the focus pulse to the active tab", async () => {
    await open();
    const pulse = tabFocusPulse.value;
    keydown(filter(), { key: "Escape" });
    await tick();
    await Promise.resolve();
    expect(tabFocusPulse.value).toBe(pulse + 1);
  });

  test("no key typed in the tree reaches the app's handlers behind it", async () => {
    const seen: string[] = [];
    const listener = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    document.addEventListener("keydown", listener, true);
    document.addEventListener("keydown", listener);
    try {
      await open();
      keydown(filter(), { key: "d", ctrlKey: true });
      keydown(filter(), { key: "ArrowDown" });
      keydown(document.body, { key: "k", metaKey: true });
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener("keydown", listener, true);
      document.removeEventListener("keydown", listener);
    }
  });

  test("a character typed with the filter unfocused goes to the filter", async () => {
    await open();
    filter().blur();
    keydown(document.body, { key: "b" });
    expect(document.activeElement).toBe(filter());
  });
});

describe("the pointer", () => {
  test("a click on a row shows that tab and closes", async () => {
    await open();
    rows()[1]!.click();
    await tick();
    const left = layout.nodes.left as LeafNode;
    expect([layout.activePaneId, left.side ?? "a", left.activeTabId]).toEqual(["left", "a", "plan"]);
    expect(paneTree.open).toBe(false);
  });

  test("a press outside the dropdown closes it without picking", async () => {
    await open();
    const backdrop = document.querySelector<HTMLElement>(".pane-tree-backdrop")!;
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    backdrop.dispatchEvent(press);
    await tick();
    expect(press.defaultPrevented).toBe(true);
    expect(paneTree.open).toBe(false);
    expect(layout.activePaneId).toBe("right");
  });
});

describe("a tmux window", () => {
  /// Two tmux panes side by side, as the server's tmux_layout lays them out:
  /// each pane one terminal tab bound to its pane session, the window's
  /// record labelled with the tmux window's name.
  function seedTmux(recordLabel: string): void {
    const tab = (id: string, title: string, session: string, pane: string) =>
      terminalTab({ id, title, terminalSessionId: session, tmuxPane: { connection: 1, pane } });
    layout.nodes = {
      root: { id: "root", kind: "split", direction: "row", a: "left", b: "right", ratio: 0.5 },
      left: leaf("left", [tab("t0", "tmux %0", "s0", "%0")]),
      right: leaf("right", [tab("t1", "tmux %1", "s1", "%1")]),
    };
    layout.rootId = "root";
    layout.activePaneId = "left";
    const own = ownSnapshot();
    own.windows[0] = { ...own.windows[0]!, ordinal: 3, label: recordLabel, tmux: true };
    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(own);
  }

  /// The roster as the server sends it once tmux has named the panes: what
  /// tmux calls each one, and the tab name the server settled from it, which
  /// is unique, so the second of two alike carries a suffix.
  function hearPanes(left: string, right: string, rightTabName = left === right ? `${right}-2` : right): void {
    const entry = (id: string, tabName: string, tmuxName: string) => ({
      id, tab_name: tabName, tmux_name: tmuxName, tab_group: "tmux", window_id: sessionWindowId(), broadcast: false,
    });
    onWatchEvent({ type: "terminal_roster", sessions: [entry("s0", left, left), entry("s1", rightTabName, right)] });
  }

  /// A tmux window rename as the server sends it: the window's new label to
  /// its own socket, and nothing about the panes.
  function hearWindowRename(name: string): void {
    onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "window_labeled", label: name });
  }

  function paneLabels(): string[] {
    return [...document.querySelectorAll(".pane-label")].map((label) => label.textContent!.trim());
  }

  test("each row shows what tmux calls its pane, and a window rename moves the window's name alone", async () => {
    // A shell beside top: tmux calls the window after its active pane's
    // command, so every switch between the panes renames the window.
    seedTmux("bash");
    hearPanes("bash", "top");
    windowTabBar.on = true;
    await loadWindowTitle();
    await open();
    expect(windowName()).toBe("Terminal Window 3 [bash]");
    expect(rowTitles()).toEqual(["bash", "top"]);
    expect(paneLabels()).toEqual(["bash", "top"]);

    hearWindowRename("top");
    await vi.waitFor(() => expect(windowName()).toBe("Terminal Window 3 [top]"));
    expect(rowTitles()).toEqual(["bash", "top"]);
    expect(paneLabels()).toEqual(["bash", "top"]);

    // While the tree is closed the window is renamed back and the first pane
    // starts another program: the next open shows both.
    closePaneTree();
    await tick();
    hearWindowRename("bash");
    hearPanes("vim", "top");
    await open();
    expect(windowName()).toBe("Terminal Window 3 [bash]");
    expect(rowTitles()).toEqual(["vim", "top"]);
    expect(loadScopedLibrarySnapshot, "the frames kept the names; nothing was read again").toHaveBeenCalledTimes(1);
  });

  test("panes tmux calls the same show that name, without the suffix their tab names differ by", async () => {
    seedTmux("bash");
    hearPanes("bash", "bash");
    windowTabBar.on = true;
    await open();
    expect(rowTitles()).toEqual(["bash", "bash"]);
    expect(paneLabels()).toEqual(["bash", "bash"]);

    // The first pane runs another program. The second keeps the tab name it
    // was given, suffix and all, and still shows as what tmux calls it.
    hearPanes("vim", "bash", "bash-2");
    await tick();
    expect(rowTitles()).toEqual(["vim", "bash"]);
    expect(paneLabels()).toEqual(["vim", "bash"]);
  });

  test("a pane tmux has not named yet reads as its tab name", async () => {
    seedTmux("bash");
    windowTabBar.on = true;
    await open();
    expect(rowTitles()).toEqual(["tmux %0", "tmux %1"]);
  });

  test("a window rename before the first read shows at that read", async () => {
    // The server labels the record before it tells the page, so the first
    // read carries the new name.
    seedTmux("build");
    hearWindowRename("build");
    hearPanes("bash", "top");
    windowTabBar.on = true;
    await loadWindowTitle();
    await open();
    expect(windowName()).toBe("Terminal Window 3 [build]");
    expect(rowTitles()).toEqual(["bash", "top"]);
  });
});

describe("opening", () => {
  test("the chord opens the tree from the page and closes it again from inside", async () => {
    const press = keydown(document.body, { key: "A", code: "KeyA", metaKey: true, shiftKey: true });
    await tick();
    await tick();
    expect(press.defaultPrevented).toBe(true);
    expect(paneTree.open).toBe(true);

    keydown(filter(), { key: "A", code: "KeyA", metaKey: true, shiftKey: true });
    await tick();
    expect(paneTree.open).toBe(false);
  });

  test("the chord does nothing while Hybrid Nav is up", async () => {
    paneMode.active = true;
    keydown(document.body, { key: "A", code: "KeyA", metaKey: true, shiftKey: true });
    await tick();
    expect(paneTree.open).toBe(false);
  });

  test("Hybrid Nav coming up closes the tree", async () => {
    await open();
    paneMode.active = true;
    await tick();
    expect(paneTree.open).toBe(false);
  });

  test("the window's command bus toggles it", async () => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.pane.tree" } }));
    await tick();
    expect(paneTree.open).toBe(true);
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.pane.tree" } }));
    await tick();
    expect(paneTree.open).toBe(false);
  });
});

describe("what runs in a terminal", () => {
  /// The live tab `id` in the seeded layout, as the store holds it, so a
  /// write through it is what a frame handler's write is.
  function liveTerminal(id: string): TerminalTab {
    for (const node of Object.values(layout.nodes)) {
      if (node.kind !== "leaf") continue;
      const found = [...node.tabs, ...(node.bTabs ?? [])].find((tab) => tab.id === id);
      if (found?.kind === "terminal") return found;
    }
    throw new Error(`no terminal ${id}`);
  }

  function row(title: string): HTMLElement {
    const found = rows().find((candidate) => candidate.querySelector(".title")?.textContent?.trim() === title);
    if (!found) throw new Error(`no row ${title}`);
    return found;
  }

  function reading(title: string): string | null {
    return row(title).querySelector(".program")?.textContent?.trim() ?? null;
  }

  test("a terminal row shows its reading beside an unchanged tab name, inside the row", async () => {
    liveTerminal("shell").terminalProgram = { title: null, command: "bash" };
    liveTerminal("build").terminalProgram = { title: "build", command: "cargo" };
    await open();
    expect(rowTitles()).toEqual(["Shell", "plan.md", "Logs", "Build"]);
    expect([reading("Shell"), reading("plan.md"), reading("Logs"), reading("Build")]).toEqual(["bash", null, null, "build"]);
    const shell = row("Shell");
    expect(shell.querySelector(".label > .title + .program")).not.toBeNull();
    expect(shell.querySelector("button"), "no control nested inside the row").toBeNull();
    expect(shell.getAttribute("title")).not.toContain("bash");
  });

  test("follows a change while open, and a reopen reads the latest", async () => {
    liveTerminal("shell").terminalProgram = { title: null, command: "bash" };
    await open();
    liveTerminal("shell").terminalProgram = { title: null, command: "vim" };
    await tick();
    expect(reading("Shell")).toBe("vim");
    liveTerminal("logs").terminalProgram = { title: "tail -f app.log", command: "tail" };
    await tick();
    expect(reading("Logs"), "a tab on the hidden side follows too").toBe("tail -f app.log");
    closePaneTree();
    await tick();
    liveTerminal("shell").terminalProgram = { title: null, command: "bash" };
    await open();
    expect(reading("Shell")).toBe("bash");
    liveTerminal("shell").terminalProgram = undefined;
    await tick();
    expect(reading("Shell")).toBeNull();
  });

  test("privacy mode shows Hidden and keeps the reading out of the panel, before and during updates, and off restores the latest", async () => {
    const first = "deploy@prod-db-7";
    const second = "secret-plan.md - vim";
    privacy.enabled = true;
    liveTerminal("shell").terminalProgram = { title: first, command: "ssh" };
    await open();
    expect(reading("Shell")).toBe("Hidden");
    expect(reading("plan.md"), "nothing stands in where there is no reading").toBeNull();
    expect(panel()!.outerHTML).not.toContain(first);
    expect(panel()!.outerHTML).not.toContain("ssh");

    liveTerminal("shell").terminalProgram = { title: second, command: "vim" };
    await tick();
    expect(reading("Shell")).toBe("Hidden");
    for (const secret of [first, second, "vim", "ssh"]) expect(panel()!.outerHTML).not.toContain(secret);
    await type("secret");
    expect(rowTitles(), "the filter never reads the reading").toEqual([]);
    await type("");

    privacy.enabled = false;
    await tick();
    expect(reading("Shell")).toBe(second);
    await type("secret");
    expect(rowTitles(), "nor with privacy off").toEqual([]);
  });

  test("privacy turned on while open hides a shown reading at once", async () => {
    liveTerminal("build").terminalProgram = { title: "build", command: "cargo" };
    await open();
    expect(reading("Build")).toBe("build");
    privacy.enabled = true;
    await tick();
    expect(reading("Build")).toBe("Hidden");
    expect(row("Build").textContent).not.toContain("cargo");
  });

  test("a tmux window's rows show no reading, whatever their tabs hold", async () => {
    const tab = terminalTab({
      id: "t0",
      title: "tmux %0",
      terminalSessionId: "s0",
      tmuxPane: { connection: 1, pane: "%0" },
      terminalProgram: { title: "not tmux's name", command: "vim" },
    });
    layout.nodes = { solo: leaf("solo", [tab]) };
    layout.rootId = "solo";
    layout.activePaneId = "solo";
    await open();
    expect(rowTitles()).toEqual(["tmux %0"]);
    expect(document.querySelector(".pane-tree .program")).toBeNull();
    expect(panel()!.outerHTML).not.toContain("not tmux's name");
  });
});
