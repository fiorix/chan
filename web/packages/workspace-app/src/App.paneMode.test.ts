// @vitest-environment jsdom
//
// Hybrid Nav (Ctrl+. here, Cmd+. on macOS) edits a draft of the layout and
// leaves the live one alone until Enter commits it; Escape drops the draft.
// Arrows move focus and WASD swaps tiles; brackets, minus and equals resize,
// zero evens a split out, and Tab flips the focused pane's side. Letters stage
// tabs into the draft, each only where its surface exists, and a Dashboard
// wherever the launcher offers one, a window with no workspace included and no
// control terminal; h shows the help. A staged terminal takes the server's
// name, and settling it leaves the draft fresh. The dock toggles commit first.
// A draft gone stale answers only Escape and h. Outside it, the spawn commands
// and the new-terminal chord open at the focused tab's folder, and the pane
// commands close tabs, panes and empty sides. Cmd+W closes a tab the same way
// in a control-terminal window, so a live terminal there asks first. While a
// dialog is open, the keys and host commands meant for it stay with it: none
// of them enters, commits or drops Hybrid Nav or acts on the layout under the
// dialog. In a tmux window the draft stages what tmux is asked for on Enter, a
// divider drag's resize included, and its panes have no sides.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

// The capabilities are fixed per window at load; a mutable copy lets one
// window stand in for one that lacks a surface.
const caps = vi.hoisted(() => ({}) as { workspace: boolean; files: boolean; drafts: boolean });

vi.mock("./state/windowCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/windowCaps")>();
  Object.assign(caps, actual.windowCaps);
  return { ...actual, windowCaps: caps };
});

vi.mock("./state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/store.svelte")>()),
  discardWindowSession: vi.fn(async () => {}),
}));

import { api, sessionWindowId } from "./api/client";
import { setSocketFactory } from "./api/transport";
import { demoSocketFactory } from "./demo/socket";
import { availableCommands, commandContext } from "./state/commands";
import { demoData, hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout, terminalTab } from "./__tests__/tabs";
import { uiCloseConfirm } from "./state/closeConfirm.svelte";
import { confirmState, uiConfirm } from "./state/confirm.svelte";
import { browserSidePanes, discardWindowSession, onWatchEvent, ui, uiPathPrompt, uiPrompt } from "./state/store.svelte";
import {
  allTerminalTabs,
  applyTerminalRoster,
  cancelPaneMode,
  clearRecentlyClosedTabsForTest,
  closePane,
  layout,
  moveActiveTabToSide,
  paneMode,
  paneSideToggleFlash,
  splitPane,
  type LayoutState,
  type LeafNode,
  type Split,
  type Tab,
  type TerminalTab,
} from "./state/tabs.svelte";
import { closeTeamDialog, teamDialogState } from "./state/teamDialog.svelte";
import { setTmuxLayout, tmuxWindowSizeHeld } from "./state/tmuxWindowSize.svelte";

stubAppEnvironment();

const DOC = () => fileTab({ id: "doc", path: "notes/a.md", content: "hello", saved: "hello" });
const TMUX_TAB = (id: string, session: string, pane: string) =>
  terminalTab({ id, terminalSessionId: session, tmuxPane: { connection: 1, pane } });

