// @vitest-environment jsdom
//
// The window tab bar: the tree button draws the window's pane layout with
// the active pane filled and badges a program status the bar does not show,
// and toggles the pane tree; the bar offers its slot for the active pane's
// strip, keeps its insets clear for the window controls, centres its row on
// them, and on the desktop marks its empty stretches as the window's drag
// space. While the window's Computers launcher covers the page, the band
// shows neither the tree button nor the strip.

import { mount, tick, unmount } from "svelte";
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
    windowTabBar.chrome = { active: true, insetLeft: 78, insetRight: 0, controlsCenterY: 14, fullscreen: false };
    windowTabBar.height = 38;
    const bar = await renderBar();
    const [left, right] = [...bar.querySelectorAll<HTMLElement>(".inset")];
    expect(left?.style.width).toBe("78px");
    expect(right?.style.width).toBe("0px");
    expect(bar.style.height).toBe("38px");
    expect(bar.style.paddingBottom, "the 28px row above the pad centres on y=14").toBe("10px");

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
