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
// tmux badge at its right end, both display only. The bar shows the window's
// title, display only: after the tree button while the window has no tabs,
// and at the bar's end, left of the strip's actions, once it has one.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const tree = vi.hoisted(() => ({ status: null as "working" | "done" | "blocked" | "error" | null }));

vi.mock("../state/paneTree.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/paneTree.svelte")>()),
  hiddenTabStatus: () => tree.status,
}));
vi.mock("../api/libraryCommand", () => ({ loadScopedLibrarySnapshot: vi.fn() }));

import WindowTabBar from "./WindowTabBar.svelte";
import { expectWords } from "../__tests__/menuWords";
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
  WINDOW_TITLE_READ_RETRIES,
  WINDOW_TITLE_READ_RETRY_MS,
  WINDOW_TITLE_REFERENCE_TAB_PX,
  WINDOW_TITLE_RESERVE_PX,
  WINDOW_TITLE_ROLL,
  WINDOW_TITLE_SLIDE_MS,
  windowTabBar,
} from "../state/windowTabBar.svelte";
import { applyWindowLabel, loadWindowTitle, __resetWindowTitle } from "../state/windowTitle.svelte";
import { privacy } from "@chan/web-shared/privacy";
import { loadScopedLibrarySnapshot, type ScopedLibrarySnapshot } from "../api/libraryCommand";
import { sessionWindowId } from "../api/client";
import { ui } from "../state/store.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };
type Animated = { animate?: unknown };
type MediaWindow = { matchMedia?: unknown };

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  tree.status = null;
  closePaneTree();
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  windowTabBar.slot = null;
  windowTabBar.titleSlot = null;
  windowTabBar.title = "";
  windowTabBar.available = false;
  privacy.enabled = false;
  ui.ws = "connecting";
  vi.useRealTimers();
  __resetWindowTitle();
  vi.mocked(loadScopedLibrarySnapshot).mockReset();
  delete (HTMLElement.prototype as Animated).animate;
  delete (window as MediaWindow).matchMedia;
  delete (window as W).__TAURI_INTERNALS__;
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  document.body.innerHTML = "";
  cancelPaneMode();
  applyTerminalRoster([]);
  resetLayout();
  vi.restoreAllMocks();
});