beforeEach(async () => {
  Object.assign(caps, { workspace: true, files: true, drafts: true });
  await mountApp(
    demoData([
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
});

afterEach(async () => {
  setTmuxLayout(null);
  cancelPaneMode();
  closeTeamDialog();
  browserSidePanes.left = false;
  browserSidePanes.right = false;
  await settle();
  await unmountApp();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/// A layout of the doc's pane and an empty one beside it (`row`) or below
/// it (`column`), with the doc's pane focused. Answers the empty pane's id.
async function twoPanes(direction: "row" | "column" = "row"): Promise<string> {
  resetLayout([DOC()]);
  const other = splitPane("pane-test", direction)!;
  layout.activePaneId = "pane-test";
  await settle();
  return other;
}

async function enterHybridNav(): Promise<void> {
  press({ key: ".", code: "Period", ctrlKey: true });
  await settle();
  expect(paneMode.active).toBe(true);
}

async function keys(...pressed: Array<string | KeyboardEventInit>): Promise<void> {
  for (const key of pressed) press(typeof key === "string" ? { key } : key);
  await settle();
}

function draft(): LayoutState {
  return paneMode.draft!;
}

function leaf(state: LayoutState, id: string): LeafNode {
  return state.nodes[id] as LeafNode;
}

function rootSplit(state: LayoutState): Split {
  return state.nodes[state.rootId] as Split;
}

function kinds(tabs: Tab[]): string[] {
  return tabs.map((tab) => tab.kind);
}

/// Drag the layout's only divider from the middle of its 1000 px split to `x`.
/// Answers whether the divider took the press.
async function dragDivider(x: number): Promise<boolean> {
  const divider = document.querySelector<HTMLElement>(".split > .divider")!;
  vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 600 } as DOMRect);
  const taken = !divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  await settle();
  return taken;
}

describe("entering and leaving Hybrid Nav", () => {
  test("Ctrl+. enters, and Escape drops what was staged", async () => {
    await twoPanes();
    await enterHybridNav();
    await keys("t");
    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file", "terminal"]);

    await keys("Escape");

    expect(paneMode.active).toBe(false);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file"]);
  });

  test("Enter commits the draft", async () => {
    await twoPanes();
    await enterHybridNav();
    await keys("t");
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file"]);

    await keys("Enter");

    expect(paneMode.active).toBe(false);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file", "terminal"]);
  });
});

describe("arranging the draft", () => {
  test.each([
    ["row", "ArrowRight", "ArrowLeft"],
    ["column", "ArrowDown", "ArrowUp"],
  ] as const)("in a %s split, %s and %s move the focus", async (direction, toward, back) => {
    const other = await twoPanes(direction);
    await enterHybridNav();

    await keys(toward);
    expect(draft().activePaneId).toBe(other);
    await keys(back);
    expect(draft().activePaneId).toBe("pane-test");
  });

  test.each([
    ["row", "d", "A"],
    ["row", "D", "a"],
    ["column", "s", "W"],
    ["column", "S", "w"],
  ] as const)("in a %s split, %s and %s swap the focused tile's contents", async (direction, toward, back) => {
    const other = await twoPanes(direction);
    await enterHybridNav();

    await keys(toward);
    expect(leaf(draft(), other).tabs.map((tab) => tab.id)).toEqual(["doc"]);
    expect(leaf(draft(), "pane-test").tabs).toEqual([]);
    expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["doc"]);

    await keys(back);
    expect(leaf(draft(), "pane-test").tabs.map((tab) => tab.id)).toEqual(["doc"]);
  });

  test.each([
    ["row", "]", "["],
    ["column", "=", "-"],
  ] as const)("in a %s split, %s grows and %s shrinks the focused side one step, Shift or not, and 0 evens it", async (direction, grow, shrink) => {
    await twoPanes(direction);
    await enterHybridNav();

    await keys(grow);
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.52);
    await keys(shrink, shrink);
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.48);
    // Some layouts type the key with Shift: `=` is Shift+0 on a German one.
    await keys({ key: grow, shiftKey: true }, { key: grow, shiftKey: true });
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.52);
    await keys("0");
    expect(rootSplit(draft()).ratio).toBe(0.5);
    expect(rootSplit(layout).ratio).toBe(0.5);
  });

  test("a divider drag moves the draft's divider, a staged split's too, and Enter keeps it", async () => {
    resetLayout([DOC()]);
    await settle();
    await enterHybridNav();
    await keys("/");

    expect(await dragDivider(700)).toBe(true);
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.7);
    await keys("Enter");

    expect(rootSplit(layout).ratio).toBeCloseTo(0.7);
  });

  test("Tab flips the focused pane's side in the draft and stays in Hybrid Nav", async () => {
    await twoPanes();
    await enterHybridNav();

    await keys("Tab");

    expect(leaf(draft(), "pane-test").side).toBe("b");
    expect(leaf(layout, "pane-test").side).toBeUndefined();
    expect(paneMode.active).toBe(true);
  });
});

