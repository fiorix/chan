// @vitest-environment jsdom
//
// The window tab bar: the tree button draws the window's pane layout with
// the active pane filled and badges a program status the bar does not show,
// and toggles the pane tree; the bar offers its slot for the active pane's
// strip, keeps its insets clear for the window controls, centres its row on
// them, and on the desktop marks its empty stretches as the window's drag
// space. Where the desktop asks for it the right inset holds the window's
// minimize, maximize or restore, and close buttons, which drive the window
// and never drag it. While the window's Computers launcher covers the page,
// the band shows neither the tree button nor the strip, and where the
// desktop lists menus (Windows, whose frameless window wears no menubar) it
// draws them at its left, each popping up the desktop's menu under it, with
// the window's title after them. A tmux pane has no strip, so while one is
// active the bar names it as the pane tree does and marks the window with a
// tmux badge at its right end, both display only.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const tree = vi.hoisted(() => ({ status: null as "working" | "done" | "blocked" | "error" | null }));

vi.mock("../state/paneTree.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/paneTree.svelte")>()),
  hiddenTabStatus: () => tree.status,
}));

import WindowTabBar from "./WindowTabBar.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/focusGuard";
import {
  closePaneTree,
  PANE_TREE_ANCHOR_ATTR,
  paneTree,
  paneTreeModel,
  openPaneTree,
} from "../state/paneTree.svelte";
import {
  applyTerminalRoster,
  cancelPaneMode,
  enterPaneMode,
  layout,
  paneModeMoveFocus,
  paneModeSplit,
  setActivePane,
} from "../state/tabs.svelte";
import {
  NO_TITLEBAR_CHROME,
  WINDOW_TAB_BAR_MIN_HEIGHT,
  windowTabBar,
} from "../state/windowTabBar.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  tree.status = null;
  closePaneTree();
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  windowTabBar.slot = null;
  windowTabBar.title = "";
  delete (window as W).__TAURI_INTERNALS__;
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  document.body.innerHTML = "";
  cancelPaneMode();
  applyTerminalRoster([]);
  resetLayout();
  vi.restoreAllMocks();
});

async function renderBar(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(WindowTabBar, { target }) as Record<string, unknown>;
  await tick();
  const bar = target.querySelector<HTMLElement>(".window-tab-bar");
  if (!bar) throw new Error("no bar");
  return bar;
}

function threePanes(): void {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "left", b: "stack" },
    stack: { kind: "split", id: "stack", direction: "column", ratio: 0.5, a: "top", b: "bottom" },
    left: { kind: "leaf", id: "left", tabs: [], activeTabId: null },
    top: { kind: "leaf", id: "top", tabs: [], activeTabId: null },
    bottom: { kind: "leaf", id: "bottom", tabs: [], activeTabId: null },
  };
  layout.rootId = "root";
  layout.activePaneId = "left";
}

function minis(bar: HTMLElement): SVGRectElement[] {
  return [...bar.querySelectorAll<SVGRectElement>(".tree-button rect")];
}

describe("the tree button", () => {
  test("draws one tile per pane, laid out as the panes are, with the active one filled", async () => {
    threePanes();
    const bar = await renderBar();
    const tiles = minis(bar);
    expect(tiles.map((t) => t.dataset.paneId).sort()).toEqual(["bottom", "left", "top"]);
    const at = (id: string) => tiles.find((t) => t.dataset.paneId === id)!;
    expect(Number(at("left").getAttribute("x"))).toBeLessThan(Number(at("top").getAttribute("x")));
    expect(Number(at("top").getAttribute("y"))).toBeLessThan(Number(at("bottom").getAttribute("y")));
    expect(tiles.filter((t) => t.classList.contains("active")).map((t) => t.dataset.paneId)).toEqual(["left"]);

    setActivePane("bottom");
    await tick();
    expect(minis(bar).filter((t) => t.classList.contains("active")).map((t) => t.dataset.paneId)).toEqual(["bottom"]);
  });

  test("toggles the pane tree, which hangs under it", async () => {
    const bar = await renderBar();
    const button = bar.querySelector<HTMLButtonElement>(".tree-button")!;
    expect(button.hasAttribute(PANE_TREE_ANCHOR_ATTR)).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.click();
    await tick();
    expect(paneTree.open).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    await tick();
    expect(paneTree.open).toBe(false);
  });

  test("badges a program status on a tab the bar does not show", async () => {
    let bar = await renderBar();
    expect(bar.querySelector(".badge")).toBeNull();
    if (component) await unmount(component);
    document.body.innerHTML = "";

    tree.status = "blocked";
    bar = await renderBar();
    expect(bar.querySelector(".badge")?.getAttribute("data-status")).toBe("blocked");
    expect(bar.querySelector(".tree-button")?.getAttribute("aria-label")).toContain("blocked");
  });
});