async function renderBar(props: { restored?: boolean } = {}): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(WindowTabBar, { target, props }) as Record<string, unknown>;
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

  test("is named by its command, with the command's chord in its tooltip", async () => {
    const bar = await renderBar();
    const button = bar.querySelector<HTMLButtonElement>(".tree-button")!;
    expectWords([button.getAttribute("aria-label")!], [{ command: "app.pane.tree" }]);
    expect(button.title).toBe("Show panes and tabs (Ctrl+Shift+A)");
  });

  test("badges a program status on a tab the bar does not show", async () => {
    let bar = await renderBar();
    expect(bar.querySelector(".badge")).toBeNull();
    if (component) await unmount(component);
    document.body.innerHTML = "";

    tree.status = "blocked";
    bar = await renderBar();
    expect(bar.querySelector(".badge")?.getAttribute("data-status")).toBe("blocked");
    expect(bar.querySelector(".tree-button")?.getAttribute("aria-label")).toBe(
      "Show panes and tabs: a tab out of view is blocked",
    );
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

  test("the covered title is the bar's own, so privacy mode masks it before the desktop's mask arrives", async () => {
    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue({
      library_id: "local",
      workspaces: [],
      windows: [{
        window_id: sessionWindowId(), kind: "workspace", ordinal: 2,
        label: "deploy", title: "", control: false, tmux: false, workspace_path: "/work",
        connected: true, hidden: false, launch_path: "/",
      }],
    });
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetRight: 138, drawControls: true };
    windowTabBar.title = "\u2197 geekom / work Window 2 [deploy]";
    const bar = await renderBar();
    await marked(true);
    const covered = (): string | undefined => bar.querySelector(".window-title")?.textContent?.trim();
    expect(covered()).toBe("\u2197 geekom / work Window 2 [deploy]");

    // The page hears privacy mode turn on while it still holds the full title.
    privacy.enabled = true;
    await tick();
    expect(covered() ?? "", "the full title is gone at once").not.toContain("geekom");
    await vi.waitFor(() => expect(covered()).toBe("Window 2"));
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

describe("the window's title", () => {
  const LOCAL = "\u2193\uFE0E local / chan Window 1 [my own title]";
  const REMOTE = "\u2197 geekom / chan Window 1 [label]";

  function titleBox(): HTMLElement {
    const box = document.querySelector<HTMLElement>(".bar-title");
    if (!box) throw new Error("no title");
    return box;
  }

  function shown(): string | null {
    const box = titleBox();
    return box.hidden ? null : (box.textContent?.trim() ?? "");
  }

  /// What a strip in the bar offers the title: a place between its dead zone
  /// and its actions (Pane.svelte renders the real one).
  function stripWithTitleSlot(host: Element): HTMLElement {
    const strip = document.createElement("div");
    strip.innerHTML = '<div class="dead-zone"></div><div class="place"></div><div class="actions"></div>';
    host.append(strip);
    const place = strip.querySelector<HTMLElement>(".place")!;
    windowTabBar.titleSlot = place;
    return place;
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

  test("with no tab in the window it sits after the tree button, whole as a tooltip", async () => {
    windowTabBar.title = LOCAL;
    const bar = await renderBar();
    const box = titleBox();
    expect(box.parentElement).toBe(bar);
    expect(box.previousElementSibling).toBe(bar.querySelector(".tree-button"));
    expect(box.dataset.place).toBe("start");
    expect(shown()).toBe(LOCAL);
    expect(box.getAttribute("title")).toBe(LOCAL);
    expect(bar.querySelector(".slot")?.classList.contains("beside-title"), "the strip keeps its actions' room").toBe(true);

    windowTabBar.title = REMOTE;
    await tick();
    expect(shown(), "a retitle shows").toBe(REMOTE);
    expect(box.getAttribute("title")).toBe(REMOTE);
  });

  test("the first tab sends it to the bar's end, left of the strip's actions, and the last one closing brings it back", async () => {
    windowTabBar.title = LOCAL;
    const bar = await renderBar();
    const place = stripWithTitleSlot(bar.querySelector(".slot")!);
    await tick();
    expect(titleBox().parentElement, "no tabs yet").toBe(bar);

    resetLayout([terminalTab()]);
    await tick();
    const box = titleBox();
    expect(box.parentElement).toBe(place);
    expect(box.dataset.place).toBe("end");
    expect(place.previousElementSibling?.className).toBe("dead-zone");
    expect(place.nextElementSibling?.className).toBe("actions");
    expect(shown()).toBe(LOCAL);
    expect(bar.querySelector(".slot")?.classList.contains("beside-title")).toBe(false);

    resetLayout([]);
    await tick();
    expect(box.parentElement).toBe(bar);
    expect(box.previousElementSibling).toBe(bar.querySelector(".tree-button"));
    expect(box.dataset.place).toBe("start");
  });

  test("a tab on a side the pane does not show counts as a tab", async () => {
    windowTabBar.title = LOCAL;
    resetLayout([], { bTabs: [terminalTab({ id: "b1" })], bActiveTabId: "b1" });
    await renderBar();
    expect(titleBox().dataset.place).toBe("end");
  });

  test("with tabs and no strip in the bar to take it, it sits at the bar's own end", async () => {
    windowTabBar.title = LOCAL;
    resetLayout([terminalTab()]);
    const bar = await renderBar();
    const box = titleBox();
    expect(box.parentElement?.classList.contains("title-end")).toBe(true);
    expect(box.parentElement?.previousElementSibling).toBe(bar.querySelector(".slot"));
  });

  test("slides from one place to the other, and cuts under reduced motion", async () => {
    const animate = vi.fn();
    (HTMLElement.prototype as Animated).animate = animate;
    windowTabBar.title = LOCAL;
    const bar = await renderBar();
    stripWithTitleSlot(bar.querySelector(".slot")!);
    await tick();
    const box = titleBox();
    // jsdom lays nothing out: the title is 40 px in at the start and 600 px
    // in at the end.
    box.getBoundingClientRect = () =>
      ({ left: box.parentElement === bar ? 40 : 600, width: 120 }) as DOMRect;

    resetLayout([terminalTab()]);
    await tick();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]![0]).toEqual([{ transform: "translateX(-560px)" }, { transform: "translateX(0)" }]);
    expect(animate.mock.calls[0]![1]).toMatchObject({ duration: WINDOW_TITLE_SLIDE_MS });

    resetLayout([]);
    await tick();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1]![0]).toEqual([{ transform: "translateX(560px)" }, { transform: "translateX(0)" }]);

    (window as MediaWindow).matchMedia = (query: string) => ({ matches: query.includes("reduce") });
    resetLayout([terminalTab()]);
    await tick();
    expect(box.dataset.place).toBe("end");
    expect(animate, "reduced motion cuts").toHaveBeenCalledTimes(2);
  });

  test("tabs the boot's layout restore brings cut the title to the end, and a tab opened after it slides", async () => {
    const animate = vi.fn();
    (HTMLElement.prototype as Animated).animate = animate;
    windowTabBar.title = LOCAL;
    const target = document.createElement("div");
    document.body.append(target);
    // The prop follows a reactive flag, as the app's own boot flag is; the
    // bar itself reads nothing of the flag borrowed here.
    windowTabBar.available = false;
    const props = {
      get restored() {
        return windowTabBar.available;
      },
    };
    component = mount(WindowTabBar, { target, props }) as Record<string, unknown>;
    await tick();
    const bar = target.querySelector<HTMLElement>(".window-tab-bar")!;
    stripWithTitleSlot(bar.querySelector(".slot")!);
    await tick();
    const box = titleBox();
    box.getBoundingClientRect = () =>
      ({ left: box.parentElement === bar ? 40 : 600, width: 120 }) as DOMRect;

    // The restore lays out the window's tabs, then the boot says so.
    resetLayout([terminalTab()]);
    await tick();
    expect(box.dataset.place).toBe("end");
    windowTabBar.available = true;
    await tick();
    expect(animate, "the restored tabs are not a first tab opening").not.toHaveBeenCalled();

    resetLayout([]);
    await tick();
    resetLayout([terminalTab()]);
    await tick();
    expect(animate, "closing the last tab and opening a first one slide").toHaveBeenCalledTimes(2);
  });

  test("a strip changing under a title that stays at the end does not slide it", async () => {
    const animate = vi.fn();
    (HTMLElement.prototype as Animated).animate = animate;
    windowTabBar.title = LOCAL;
    resetLayout([terminalTab()]);
    const bar = await renderBar();
    const box = titleBox();
    box.getBoundingClientRect = () =>
      ({ left: box.parentElement?.classList.contains("title-end") ? 700 : 600, width: 120 }) as DOMRect;
    const place = stripWithTitleSlot(bar.querySelector(".slot")!);
    await tick();
    expect(box.parentElement).toBe(place);
    expect(animate).not.toHaveBeenCalled();
  });

  test("keeps two reference tabs for it at the end, and marks its place for the layout", async () => {
    expect(WINDOW_TITLE_RESERVE_PX).toBe(2 * WINDOW_TITLE_REFERENCE_TAB_PX + 2);
    windowTabBar.title = LOCAL;
    resetLayout([terminalTab()]);
    const bar = await renderBar();
    expect(bar.style.getPropertyValue("--window-title-reserve")).toBe(`${WINDOW_TITLE_RESERVE_PX}px`);
    expect(titleBox().dataset.place).toBe("end");
  });

  test("a title wider than its room is marked to roll by the width it runs past, and one that fits is not", async () => {
    windowTabBar.title = LOCAL;
    await renderBar();
    const box = titleBox();
    const text = box.querySelector<HTMLElement>(".bar-title-text")!;
    expect(box.dataset.roll).toBe(WINDOW_TITLE_ROLL);
    expect(box.hasAttribute("data-overflow"), "jsdom measures nothing: it fits").toBe(false);
    expect(box.style.getPropertyValue("--window-title-natural"), "and no width is known yet").toBe("");
    expect(box.style.padding).toBe("0px 8px");

    // jsdom lays nothing out: the text is 429.4 px wide in a 250 px box.
    let textWidth = 429.4;
    let boxWidth = 250;
    const run = text.firstElementChild as HTMLElement;
    run.getBoundingClientRect = () => ({ width: textWidth }) as DOMRect;
    Object.defineProperty(text, "clientWidth", { configurable: true, get: () => boxWidth });
    Object.defineProperty(text, "scrollWidth", { configurable: true, get: () => Math.max(boxWidth, Math.round(textWidth)) });
    windowTabBar.title = `${LOCAL} and then some`;
    await tick();
    expect(box.hasAttribute("data-overflow")).toBe(true);
    expect(box.style.getPropertyValue("--window-title-roll-distance")).toBe("-180px");
    // The width that shows the text whole: the text, rounded up, and the
    // box's 8 px padding at each end.
    expect(box.style.getPropertyValue("--window-title-natural")).toBe("446px");
    expect(box.style.getPropertyValue("--window-title-roll-duration")).toMatch(/^\d+(\.\d+)?s$/);
    expect(box.getAttribute("title"), "the whole title stays a tooltip").toBe(`${LOCAL} and then some`);

    // A retitle to a short name while the box is still as wide as the long
    // one left it: the floor comes down to the short text.
    textWidth = 60;
    windowTabBar.title = "Window 1";
    await tick();
    expect(box.hasAttribute("data-overflow")).toBe(false);
    expect(box.style.getPropertyValue("--window-title-natural"), "a short title's floor is its own width").toBe("76px");
    expect(box.style.getPropertyValue("--window-title-roll-distance")).toBe("0px");
  });

  test("its own width is the text's, whatever the width of the box around it", async () => {
    windowTabBar.title = LOCAL;
    resetLayout([terminalTab()]);
    await renderBar();
    const box = titleBox();
    const text = box.querySelector<HTMLElement>(".bar-title-text")!;
    const run = text.firstElementChild as HTMLElement;
    // A browser's scroll width is never less than the box, so a box wider
    // than its text reports its own width there.
    let boxWidth = 400;
    run.getBoundingClientRect = () => ({ width: 164.2 }) as DOMRect;
    Object.defineProperty(text, "clientWidth", { configurable: true, get: () => boxWidth });
    Object.defineProperty(text, "scrollWidth", { configurable: true, get: () => boxWidth });
    windowTabBar.title = "\u2193\uFE0E local Terminal Window 1";
    await tick();
    expect(box.style.getPropertyValue("--window-title-natural")).toBe("181px");
    expect(box.hasAttribute("data-overflow")).toBe(false);

    // The box changes width under the same text: the floor stays the text's.
    for (boxWidth of [234, 250, 181, 600]) {
      windowTabBar.title = `\u2193\uFE0E local Terminal Window 1 [${boxWidth}]`;
      await tick();
      expect(box.style.getPropertyValue("--window-title-natural"), `in a ${boxWidth} px box`).toBe("181px");
    }
  });

  test("privacy mode shows the generated name alone, and the full title once it is off", async () => {
    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(ownSnapshot());
    windowTabBar.title = "\u2197 geekom Terminal Window 2 [deploy shell]";
    await renderBar();
    expect(shown()).toBe("\u2197 geekom Terminal Window 2 [deploy shell]");
    expect(loadScopedLibrarySnapshot, "the desktop's title needs no read").not.toHaveBeenCalled();

    // The page still holds the full title when it hears privacy mode turn on.
    privacy.enabled = true;
    await vi.waitFor(() => expect(shown()).toBe("Terminal Window 2"));
    expect(titleBox().getAttribute("title")).toBe("Terminal Window 2");
    // The desktop masks every window's title while privacy mode is on.
    windowTabBar.title = "Chan (privacy mode)";
    await tick();
    expect(shown()).toBe("Terminal Window 2");
    applyWindowLabel("private.example");
    await tick();
    expect(shown()).toBe("Terminal Window 2");
    // Turning it off retitles every window before the setting is announced.
    windowTabBar.title = "\u2197 geekom Terminal Window 2 [private.example]";
    await tick();
    expect(shown()).toBe("Terminal Window 2");
    privacy.enabled = false;
    await tick();
    expect(shown()).toBe("\u2197 geekom Terminal Window 2 [private.example]");
  });

  test("a window no title has reached is named as Computers names it, read at a pane tree open and again after a failed read", async () => {
    vi.mocked(loadScopedLibrarySnapshot).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(ownSnapshot());
    const bar = await renderBar();
    expect(shown(), "nothing to show yet").toBeNull();
    expect(bar.querySelector(".slot")?.classList.contains("beside-title")).toBe(false);
    expect(loadScopedLibrarySnapshot).not.toHaveBeenCalled();

    openPaneTree();
    await vi.waitFor(() => expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(1));
    await tick();
    expect(shown()).toBeNull();
    closePaneTree();
    await tick();
    openPaneTree();
    await vi.waitFor(() => expect(shown()).toBe("Terminal Window 2 [deploy shell]"));

    applyWindowLabel("release checks");
    await tick();
    expect(shown(), "a rename shows").toBe("Terminal Window 2 [release checks]");
  });

  test("a window booted in privacy mode reads its name again until the read succeeds", async () => {
    vi.useFakeTimers();
    // The window has no live presence yet, so the first reads are refused.
    vi.mocked(loadScopedLibrarySnapshot)
      .mockRejectedValueOnce(new Error("no presence"))
      .mockRejectedValueOnce(new Error("no presence"))
      .mockResolvedValue(ownSnapshot());
    privacy.enabled = true;
    windowTabBar.title = "Chan (privacy mode)";
    await renderBar();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();

    await vi.advanceTimersByTimeAsync(WINDOW_TITLE_READ_RETRY_MS);
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(2);
    expect(shown()).toBeNull();
    await vi.advanceTimersByTimeAsync(WINDOW_TITLE_READ_RETRY_MS);
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(3);
    expect(shown()).toBe("Terminal Window 2");

    await vi.advanceTimersByTimeAsync(WINDOW_TITLE_READ_RETRY_MS * 3);
    expect(loadScopedLibrarySnapshot, "a named window reads no more").toHaveBeenCalledTimes(3);
  });

  test("the retries are bounded, and the window's socket opening reads again at once", async () => {
    vi.useFakeTimers();
    vi.mocked(loadScopedLibrarySnapshot).mockRejectedValue(new Error("no presence"));
    privacy.enabled = true;
    await renderBar();
    await vi.advanceTimersByTimeAsync(WINDOW_TITLE_READ_RETRY_MS * (WINDOW_TITLE_READ_RETRIES + 5));
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(1 + WINDOW_TITLE_READ_RETRIES);
    expect(shown()).toBeNull();

    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(ownSnapshot());
    ui.ws = "open";
    await vi.advanceTimersByTimeAsync(0);
    expect(loadScopedLibrarySnapshot).toHaveBeenCalledTimes(2 + WINDOW_TITLE_READ_RETRIES);
    expect(shown()).toBe("Terminal Window 2");
  });

  test("a browser's bar, which no title reaches, shows the name its boot read", async () => {
    vi.mocked(loadScopedLibrarySnapshot).mockResolvedValue(ownSnapshot());
    await loadWindowTitle();
    await renderBar();
    expect(shown()).toBe("Terminal Window 2 [deploy shell]");
  });

  test("is display only, and on the desktop a press on the box, its text or the run inside drags the window", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async () => null } });
    windowTabBar.title = LOCAL;
    await renderBar();
    const box = titleBox();
    const text = box.querySelector<HTMLElement>(".bar-title-text")!;
    const run = text.firstElementChild as HTMLElement;
    for (const part of [box, text, run]) {
      expect(part.getAttribute("data-tauri-drag-region"), part.className).toBe("");
      expect(part.closest("button, [role], [tabindex]"), "nothing to press or focus").toBeNull();
      part.click();
    }
    expect(run.querySelector("*"), "a press lands on the run itself").toBeNull();
    expect(text.children, "the text holds the run alone").toHaveLength(1);
    await tick();
    expect(paneTree.open, "a press opens nothing").toBe(false);
  });

  test("hides with the tree button while the Computers launcher covers the window", async () => {
    windowTabBar.title = LOCAL;
    await renderBar();
    expect(titleBox().classList.contains("covered")).toBe(false);
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(titleBox().classList.contains("covered")).toBe(true);
  });

  test("leaves with the bar from wherever it sits", async () => {
    windowTabBar.title = LOCAL;
    resetLayout([terminalTab()]);
    await renderBar();
    // A place outside the bar, as a pane's strip is once the bar has gone.
    const place = stripWithTitleSlot(document.body);
    await tick();
    expect(titleBox().parentElement).toBe(place);
    if (component) await unmount(component);
    component = null;
    expect(document.querySelector(".bar-title")).toBeNull();
  });
});