describe("staging tabs", () => {
  test("f, g and b stage a Files, a Graph and a Dashboard tab into the draft only", async () => {
    await twoPanes();
    await enterHybridNav();

    await keys("f", "g", "b");

    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file", "browser", "graph", "dashboard"]);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file"]);
  });

  test("n and e stage a draft and a diagram, created only on commit", async () => {
    await twoPanes();
    const createDraft = vi.spyOn(api, "createDraft");
    await enterHybridNav();

    await keys("n", "E");

    expect(paneMode.stagedDraftEditors.map((entry) => entry.kind)).toEqual(["draft", "diagram"]);
    expect(createDraft).not.toHaveBeenCalled();
  });

  test("o and i leave the draft and staged editors unchanged", async () => {
    await twoPanes();
    await enterHybridNav();
    const before = JSON.stringify(draft());

    await keys("o", "O", "i", "I");

    expect(JSON.stringify(draft())).toBe(before);
    expect(paneMode.stagedDraftEditors).toEqual([]);
  });

  test("h shows the help and hides it again, still in Hybrid Nav", async () => {
    await twoPanes();
    await enterHybridNav();
    expect(document.querySelector(".pane-mode-help")).toBeNull();

    await keys("h");
    expect(document.querySelector(".pane-mode-help")).not.toBeNull();
    await keys("H");
    expect(document.querySelector(".pane-mode-help")).toBeNull();
    expect(paneMode.active).toBe(true);
  });

  test.each([
    ["f", "files"],
    ["g", "workspace"],
    ["n", "drafts"],
    ["e", "drafts"],
  ] as const)("%s stages nothing in a window without %s", async (key, surface) => {
    await twoPanes();
    await enterHybridNav();
    caps[surface] = false;

    await keys(key);

    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file"]);
    expect(paneMode.stagedDraftEditors).toEqual([]);
  });

  describe("in a window with no workspace", () => {
    /// One pane holding one terminal in a window with no workspace, files or
    /// drafts; `control` makes it a control terminal.
    async function terminalsOnly(control: boolean): Promise<void> {
      Object.assign(caps, { workspace: false, files: false, drafts: false });
      ui.terminalOnly = true;
      ui.terminalControl = control;
      resetLayout([terminalTab({ id: "term" })]);
      await settle();
    }

    afterEach(() => {
      ui.terminalOnly = false;
      ui.terminalControl = false;
    });

    test("b stages a Dashboard, and Enter commits it", async () => {
      await terminalsOnly(false);
      await enterHybridNav();

      await keys("b");
      expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["terminal", "dashboard"]);
      expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["terminal"]);

      await keys("Enter");
      expect(paneMode.active).toBe(false);
      const pane = leaf(layout, "pane-test");
      expect(kinds(pane.tabs)).toEqual(["terminal", "dashboard"]);
      expect(pane.tabs.find((tab) => tab.id === pane.activeTabId)?.kind).toBe("dashboard");
    });

    test("b stages nothing in a control terminal, whose hidden strip would leave no way back", async () => {
      await terminalsOnly(true);
      await enterHybridNav();

      await keys("b");
      expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["terminal"]);

      await keys("Enter");
      expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["terminal"]);
    });
  });

  test("keys with no binding leave the draft alone", async () => {
    await twoPanes();
    await enterHybridNav();
    const before = JSON.stringify(draft());

    await keys("1", "2", "3", "4", "p", "k", "Backspace");

    expect(JSON.stringify(draft())).toBe(before);
    expect(paneMode.stagedDraftEditors).toEqual([]);
    expect(paneMode.active).toBe(true);
  });
});

/// The terminal registry's naming over the demo transport's PTY stand-in: a
/// new session takes the name it asks for unless a session of the tenant holds
/// it, and then that name with the first free `-N` suffix, which its session
/// frame carries. `held` lists the names taken, other windows' among them.
function namingSockets(held: string[]): (url: string) => WebSocket {
  return (url) => {
    type Handler = ((event: { data: unknown }) => void) | null;
    const socket = demoSocketFactory(url) as unknown as { onmessage: Handler };
    const query = new URL(url).searchParams;
    const asked = query.get("tab_name");
    if (!asked || query.has("session")) return socket as unknown as WebSocket;
    let name = asked;
    for (let n = 2; held.includes(name); n++) name = `${asked}-${n}`;
    held.push(name);
    let handler: Handler = null;
    Object.defineProperty(socket, "onmessage", {
      configurable: true,
      get: () => handler,
      set: (next: Handler) => {
        handler =
          next &&
          ((event) => {
            const frame = typeof event.data === "string" ? (JSON.parse(event.data) as { type?: string }) : null;
            next(frame?.type === "session" ? { data: JSON.stringify({ ...frame, name }) } : event);
          });
      },
    });
    return socket as unknown as WebSocket;
  };
}

describe("a staged terminal's name", () => {
  /// The terminal beside the doc.
  function terminalIn(state: LayoutState): TerminalTab | undefined {
    return leaf(state, "pane-test").tabs.find((tab): tab is TerminalTab => tab.kind === "terminal");
  }

  /// Stage a terminal beside the doc and answer it once its session frame
  /// has landed.
  async function stageTerminal(): Promise<TerminalTab> {
    await twoPanes();
    await enterHybridNav();
    await keys("t");
    let staged: TerminalTab | undefined;
    await vi.waitFor(() => {
      staged = terminalIn(draft());
      expect(staged?.terminalSessionId).toBeTruthy();
    });
    return staged!;
  }

  test("is the server's next name, even where this window's own count would clash", async () => {
    // Another window of the workspace holds Terminal-1.
    setSocketFactory(namingSockets(["Terminal-1"]));
    vi.spyOn(api, "terminalNextName").mockResolvedValue("Terminal-2");

    expect((await stageTerminal()).title).toBe("Terminal-2");
    expect(paneMode.stale).toBe(false);

    await keys("Enter");
    expect(terminalIn(layout)?.title).toBe("Terminal-2");
  });

  test("is the name the server settles, without making the draft stale, when another window took the proposal first", async () => {
    setSocketFactory(namingSockets(["Terminal-1", "Terminal-2"]));
    vi.spyOn(api, "terminalNextName").mockResolvedValue("Terminal-2");

    expect((await stageTerminal()).title).toBe("Terminal-2-2");
    expect(paneMode.stale).toBe(false);

    await keys("Enter");
    expect(paneMode.active).toBe(false);
    expect(terminalIn(layout)?.title).toBe("Terminal-2-2");
  });
});