describe("under the Computers launcher", () => {
  /// The desktop's mark lands as a mutation, which the bar reads after it.
  async function marked(on: boolean): Promise<void> {
    if (on) document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    else document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  test("a window whose controls the bar draws shows its title at the left, clear of the controls, only while covered", async () => {
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true };
    windowTabBar.title = "Work Window 2";
    const bar = await renderBar();
    expect(bar.querySelector(".window-title"), "no title over the tabs").toBeNull();

    await marked(true);
    const title = bar.querySelector<HTMLElement>(".window-title");
    expect(title?.textContent?.trim()).toBe("Work Window 2");
    expect(bar.querySelector<HTMLElement>(".covered-band")?.style.right).toBe("146px");
    expect(title?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(bar.querySelector(".window-menu"), "a desktop that lists no menus").toBeNull();

    windowTabBar.title = "Work Window 2 [deploy]";
    await tick();
    expect(bar.querySelector(".window-title")?.textContent?.trim(), "a rename shows").toBe("Work Window 2 [deploy]");

    await marked(false);
    expect(bar.querySelector(".window-title")).toBeNull();
  });

  test("a window with native controls leaves its title to the desktop", async () => {
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78, controlsCenterY: 14 };
    windowTabBar.title = "Work Window 2";
    const bar = await renderBar();
    await marked(true);
    expect(bar.querySelector(".window-title")).toBeNull();
  });

  describe("the menus a window without a menubar draws", () => {
    const MENUS = [
      { id: "chan-file-submenu", label: "File" },
      { id: "chan-edit-submenu", label: "Edit" },
      { id: "chan-view-submenu", label: "View" },
    ];
    /// What a Windows desktop reports in the mode.
    const WINDOWS_CHROME = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true, menus: MENUS };

    const invokes: Array<{ cmd: string; args?: unknown }> = [];
    let settle: Array<(error?: Error) => void> = [];

    /// A chan-desktop webview whose popups stay up until the test settles
    /// them, as the desktop answers only once the menu has closed.
    function asDesktop(): void {
      invokes.length = 0;
      settle = [];
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        value: {
          invoke: (cmd: string, args?: unknown) => {
            invokes.push({ cmd, args });
            return new Promise((resolve, reject) => {
              settle.push((error) => (error ? reject(error) : resolve(null)));
            });
          },
        },
      });
    }

    function menuButtons(bar: HTMLElement): HTMLButtonElement[] {
      return [...bar.querySelectorAll<HTMLButtonElement>(".window-menu")];
    }

    function press(target: Element, button = 0): MouseEvent {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button, detail: 1 });
      target.dispatchEvent(event);
      return event;
    }

    /// Place `button` in the page as the bar would lay it out.
    function at(button: HTMLElement, left: number, bottom: number): void {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
        new DOMRect(left, bottom - 28, 40, 28),
      );
    }

    test("are drawn only while covered, in the desktop's order and words", async () => {
      windowTabBar.chrome = WINDOWS_CHROME;
      const bar = await renderBar();
      expect(menuButtons(bar), "the tabs own the band").toEqual([]);

      await marked(true);
      expect(menuButtons(bar).map((b) => b.textContent?.trim())).toEqual(["File", "Edit", "View"]);
      expect(menuButtons(bar).map((b) => b.dataset.menu)).toEqual(MENUS.map((m) => m.id));
      for (const button of menuButtons(bar)) {
        expect(button.tabIndex, "the launcher holds the keyboard").toBe(-1);
        expect(button.getAttribute("aria-haspopup")).toBe("menu");
        expect(button.getAttribute("aria-expanded")).toBe("false");
      }

      windowTabBar.chrome = { ...WINDOWS_CHROME, menus: [{ id: "chan-edit-submenu", label: "Bearbeiten" }] };
      flushSync();
      expect(menuButtons(bar).map((b) => b.textContent?.trim()), "the labels are the desktop's").toEqual([
        "Bearbeiten",
      ]);

      windowTabBar.chrome = { ...WINDOWS_CHROME, menus: [] };
      flushSync();
      expect(menuButtons(bar), "a window wearing a menubar lists none").toEqual([]);

      windowTabBar.chrome = WINDOWS_CHROME;
      await marked(false);
      expect(menuButtons(bar)).toEqual([]);
    });

    test("come before the window's title, all clear of the window controls", async () => {
      windowTabBar.chrome = WINDOWS_CHROME;
      windowTabBar.title = "Work Window 2";
      const bar = await renderBar();
      await marked(true);
      const band = bar.querySelector<HTMLElement>(".covered-band")!;
      expect(band.style.right).toBe("146px");
      const title = band.querySelector<HTMLElement>(".window-title")!;
      expect(title.textContent?.trim()).toBe("Work Window 2");
      for (const button of menuButtons(bar)) {
        expect(button.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(band.querySelector(".window-controls"), "the controls are not in the band").toBeNull();
    });

    test("a press pops the desktop's menu up under its button, held pressed until the menu closes", async () => {
      asDesktop();
      windowTabBar.chrome = WINDOWS_CHROME;
      const bar = await renderBar();
      await marked(true);
      const [file, edit] = menuButtons(bar);
      at(edit!, 52, 34);
      at(file!, 10, 34);

      press(edit!);
      await vi.waitFor(() => expect(invokes).toHaveLength(1));
      expect(invokes[0]).toEqual({ cmd: "titlebar_menu_popup", args: { menu: "chan-edit-submenu", x: 52, y: 34 } });
      flushSync();
      expect(edit!.classList.contains("open")).toBe(true);
      expect(edit!.getAttribute("aria-expanded")).toBe("true");

      press(file!);
      await tick();
      expect(invokes, "one menu at a time").toHaveLength(1);

      settle[0]!();
      await vi.waitFor(() => expect(edit!.classList.contains("open")).toBe(false));
      expect(edit!.getAttribute("aria-expanded")).toBe("false");

      press(file!);
      await vi.waitFor(() => expect(invokes).toHaveLength(2));
      expect(invokes[1]).toEqual({ cmd: "titlebar_menu_popup", args: { menu: "chan-file-submenu", x: 10, y: 34 } });
    });

    test("a refused popup is logged and lets the button go", async () => {
      asDesktop();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      windowTabBar.chrome = WINDOWS_CHROME;
      const bar = await renderBar();
      await marked(true);
      const view = menuButtons(bar)[2]!;
      press(view);
      await vi.waitFor(() => expect(settle).toHaveLength(1));
      settle[0]!(new Error("Command titlebar_menu_popup not allowed by ACL"));
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(String(warn.mock.calls[0]?.[1])).toContain("not allowed by ACL");
      await vi.waitFor(() => expect(view.classList.contains("open")).toBe(false));
    });

    test("never drag the window, keep the focus, and open on the primary button only", async () => {
      asDesktop();
      windowTabBar.chrome = WINDOWS_CHROME;
      windowTabBar.title = "Work Window 2";
      const bar = await renderBar();
      await marked(true);
      expect(bar.getAttribute("data-tauri-drag-region"), "the band still drags").toBe("");
      const band = bar.querySelector<HTMLElement>(".covered-band")!;
      expect(band.hasAttribute("data-tauri-drag-region")).toBe(false);
      expect(band.querySelector("[data-tauri-drag-region]")).toBeNull();

      const seen: string[] = [];
      const record = (e: Event) => seen.push(e.type);
      bar.addEventListener("mousedown", record);
      document.addEventListener("mousedown", record);
      try {
        for (const button of menuButtons(bar)) {
          expect(press(button, 2).defaultPrevented, "the press keeps the focus where it is").toBe(true);
        }
      } finally {
        bar.removeEventListener("mousedown", record);
        document.removeEventListener("mousedown", record);
      }
      expect(seen, "neither the bar nor the document's drag handler hears it").toEqual([]);
      await tick();
      expect(invokes, "a secondary press opens nothing").toEqual([]);
    });
  });

  test("hides the tree button and the strip in place, closes the tree, and shows them again after", async () => {
    const bar = await renderBar();
    const button = bar.querySelector<HTMLElement>(".tree-button")!;
    const slot = bar.querySelector<HTMLElement>(".slot")!;
    openPaneTree();
    await tick();
    expect(paneTree.open).toBe(true);

    await marked(true);
    expect(button.classList.contains("covered")).toBe(true);
    expect(slot.classList.contains("covered")).toBe(true);
    expect(paneTree.open, "an open tree closes").toBe(false);
    expect(windowTabBar.slot, "the strip keeps its slot").toBe(slot);

    await marked(false);
    expect(button.classList.contains("covered")).toBe(false);
    expect(slot.classList.contains("covered")).toBe(false);
  });

  test("a bar mounted under a shown launcher starts hidden", async () => {
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    const bar = await renderBar();
    expect(bar.querySelector(".tree-button")?.classList.contains("covered")).toBe(true);
    expect(bar.querySelector(".slot")?.classList.contains("covered")).toBe(true);
  });
});

