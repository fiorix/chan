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
// the band shows neither the tree button nor the strip.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const tree = vi.hoisted(() => ({ status: null as "working" | "done" | "blocked" | "error" | null }));

vi.mock("../state/paneTree.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/paneTree.svelte")>()),
  hiddenTabStatus: () => tree.status,
}));

import WindowTabBar from "./WindowTabBar.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/focusGuard";
import { closePaneTree, PANE_TREE_ANCHOR_ATTR, paneTree, openPaneTree } from "../state/paneTree.svelte";
import { layout, setActivePane } from "../state/tabs.svelte";
import {
  NO_TITLEBAR_CHROME,
  WINDOW_TAB_BAR_MIN_HEIGHT,
  windowTabBar,
} from "../state/windowTabBar.svelte";
import { resetLayout } from "../__tests__/tabs";

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
  delete (window as W).__TAURI_INTERNALS__;
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  document.body.innerHTML = "";
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

  function controls(bar: HTMLElement): HTMLButtonElement[] {
    return [...bar.querySelectorAll<HTMLButtonElement>(".window-control")];
  }

  test("are drawn only when the desktop asks for them, and the right inset stays an empty spacer otherwise", async () => {
    windowTabBar.chrome = { ...NO_TITLEBAR_CHROME, active: true, insetLeft: 78, controlsCenterY: 14 };
    const bar = await renderBar();
    expect(controls(bar), "macOS draws its own").toEqual([]);
    const right = [...bar.querySelectorAll<HTMLElement>(".inset")].at(-1)!;
    expect(right.children).toHaveLength(0);

    windowTabBar.chrome = WINDOWS_CHROME;
    flushSync();
    expect(controls(bar)).toHaveLength(3);

    windowTabBar.chrome = { ...WINDOWS_CHROME, insetRight: 0, drawControls: false, fullscreen: true };
    flushSync();
    expect(controls(bar), "fullscreen draws none").toEqual([]);
    expect([...bar.querySelectorAll<HTMLElement>(".inset")].at(-1)?.style.width).toBe("0px");
  });

  test("fill the right inset as three equal buttons: minimize, maximize, close", async () => {
    windowTabBar.chrome = WINDOWS_CHROME;
    const bar = await renderBar();
    const inset = bar.querySelector<HTMLElement>(".inset.window-controls")!;
    expect(inset, "the inset is the bar's last part").toBe(bar.lastElementChild);
    expect(inset.style.width).toBe("138px");
    expect([...inset.children]).toEqual(controls(bar));
    expect(controls(bar).map((b) => b.dataset.action)).toEqual(["minimize", "toggleMaximize", "close"]);
    expect(controls(bar).map((b) => b.getAttribute("aria-label"))).toEqual(["Minimize", "Maximize", "Close"]);
    expect(controls(bar).map((b) => b.title)).toEqual(["Minimize", "Maximize", "Close"]);
    for (const button of controls(bar)) {
      expect(button.style.width, "each takes an equal share").toBe("46px");
      expect(button.querySelector("svg"), "an inline glyph").not.toBeNull();
      expect(button.tabIndex, "out of the tab order").toBe(-1);
    }
  });

  test("the middle button maximizes or restores as the window is", async () => {
    windowTabBar.chrome = WINDOWS_CHROME;
    const bar = await renderBar();
    const middle = () => controls(bar)[1]!;
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
    const bar = await renderBar();
    for (const button of controls(bar)) button.click();
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
    const bar = await renderBar();
    controls(bar)[2]!.click();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[1])).toContain("not allowed by ACL");
  });

  test("never drag the window: no drag attribute, and a press goes no further than the button", async () => {
    asDesktop();
    windowTabBar.chrome = WINDOWS_CHROME;
    const bar = await renderBar();
    expect(bar.getAttribute("data-tauri-drag-region"), "the bar still drags").toBe("");
    const inset = bar.querySelector<HTMLElement>(".window-controls")!;
    expect(inset.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(inset.querySelector("[data-tauri-drag-region]")).toBeNull();

    const seen: string[] = [];
    const record = (e: Event) => seen.push(e.type);
    bar.addEventListener("mousedown", record);
    document.addEventListener("mousedown", record);
    try {
      for (const button of controls(bar)) {
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