describe("the dock toggles", () => {
  test("< commits the draft and toggles the right Files dock, > the left", async () => {
    await twoPanes();
    await enterHybridNav();
    await keys("t", "<");

    expect(paneMode.active).toBe(false);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file", "terminal"]);
    expect(browserSidePanes).toEqual({ left: false, right: true });

    await enterHybridNav();
    await keys(">");
    expect(paneMode.active).toBe(false);
    expect(browserSidePanes).toEqual({ left: true, right: true });
  });

  test("do nothing in a window with no files", async () => {
    await twoPanes();
    await enterHybridNav();
    caps.files = false;

    await keys("<", ">");

    expect(paneMode.active).toBe(true);
    expect(browserSidePanes).toEqual({ left: false, right: false });
  });
});

describe("a stale draft", () => {
  test("answers only Escape and h", async () => {
    await twoPanes();
    await enterHybridNav();
    paneMode.stale = true;
    const before = JSON.stringify(draft());

    await keys("ArrowRight", "d", "]", "0", "Tab", "t", "f", "e", "n", "/", "<", "Enter");

    expect(paneMode.active).toBe(true);
    expect(JSON.stringify(draft())).toBe(before);
    expect(paneMode.stagedDraftEditors).toEqual([]);
    expect(browserSidePanes).toEqual({ left: false, right: false });

    await keys("h");
    expect(document.querySelector(".pane-mode-help")).not.toBeNull();
    await keys("Escape");
    expect(paneMode.active).toBe(false);
  });
});