describe("a tmux window", () => {
  /// Two tmux panes side by side, as the server's tmux_layout lays them
  /// out: each pane one terminal tab marked with its tmux pane and titled
  /// with its session's tab name. The left one is active.
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
    expect(parts(bar)).toEqual(["inset", "tree-button", "tmux-name", "slot", "title-end", "tmux-badge", "inset"]);
  });

  test("keeps the window's title at the bar's end, between the pane's name and the badge", async () => {
    tmuxPanes();
    windowTabBar.title = "\u2193\uFE0E local Terminal Window 1 [build]";
    const bar = await renderBar();
    const title = bar.querySelector<HTMLElement>(".bar-title")!;
    expect(title.textContent?.trim()).toBe("\u2193\uFE0E local Terminal Window 1 [build]");
    expect(title.dataset.place).toBe("end");
    expect(title.parentElement?.classList.contains("title-end")).toBe(true);
    expect(title.parentElement?.previousElementSibling?.classList.contains("slot")).toBe(true);
    expect(title.parentElement?.nextElementSibling?.classList.contains("tmux-badge")).toBe(true);
    expect(nameOf(bar), "the pane's name stands").toBe("editor");
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

  test("shows what tmux calls the active pane, without the suffix its tab name carries", async () => {
    // Two panes at a shell: the server keeps tab names unique, so the second
    // session is "bash-2", and tmux calls both panes "bash".
    tmuxPanes("bash", "bash-2");
    const entry = (id: string, tabName: string, tmuxName: string) => ({
      id, tab_name: tabName, tmux_name: tmuxName, tab_group: "tmux", window_id: null, broadcast: false,
    });
    applyTerminalRoster([entry("s0", "bash", "bash"), entry("s1", "bash-2", "bash")]);
    const bar = await renderBar();
    setActivePane("right");
    await tick();
    expect(nameOf(bar)).toBe("bash");
    expect(nameOf(bar)).toBe(paneTreeLabel());

    // The pane runs top: its own name changes and the other pane's does not.
    applyTerminalRoster([entry("s0", "bash", "bash"), entry("s1", "top", "top")]);
    await tick();
    expect(nameOf(bar)).toBe("top");
    setActivePane("left");
    await tick();
    expect(nameOf(bar)).toBe("bash");
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
    expect(parts(bar)).toEqual(["inset", "tree-button", "slot", "title-end", "inset"]);
  });
});