describe("the bar", () => {
  test("offers its slot while mounted", async () => {
    const bar = await renderBar();
    expect(windowTabBar.slot).toBe(bar.querySelector(".slot"));
    if (component) await unmount(component);
    component = null;
    expect(windowTabBar.slot).toBeNull();
  });

  test("keeps its insets clear and centres its row on the window controls", async () => {
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78, controlsCenterY: 16 };
    windowTabBar.height = 34;
    const bar = await renderBar();
    const [left, right] = [...bar.querySelectorAll<HTMLElement>(".inset")];
    expect(left?.style.width).toBe("78px");
    expect(right?.style.width).toBe("0px");
    expect(bar.style.height).toBe("34px");
    expect(bar.style.paddingBottom, "the 32px row above the pad centres on y=16").toBe("2px");

    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, fullscreen: true };
    await tick();
    expect(left?.style.width).toBe("0px");
    expect(bar.style.paddingBottom).toBe("0px");
  });

  test("on the desktop its empty stretches drag the window and its button does not", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async () => null } });
    const bar = await renderBar();
    expect(bar.getAttribute("data-tauri-drag-region")).toBe("");
    for (const part of bar.querySelectorAll(".inset, .slot")) {
      expect(part.getAttribute("data-tauri-drag-region")).toBe("");
    }
    expect(bar.querySelector(".tree-button")?.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  test("in a browser nothing is marked for dragging", async () => {
    const bar = await renderBar();
    expect(bar.querySelector("[data-tauri-drag-region]")).toBeNull();
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(false);
  });
});

