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
import { layout, paneMode, tabFocusPulse, type LeafNode, type Node, type Tab } from "../state/tabs.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { applyWindowLabel, __resetWindowTitle } from "../state/windowTitle.svelte";
import { privacy } from "@chan/web-shared/privacy";
import { loadScopedLibrarySnapshot, type ScopedLibrarySnapshot } from "../api/libraryCommand";
import { sessionWindowId } from "../api/client";

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
  vi.mocked(loadScopedLibrarySnapshot).mockReset();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("rendering", () => {
  test("names the window above the filter when title bar tabs are on, retaining filter focus", async () => {
    windowTabBar.on = true;
    await open();
    await vi.waitFor(() => expect(panel()?.querySelector(".window-title")?.textContent).toBe("Terminal Window 2 [deploy shell]"));
    const heading = panel()!.querySelector(".window-title")!;
    expect(heading.nextElementSibling).toBe(filter().parentElement);
    expect(document.activeElement).toBe(filter());
    closePaneTree();
    await tick();
    await open();
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(1);
  });

  test("follows renames and privacy without putting the label into the filter", async () => {
    windowTabBar.on = true;
    await open();
    await vi.waitFor(() => expect(panel()?.querySelector(".window-title")?.textContent).toContain("deploy shell"));
    await type("Build");
    applyWindowLabel("release checks");
    await tick();
    expect(panel()!.querySelector(".window-title")?.textContent).toBe("Terminal Window 2 [release checks]");
    expect(rowTitles()).toEqual(["Build"]);
    privacy.enabled = true;
    await tick();
    expect(panel()!.querySelector(".window-title")?.textContent).toBe("Terminal Window 2");
    expect(panel()!.querySelector(".window-title")?.getAttribute("title")).toBe("Terminal Window 2");
    applyWindowLabel("private.example");
    await tick();
    expect(panel()!.querySelector(".window-title")?.textContent).not.toContain("private.example");
    privacy.enabled = false;
    await tick();
    expect(panel()!.querySelector(".window-title")?.textContent).toBe("Terminal Window 2 [private.example]");
    applyWindowLabel("");
    await tick();
    expect(panel()!.querySelector(".window-title")?.textContent).toBe("Terminal Window 2");
  });

  test("keeps ordinary pane strips free of a duplicate window title and follows a mode switch", async () => {
    await open();
    expect(panel()!.querySelector(".window-title")).toBeNull();
    expect(loadScopedLibrarySnapshot).not.toHaveBeenCalled();
    windowTabBar.on = true;
    await vi.waitFor(() => expect(panel()?.querySelector(".window-title")).not.toBeNull());
    windowTabBar.on = false;
    await tick();
    expect(panel()!.querySelector(".window-title")).toBeNull();
  });

  test("keeps the picker usable when the window record cannot be loaded, and retries on reopen", async () => {
    vi.mocked(loadScopedLibrarySnapshot).mockRejectedValueOnce(new Error("offline"));
    windowTabBar.on = true;
    await open();
    await vi.waitFor(() => expect(panel()!.querySelector(".window-title")).toBeNull());
    expect(panel()!.hasAttribute("aria-describedby")).toBe(false);
    expect(document.activeElement).toBe(filter());
    expect(rowTitles()).toEqual(["Shell", "plan.md", "Logs", "Build"]);
    closePaneTree();
    await tick();
    await open();
    await vi.waitFor(() => expect(panel()?.querySelector(".window-title")?.textContent).toBe("Terminal Window 2 [deploy shell]"));
  });

  // jsdom lays nothing out, so the pin is structural: the same two elements
  // sit above the list before and after the name arrives, the first holding
  // a line of text either way.
  test("holds the heading's row while the name is read, so the filter and the list stay put", async () => {
    let resolve!: (value: ScopedLibrarySnapshot) => void;
    vi.mocked(loadScopedLibrarySnapshot).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    windowTabBar.on = true;
    await open();
    const list = panel()!.querySelector('[role="listbox"]')!;
    const aboveList = (): Element[] => {
      const children = [...panel()!.children];
      return children.slice(0, children.indexOf(list));
    };
    const held = aboveList();
    expect(held).toHaveLength(2);
    expect(held[0]!.classList.contains("window-title")).toBe(true);
    expect(held[0]!.textContent).toBe("\u00a0");
    expect(held[1]).toBe(filter().parentElement);
    expect(panel()!.hasAttribute("aria-describedby")).toBe(false);

    resolve(ownSnapshot());
    await vi.waitFor(() => expect(held[0]!.textContent).toBe("Terminal Window 2 [deploy shell]"));
    const after = aboveList();
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(held[0]);
    expect(after[1]).toBe(held[1]);
    expect(document.activeElement).toBe(filter());
  });

  test("describes the dialog with the window name and keeps its accessible name", async () => {
    windowTabBar.on = true;
    await open();
    await vi.waitFor(() => expect(panel()?.querySelector(".window-title")?.textContent).toBe("Terminal Window 2 [deploy shell]"));
    expect(panel()!.getAttribute("aria-label")).toBe("Panes and tabs");
    const description = (): string | null | undefined =>
      document.getElementById(panel()!.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(description()).toBe("Terminal Window 2 [deploy shell]");
    privacy.enabled = true;
    await tick();
    expect(description()).toBe("Terminal Window 2");
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