describe("a staged draft whose pane closed before the draft existed", () => {
  test("opens in the focused pane and says so", async () => {
    const other = await twoPanes();
    let mint!: () => void;
    const minted = new Promise<void>((resolve) => (mint = resolve));
    const create = api.createDraft;
    vi.spyOn(api, "createDraft").mockImplementation(async () => {
      await minted;
      return create();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await enterHybridNav();
    await keys("ArrowRight", "n", "Enter");

    await closePane(other, { force: true });
    mint();

    await vi.waitFor(() => expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file", "file"]));
    expect(ui.status).toBe("Target pane disappeared; opened here.");
  });
});

describe("spawning from the focused tab", () => {
  beforeEach(async () => {
    resetLayout([DOC()]);
    await settle();
  });

  function spawned(): Tab {
    const tabs = leaf(layout, "pane-test").tabs;
    return tabs[tabs.length - 1];
  }

  test("Ctrl+Shift+T opens a terminal in the doc's folder", async () => {
    press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    await settle();

    expect(spawned()).toMatchObject({ kind: "terminal", cwd: "notes" });
  });

  test("the host's new-terminal command does too, with the shell it names", async () => {
    hostCommand("app.terminal.toggle", { profile: "zsh" });
    await settle();

    expect(spawned()).toMatchObject({ kind: "terminal", cwd: "notes", profile: "zsh" });
  });

  test("the host's Files command opens a Files tab on the doc", async () => {
    hostCommand("app.files.toggle");
    await settle();

    expect(spawned()).toMatchObject({ kind: "browser", selected: "notes/a.md" });
  });

  test("the host's Graph command opens a graph", async () => {
    hostCommand("app.graph.toggle");
    await settle();

    expect(spawned().kind).toBe("graph");
  });

  test("the host's Team Work command opens a lead terminal in the doc's folder, then the team dialog on it", async () => {
    hostCommand("app.terminal.teamWork");
    await settle();

    const lead = spawned();
    expect(lead).toMatchObject({ kind: "terminal", cwd: "notes" });
    expect(teamDialogState.request).toEqual({ leadTabId: lead.id, leadPaneId: "pane-test" });
  });
});

describe("the pane commands", () => {
  test("Close all tabs empties the focused pane", async () => {
    resetLayout([DOC(), fileTab({ id: "readme", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();

    hostCommand("app.pane.closeTabs");

    await vi.waitFor(() => expect(leaf(layout, "pane-test").tabs).toEqual([]));
  });

  test("Kill pane closes the focused pane", async () => {
    const other = await twoPanes();
    layout.activePaneId = other;

    hostCommand("app.pane.kill");

    await vi.waitFor(() => expect(layout.nodes[other]).toBeUndefined());
  });

  test("Cmd+W closes the focused tab and Ctrl+W is left to the browser", async () => {
    resetLayout([DOC()]);
    await settle();

    const ctrl = press({ key: "w", code: "KeyW", ctrlKey: true });
    await settle();
    expect(ctrl.defaultPrevented).toBe(false);
    expect(leaf(layout, "pane-test").tabs).toHaveLength(1);

    press({ key: "w", code: "KeyW", metaKey: true });
    await vi.waitFor(() => expect(leaf(layout, "pane-test").tabs).toEqual([]));
  });

  test("Cmd+W in a control-terminal window asks before closing its live terminal, as any window does", async () => {
    ui.terminalOnly = true;
    ui.terminalControl = true;
    try {
      resetLayout([terminalTab({ id: "control" }), terminalTab({ id: "second", terminalSessionId: "sess-second" })], {
        activeTabId: "second",
      });
      await settle();

      press({ key: "w", code: "KeyW", metaKey: true });

      await vi.waitFor(() => expect(document.querySelector(".modal .title")?.textContent).toBe("Close tab?"));
      document.querySelector<HTMLButtonElement>(".modal .actions button.ok")!.click();
      await vi.waitFor(() => expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["control"]));
    } finally {
      ui.terminalOnly = false;
      ui.terminalControl = false;
    }
  });

  test("Close tab on an empty pane closes the pane", async () => {
    const other = await twoPanes();
    layout.activePaneId = other;

    hostCommand("app.tab.close");

    await vi.waitFor(() => expect(layout.nodes[other]).toBeUndefined());
  });

  test("Close window on an empty pane closes the pane and keeps the window", async () => {
    const other = await twoPanes();
    layout.activePaneId = other;

    hostCommand("app.window.close");

    await vi.waitFor(() => expect(layout.nodes[other]).toBeUndefined());
    expect(discardWindowSession).not.toHaveBeenCalled();
  });

  test("Close tab on an empty side flips to the side that holds tabs and flashes the side button", async () => {
    resetLayout([], { bTabs: [DOC()], bActiveTabId: "doc" });
    await settle();
    const flashes = paneSideToggleFlash.versions["pane-test"] ?? 0;

    hostCommand("app.tab.close");
    await settle();

    expect(leaf(layout, "pane-test").side).toBe("b");
    expect(leaf(layout, "pane-test").bTabs?.map((tab) => tab.id)).toEqual(["doc"]);
    expect(paneSideToggleFlash.versions["pane-test"]).toBe(flashes + 1);
  });
});

describe("keys under an open dialog", () => {
  /// Press a key where the keyboard is, on the focused element, so it passes
  /// through the dialog's own handlers on its way up as a keystroke does.
  function pressFocused(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  }

  /// Wait for the confirm titled `title` to hold the focus on its OK button.
  async function confirmFocused(title: string): Promise<void> {
    await vi.waitFor(() => expect(document.querySelector(".modal .title")?.textContent).toBe(title));
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector(".modal .actions button.ok")));
  }

  /// Record every answer the open confirm gets from here on.
  function answersOfOpenConfirm(): boolean[] {
    const answers: boolean[] = [];
    const resolve = confirmState.resolve!;
    confirmState.resolve = (value) => {
      answers.push(value);
      resolve(value);
    };
    return answers;
  }

  async function twoLiveTerminals(): Promise<void> {
    resetLayout(
      [terminalTab({ id: "first", terminalSessionId: "sess-first" }), terminalTab({ id: "second", terminalSessionId: "sess-second" })],
      { activeTabId: "second" },
    );
    await settle();
  }

  test("Cmd+. under the close confirm does not enter Hybrid Nav, and Enter answers the confirm once", async () => {
    await twoLiveTerminals();
    hostCommand("app.tab.close");
    await confirmFocused("Close tab?");
    const answers = answersOfOpenConfirm();

    pressFocused({ key: ".", code: "Period", metaKey: true });
    await settle();
    expect(paneMode.active).toBe(false);

    pressFocused({ key: "Enter", code: "Enter" });

    await vi.waitFor(() => expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["first"]));
    expect(answers).toEqual([true]);
    expect(confirmState.open).toBe(false);
    expect(paneMode.active).toBe(false);
    expect(layout.rootId).toBe("pane-test");
    expect(Object.keys(layout.nodes)).toEqual(["pane-test"]);
  });

  test("Cmd+` under the close confirm passes to the window cycler", async () => {
    await twoLiveTerminals();
    hostCommand("app.tab.close");
    await confirmFocused("Close tab?");
    const reached: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => reached.push(event);
    window.addEventListener("keydown", listener);
    try {
      const event = pressFocused({ key: "`", code: "Backquote", metaKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(reached).toEqual([event]);
    } finally {
      window.removeEventListener("keydown", listener);
    }

    pressFocused({ key: "Escape", code: "Escape" });
    await settle();
    expect(confirmState.open).toBe(false);
    expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["first", "second"]);
  });

  test("with a draft staged, Enter and Escape answer an open confirm and leave the draft staged", async () => {
    await twoPanes();
    await enterHybridNav();
    await keys("t");

    const accepted = uiConfirm({ title: "Go on?" });
    await confirmFocused("Go on?");
    pressFocused({ key: "Enter", code: "Enter" });
    await expect(accepted).resolves.toBe(true);
    await settle();
    expect(paneMode.active).toBe(true);
    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file", "terminal"]);

    const declined = uiConfirm({ title: "Go on?" });
    await confirmFocused("Go on?");
    pressFocused({ key: "Escape", code: "Escape" });
    await expect(declined).resolves.toBe(false);
    await settle();
    expect(paneMode.active).toBe(true);
    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file", "terminal"]);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file"]);

    await keys("Enter");
    expect(paneMode.active).toBe(false);
    expect(kinds(leaf(layout, "pane-test").tabs)).toEqual(["file", "terminal"]);
  });

  test.each([
    ["the bridged Cmd+/ split", () => hostCommand("app.pane.splitRight")],
    ["the bridged Cmd+T new terminal", () => hostCommand("app.terminal.toggle")],
    ["the bridged Cmd+Shift+T reopen", () => hostCommand("app.tab.reopenClosed")],
    ["the page's Ctrl+Alt+/ split", () => pressFocused({ key: "/", code: "Slash", ctrlKey: true, altKey: true })],
    ["the page's Ctrl+Alt+Shift+T reopen", () => pressFocused({ key: "T", code: "KeyT", ctrlKey: true, altKey: true, shiftKey: true })],
  ])("%s under the close confirm acts on nothing", async (_, act) => {
    clearRecentlyClosedTabsForTest();
    resetLayout([DOC(), terminalTab({ id: "first", terminalSessionId: "sess-first" }), terminalTab({ id: "second", terminalSessionId: "sess-second" })]);
    await settle();
    hostCommand("app.tab.close");
    await vi.waitFor(() => expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["first", "second"]));
    leaf(layout, "pane-test").activeTabId = "second";
    await settle();
    hostCommand("app.tab.close");
    await confirmFocused("Close tab?");
    const answers = answersOfOpenConfirm();

    act();
    await settle();

    expect(Object.keys(layout.nodes)).toEqual(["pane-test"]);
    expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["first", "second"]);
    expect(answers).toEqual([]);
    expect(confirmState.open).toBe(true);

    pressFocused({ key: "Escape", code: "Escape" });
    await settle();
    expect(answers).toEqual([false]);
    expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["first", "second"]);
  });

  // Each dialog with the element its key handler answers on, the one it
  // focuses when it opens. The key is pressed there rather than wherever the
  // focus is: the close prompt is not on the modal stack, which holds the
  // focus inside the other dialogs.
  test.each([
    ["a prompt answered with Enter", () => uiPrompt("Name?", "draft"), ".modal input", "Enter"],
    ["a path prompt answered with Enter", () => uiPathPrompt({ title: "Path?", defaultValue: "notes/b.md", kind: "file", mode: "create" }), ".modal input", "Enter"],
    ["the window's close prompt dismissed with Escape", () => uiCloseConfirm(), '[aria-modal="true"] button.cancel', "Escape"],
  ] as const)("%s leaves the staged draft", async (_, open, at, key) => {
    await twoPanes();
    await enterHybridNav();
    await keys("t");
    const answer: Promise<unknown> = open();
    const target = await vi.waitFor(() => {
      const element = document.querySelector(at);
      expect(element).not.toBeNull();
      return element!;
    });

    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, code: key }));

    await answer;
    await settle();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(paneMode.active).toBe(true);
    expect(kinds(leaf(draft(), "pane-test").tabs)).toEqual(["file", "terminal"]);
  });
});