describe("the window controls", () => {
  /// What a Windows desktop reports in the mode.
  const WINDOWS_CHROME = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true };

  const invokes: Array<{ cmd: string; args?: unknown }> = [];

  /// A chan-desktop webview whose `titlebar_window_control` answers `answer`.
  function asDesktop(answer: () => unknown = () => null): void {
    invokes.length = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (cmd: string, args?: unknown) => {
          invokes.push({ cmd, args });
          return answer();
        },
      },
    });
  }

  /// The window controls' layer, which the bar draws after itself.
  function layer(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".window-controls");
  }

  function controls(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".window-control")];
  }

  test("are drawn only when the desktop asks for them, and the right inset stays an empty spacer otherwise", async () => {
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78, controlsCenterY: 14 };
    const bar = await renderBar();
    expect(controls(), "macOS draws its own").toEqual([]);
    const right = [...bar.querySelectorAll<HTMLElement>(".inset")].at(-1)!;
    expect(right.children).toHaveLength(0);

    windowTabBar.chrome = WINDOWS_CHROME;
    flushSync();
    expect(controls()).toHaveLength(3);

    windowTabBar.chrome = { ...WINDOWS_CHROME, insetRight: 0, drawControls: false, fullscreen: true };
    flushSync();
    expect(controls(), "fullscreen draws none").toEqual([]);
    expect([...bar.querySelectorAll<HTMLElement>(".inset")].at(-1)?.style.width).toBe("0px");
  });

  test("fill the right inset as three equal buttons: minimize, maximize, close", async () => {
    windowTabBar.chrome = WINDOWS_CHROME;
    await renderBar();
    const inset = layer()!;
    expect(inset.style.width).toBe("138px");
    expect([...inset.children]).toEqual(controls());
    expect(controls().map((b) => b.dataset.action)).toEqual(["minimize", "toggleMaximize", "close"]);
    expect(controls().map((b) => b.getAttribute("aria-label"))).toEqual(["Minimize", "Maximize", "Close"]);
    expect(controls().map((b) => b.title)).toEqual(["Minimize", "Maximize", "Close"]);
    for (const button of controls()) {
      expect(button.style.width, "each takes an equal share").toBe("46px");
      expect(button.querySelector("svg"), "an inline glyph").not.toBeNull();
      expect(button.tabIndex, "out of the tab order").toBe(-1);
    }
  });

  test("sit in a layer of their own above every overlay, the bar keeping their room clear", async () => {
    asDesktop();
    windowTabBar.chrome = WINDOWS_CHROME;
    const bar = await renderBar();
    expect(bar.getAttribute("data-tauri-drag-region"), "the bar drags the window").toBe("");
    const controlsLayer = layer()!;
    expect(bar.contains(controlsLayer), "outside the bar's stacking context").toBe(false);
    // The highest full-window overlays, the missing-token and preflight pages,
    // stack at 40000.
    expect(Number(controlsLayer.style.zIndex)).toBeGreaterThan(40000);
    expect(controlsLayer.style.width).toBe("138px");
    expect(controlsLayer.style.height, "the bar's full height").toBe(`${windowTabBar.height}px`);
    const room = bar.lastElementChild as HTMLElement;
    expect(room.classList.contains("inset"), "the bar ends in the controls' room").toBe(true);
    expect(room.style.width).toBe("138px");
    expect(room.children).toHaveLength(0);
    expect(room.hasAttribute("data-tauri-drag-region"), "nothing under the controls drags").toBe(false);

    windowTabBar.chrome = { ...WINDOWS_CHROME, insetRight: 0, drawControls: false, fullscreen: true };
    flushSync();
    expect(layer(), "no controls, no layer").toBeNull();
  });

  test("the middle button maximizes or restores as the window is", async () => {
    windowTabBar.chrome = WINDOWS_CHROME;
    await renderBar();
    const middle = () => controls()[1]!;
    expect(middle().getAttribute("aria-label")).toBe("Maximize");
    expect(middle().title).toBe("Maximize");
    expect(middle().querySelector("svg")?.getAttribute("data-glyph")).toBe("maximize");

    windowTabBar.chrome = { ...WINDOWS_CHROME, maximized: true };
    flushSync();
    expect(middle().getAttribute("aria-label")).toBe("Restore");
    expect(middle().title).toBe("Restore");
    expect(middle().querySelector("svg")?.getAttribute("data-glyph")).toBe("restore");
  });

  test("each button asks the desktop for its own action", async () => {
    asDesktop();
    windowTabBar.chrome = WINDOWS_CHROME;
    await renderBar();
    for (const button of controls()) button.click();
    await vi.waitFor(() => expect(invokes).toHaveLength(3));
    expect(invokes).toEqual([
      { cmd: "titlebar_window_control", args: { action: "minimize" } },
      { cmd: "titlebar_window_control", args: { action: "toggleMaximize" } },
      { cmd: "titlebar_window_control", args: { action: "close" } },
    ]);
  });

  test("a refused action is logged, not thrown", async () => {
    asDesktop(() => {
      throw new Error("Command titlebar_window_control not allowed by ACL");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    windowTabBar.chrome = WINDOWS_CHROME;
    await renderBar();
    controls()[2]!.click();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[1])).toContain("not allowed by ACL");
  });

  test("never drag the window: no drag attribute, and a press goes no further than the button", async () => {
    asDesktop();
    windowTabBar.chrome = WINDOWS_CHROME;
    const bar = await renderBar();
    expect(bar.getAttribute("data-tauri-drag-region"), "the bar still drags").toBe("");
    const inset = layer()!;
    expect(inset.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(inset.querySelector("[data-tauri-drag-region]")).toBeNull();

    const seen: string[] = [];
    const record = (e: Event) => seen.push(e.type);
    bar.addEventListener("mousedown", record);
    document.addEventListener("mousedown", record);
    try {
      for (const button of controls()) {
        const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 });
        button.querySelector("svg")!.dispatchEvent(press);
        expect(press.defaultPrevented, "the press keeps the focus where it is").toBe(true);
      }
    } finally {
      bar.removeEventListener("mousedown", record);
      document.removeEventListener("mousedown", record);
    }
    expect(seen, "neither the bar nor the document's drag handler hears it").toEqual([]);
  });
});