describe("in a tmux window", () => {
  /// One pane showing tmux pane %0 on session s0, with tmux's layout for it.
  async function tmuxWindow() {
    resetLayout([TMUX_TAB("t0", "s0", "%0")]);
    setTmuxLayout({ kind: "pane", session: "s0", w: 120, h: 40 });
    const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
    await settle();
    return request;
  }

  /// Two panes side by side showing tmux panes %0 and %1, with tmux's layout
  /// for them.
  async function tmuxPair() {
    resetLayout([TMUX_TAB("t0", "s0", "%0")]);
    const right = splitPane("pane-test", "row")!;
    leaf(layout, right).tabs.push(TMUX_TAB("t1", "s1", "%1"));
    leaf(layout, right).activeTabId = "t1";
    layout.activePaneId = "pane-test";
    setTmuxLayout({ kind: "row", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 60, h: 40 },
      { kind: "pane", session: "s1", w: 59, h: 40 },
    ] });
    const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
    await settle();
    return request;
  }

  const WIDEN_LEFT = ["s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 83 }];

  function tmuxLayoutFrame(layout: unknown): void {
    onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "tmux_layout", layout });
  }

  /// What the page asked tmux for, less the focus requests it sends as its
  /// active pane changes.
  function asked(request: { mock: { calls: unknown[][] } }): unknown[][] {
    return request.mock.calls.filter(([, body]) => (body as { request: string }).request !== "focus");
  }

  test("a tmux keyboard resize sends its final cell size on Enter and leaves the layout to tmux", async () => {
    resetLayout([TMUX_TAB("t0", "s0", "%0")]);
    const rightId = splitPane("pane-test", "row")!;
    leaf(layout, rightId).tabs.push(TMUX_TAB("t1", "s1", "%1"));
    leaf(layout, rightId).activeTabId = "t1";
    layout.activePaneId = "pane-test";
    setTmuxLayout({ kind: "row", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 60, h: 40 },
      { kind: "pane", session: "s1", w: 59, h: 40 },
    ] });
    const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
    await settle();
    await enterHybridNav();
    await keys("]");
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.52);
    await keys("Enter");
    expect(request).toHaveBeenCalledWith("s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 62 });
    expect(request.mock.calls.filter(([, body]) => body.request === "resize-pane")).toHaveLength(1);
    expect(rootSplit(layout).ratio).toBeCloseTo(0.5);
    await enterHybridNav();
    await keys(...Array(30).fill("]"));
    expect(rootSplit(draft()).ratio).toBe(1);
    await keys("Enter");
    expect(request).toHaveBeenCalledWith("s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 119 });
    expect(rootSplit(layout).ratio).toBeCloseTo(0.5);
  });

  test("a split stages an empty pane, and Enter asks tmux for it and leaves the layout to tmux", async () => {
    const request = await tmuxWindow();
    await enterHybridNav();
    await keys("/");
    const staged = draft().activePaneId;
    expect(rootSplit(draft()).direction).toBe("row");
    expect(leaf(draft(), staged).tabs).toEqual([]);
    expect(asked(request)).toEqual([]);

    await keys("Enter");

    expect(asked(request)).toEqual([["s0", { request: "split", pane: "%0", horizontal: true }]]);
    expect(layout.nodes[layout.rootId]?.kind).toBe("leaf");
    expect(layout.activePaneId).toBe("pane-test");
  });

  test("Escape drops a staged split without asking tmux", async () => {
    const request = await tmuxWindow();
    await enterHybridNav();
    await keys("?", "Escape");

    expect(paneMode.active).toBe(false);
    expect(asked(request)).toEqual([]);
  });

  test("Enter sends the divider moves first, then the splits in the order staged", async () => {
    resetLayout([TMUX_TAB("t0", "s0", "%0")]);
    const right = splitPane("pane-test", "row")!;
    leaf(layout, right).tabs.push(TMUX_TAB("t1", "s1", "%1"));
    leaf(layout, right).activeTabId = "t1";
    layout.activePaneId = "pane-test";
    setTmuxLayout({ kind: "row", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 60, h: 40 },
      { kind: "pane", session: "s1", w: 59, h: 40 },
    ] });
    const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
    await settle();
    await enterHybridNav();

    await keys("?", "ArrowRight", "]", "/", "Enter");

    expect(asked(request)).toEqual([
      ["s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 62 }],
      ["s0", { request: "split", pane: "%0", horizontal: false }],
      ["s1", { request: "split", pane: "%1", horizontal: true }],
    ]);
  });

  test("a divider drag stages its pane resize for Enter, and the window size waits no longer than the mode", async () => {
    const request = await tmuxPair();
    await enterHybridNav();

    await dragDivider(700);
    expect(rootSplit(draft()).ratio).toBeCloseTo(0.7);
    expect(asked(request)).toEqual([]);
    await keys("Enter");

    expect(asked(request)).toEqual([WIDEN_LEFT]);
    expect(rootSplit(layout).ratio).toBe(0.5);
    expect(tmuxWindowSizeHeld()).toBe(false);
  });

  test("Escape drops a divider drag without asking tmux, and a drag after the mode asks at once", async () => {
    const request = await tmuxPair();
    await enterHybridNav();
    await dragDivider(700);

    await keys("Escape");
    expect(asked(request)).toEqual([]);
    expect(rootSplit(layout).ratio).toBe(0.5);
    expect(tmuxWindowSizeHeld()).toBe(false);

    await dragDivider(700);
    expect(asked(request)).toEqual([WIDEN_LEFT]);
  });

  test("a staged split's divider refuses a drag", async () => {
    const request = await tmuxWindow();
    await enterHybridNav();
    await keys("/");

    expect(await dragDivider(700)).toBe(false);
    expect(rootSplit(draft()).ratio).toBe(0.5);
    await keys("Enter");

    expect(asked(request)).toEqual([["s0", { request: "split", pane: "%0", horizontal: true }]]);
  });

  test("a divider whose split the live tree lost refuses a drag, as it refuses the keys", async () => {
    const request = await tmuxPair();
    await enterHybridNav();
    // Another client lays the panes out in a column and back: the live tree
    // rebuilds its root split, and tmux's row places the draft's again.
    tmuxLayoutFrame({ kind: "column", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 120, h: 20 },
      { kind: "pane", session: "s1", w: 120, h: 19 },
    ] });
    tmuxLayoutFrame({ kind: "row", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 60, h: 40 },
      { kind: "pane", session: "s1", w: 59, h: 40 },
    ] });
    await settle();
    expect(layout.nodes[rootSplit(draft()).id]).toBeUndefined();

    expect(await dragDivider(700)).toBe(false);
    await keys("]", "Enter");

    expect(asked(request)).toEqual([]);
  });

  test("a staged pane takes no split or divider move, and nothing stages a tab, swaps tiles or flips a side", async () => {
    const request = await tmuxWindow();
    await enterHybridNav();
    await keys("/");
    const staged = draft().activePaneId;

    await keys("?", "]");
    expect(Object.values(draft().nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
    expect(rootSplit(draft()).ratio).toBe(0.5);
    await keys("t", "Tab");
    expect(leaf(draft(), staged).tabs).toEqual([]);
    expect(leaf(draft(), staged).side).toBeUndefined();
    await keys("ArrowLeft", "d");
    expect(leaf(draft(), "pane-test").tabs.map((tab) => tab.id)).toEqual(["t0"]);
    expect(leaf(draft(), "pane-test").side).toBeUndefined();

    await keys("Enter");
    expect(asked(request)).toEqual([["s0", { request: "split", pane: "%0", horizontal: true }]]);
  });

  test("b stages no Dashboard, in a window with no workspace too", async () => {
    Object.assign(caps, { workspace: false, files: false, drafts: false });
    ui.terminalOnly = true;
    try {
      const request = await tmuxWindow();
      await enterHybridNav();

      await keys("b");
      expect(leaf(draft(), "pane-test").tabs.map((tab) => tab.id)).toEqual(["t0"]);

      await keys("Enter");
      expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["t0"]);
      expect(asked(request)).toEqual([]);
    } finally {
      ui.terminalOnly = false;
    }
  });

  test("tmux's layout and a rename during the transaction apply without making it stale", async () => {
    const request = await tmuxWindow();
    await enterHybridNav();
    await keys("/");

    tmuxLayoutFrame({ kind: "column", w: 120, h: 40, children: [
      { kind: "pane", session: "s0", w: 120, h: 20 },
      { kind: "pane", session: "s2", w: 120, h: 19 },
    ] });
    applyTerminalRoster([{ id: "s0", tab_name: "vim", tab_group: "default", window_id: sessionWindowId(), broadcast: false }]);
    await settle();

    expect(paneMode.stale).toBe(false);
    expect(rootSplit(layout).direction).toBe("column");
    expect(rootSplit(draft()).direction).toBe("row");
    await keys("Enter");
    expect(asked(request)).toEqual([["s0", { request: "split", pane: "%0", horizontal: true }]]);
    expect(rootSplit(layout).direction).toBe("column");
    expect(allTerminalTabs().find((tab) => tab.id === "t0")?.title).toBe("vim");
  });

  test("a pane has no sides: the flip chord, the flip command and send-to-side leave it alone", async () => {
    await tmuxWindow();
    press({ key: "`", code: "Backquote", ctrlKey: true });
    hostCommand("app.pane.flip");
    await settle();

    expect(moveActiveTabToSide("b")).toBe(false);
    expect(leaf(layout, "pane-test").side).toBeUndefined();
    expect(leaf(layout, "pane-test").tabs.map((tab) => tab.id)).toEqual(["t0"]);
    const offered = availableCommands(commandContext()).map((command) => command.id);
    for (const id of ["app.pane.flip", "app.tab.sendToA", "app.tab.sendToB"]) expect(offered).not.toContain(id);
  });
});