describe("a tmux window", () => {
  /// Two tmux panes side by side, as the server's tmux_layout lays them
  /// out: each pane one terminal tab marked with its tmux pane, named after
  /// the tmux window. The left one is active.
  function tmuxPanes(left = "editor", right = "logs"): void {
    const tab = (id: string, title: string, session: string, pane: string) =>
      terminalTab({ id, title, terminalSessionId: session, tmuxPane: { connection: 1, pane } });
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "left", b: "right" },
      left: { kind: "leaf", id: "left", tabs: [tab("t0", left, "s0", "%0")], activeTabId: "t0" },
      right: { kind: "leaf", id: "right", tabs: [tab("t1", right, "s1", "%1")], activeTabId: "t1" },
    };
    layout.rootId = "root";
    layout.activePaneId = "left";
  }

  function nameOf(bar: HTMLElement): string | null {
    return bar.querySelector(".tmux-name")?.textContent?.trim() ?? null;
  }

  /// The label the pane tree gives the window's active pane.
  function paneTreeLabel(): string | undefined {
    return paneTreeModel(layout).find((pane) => pane.active)?.label;
  }

  /// The bar's parts in order, by their first class.
  function parts(bar: HTMLElement): string[] {
    return [...bar.children].map((part) => part.classList[0] ?? "");
  }

  test("names the active pane where the strip would sit, and badges the window at the right end", async () => {
    tmuxPanes();
    const bar = await renderBar();
    expect(nameOf(bar)).toBe("editor");
    expect(nameOf(bar), "the pane tree's label for the pane").toBe(paneTreeLabel());
    expect(bar.querySelector(".tmux-badge")?.textContent?.trim()).toBe("tmux");
    expect(parts(bar)).toEqual(["inset", "tree-button", "tmux-name", "slot", "tmux-badge", "inset"]);
  });

  test("follows a change of active pane and a tmux rename at once", async () => {
    tmuxPanes();
    const bar = await renderBar();

    setActivePane("right");
    await tick();
    expect(nameOf(bar)).toBe("logs");

    // A tmux rename reaches the page as the session's new name in the roster.
    applyTerminalRoster([{ id: "s1", tab_name: "build", tab_group: "default", window_id: null, broadcast: false }]);
    await tick();
    expect(nameOf(bar)).toBe("build");
    expect(nameOf(bar)).toBe(paneTreeLabel());
    expect(bar.querySelectorAll(".tmux-badge")).toHaveLength(1);
  });

  test("an unnamed tmux window reads as the pane tree reads it", async () => {
    tmuxPanes("", "logs");
    const bar = await renderBar();
    expect(nameOf(bar)).toBe("Terminal");
    expect(nameOf(bar)).toBe(paneTreeLabel());
  });

  test("a tmux pane with no active tab reads as the pane tree reads it", async () => {
    tmuxPanes();
    const left = layout.nodes.left;
    if (left?.kind !== "leaf") throw new Error("fixture: the left pane is a leaf");
    left.activeTabId = null;
    const bar = await renderBar();
    expect(nameOf(bar)).toBe("Empty pane");
    expect(nameOf(bar)).toBe(paneTreeLabel());
    expect(bar.querySelector(".tmux-badge")).not.toBeNull();
  });

  test("the name carries its whole text as a tooltip, and the badge says what it marks", async () => {
    tmuxPanes("a tmux window whose name is far too long for the band");
    const bar = await renderBar();
    expect(bar.querySelector(".tmux-name")?.getAttribute("title")).toBe("a tmux window whose name is far too long for the band");
    expect(bar.querySelector(".tmux-badge")?.getAttribute("title")).toBe("tmux window");
  });

  test("Hybrid Nav's staged focus moves the name, and a staged pane reads as the mode names it", async () => {
    tmuxPanes();
    const bar = await renderBar();
    enterPaneMode();
    await tick();

    paneModeMoveFocus("right");
    await tick();
    expect(nameOf(bar)).toBe("logs");
    expect(layout.activePaneId, "the live layout's focus is untouched").toBe("left");

    paneModeSplit("column");
    await tick();
    expect(nameOf(bar)).toBe("New tmux pane");
    expect(bar.querySelector(".tmux-badge")).not.toBeNull();
  });

  test("the name and the badge are display only, and on the desktop drag the window", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async () => null } });
    tmuxPanes();
    const bar = await renderBar();
    const shown = [...bar.querySelectorAll<HTMLElement>(".tmux-name, .tmux-badge")];
    expect(shown).toHaveLength(2);
    for (const part of shown) {
      expect(part.getAttribute("data-tauri-drag-region"), part.className).toBe("");
      expect(part.querySelector("*"), "a press lands on the part itself").toBeNull();
      expect(part.closest("button, [role], [tabindex]"), "nothing to press or focus").toBeNull();
      part.click();
    }
    await tick();
    expect(paneTree.open, "a press opens nothing").toBe(false);
    expect(layout.activePaneId).toBe("left");
  });

  test("hides with the tree button while the Computers launcher covers the window", async () => {
    tmuxPanes();
    const bar = await renderBar();
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(bar.querySelector(".tmux-name")?.classList.contains("covered")).toBe(true);
    expect(bar.querySelector(".tmux-badge")?.classList.contains("covered")).toBe(true);
  });

  test("a window without tmux shows neither", async () => {
    resetLayout([terminalTab({ id: "plain", title: "shell", terminalSessionId: "s9" })]);
    const bar = await renderBar();
    expect(bar.querySelector(".tmux-name, .tmux-badge")).toBeNull();
    expect(parts(bar)).toEqual(["inset", "tree-button", "slot", "inset"]);
  });
});
