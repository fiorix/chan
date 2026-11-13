// @vitest-environment jsdom
//
// The pane strip under the window tab bar mode: no pane draws its strip in
// place; the active pane's strip element moves into the bar's slot with its
// handlers, every other pane's is hidden, a focus change (Hybrid Nav's
// staged one included) moves it, and leaving the mode or destroying the pane
// puts it back where it was. A tmux pane's strip stays hidden in the bar,
// which shows the window's title and a tmux badge. The strip in the bar takes the window's
// title, left of its actions, while the window has tabs, and its tabs fade
// toward it while more of them lie past the strip's end.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import Pane from "./Pane.svelte";
import WindowTabBar from "./WindowTabBar.svelte";
import {
  activeLayout,
  cancelPaneMode,
  enterPaneMode,
  layout,
  paneModeMoveFocus,
  paneModeStageDraftEditor,
  setActivePane,
  type LeafNode,
  type Tab,
} from "../state/tabs.svelte";
import { __testSetStandalonePreferences, persistStateToHash } from "../state/store.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { workspace } from "../state/workspace.svelte";
import { demoWorkspaceInfo } from "../demo/data";
import { preferences } from "../__tests__/standalone";
import { terminalTab } from "../__tests__/tabs";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as typeof cancelAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];

const mounted = new Map<string, Record<string, unknown>>();
let slot: HTMLElement;

afterEach(async () => {
  for (const component of mounted.values()) await unmount(component);
  mounted.clear();
  windowTabBar.on = false;
  windowTabBar.slot = null;
  windowTabBar.titleSlot = null;
  windowTabBar.title = "";
  cancelPaneMode();
  document.body.innerHTML = "";
  delete (window as W).__TAURI_INTERNALS__;
  workspace.info = null;
  __testSetStandalonePreferences(null);
  persistStateToHash();
});

/// Two panes side by side, the left one active.
function splitLayout(left: Tab[], right: Tab[]): void {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", ratio: 0.5, a: "left", b: "right" },
    left: { kind: "leaf", id: "left", tabs: left, activeTabId: left[0]?.id ?? null },
    right: { kind: "leaf", id: "right", tabs: right, activeTabId: right[0]?.id ?? null },
  };
  layout.rootId = "root";
  layout.activePaneId = "left";
  layout.focusColor = "blue";
}

function twoPanes(): void {
  splitLayout(
    [terminalTab({ id: "l1", title: "left one" }), terminalTab({ id: "l2", title: "left two" })],
    [terminalTab({ id: "r1", title: "right one" }), terminalTab({ id: "r2", title: "right two" })],
  );
}

/// Mount each pane as the window shows it: the draft's leaf in Hybrid Nav.
async function renderPanes(...ids: string[]): Promise<void> {
  for (const id of ids) {
    const pane = activeLayout().nodes[id];
    if (pane?.kind !== "leaf") throw new Error(`no leaf ${id}`);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.set(id, mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  }
  await tick();
}

function barOn(): void {
  slot = document.createElement("div");
  slot.className = "test-bar-slot";
  document.body.append(slot);
  windowTabBar.slot = slot;
  windowTabBar.on = true;
}

/// The mode on, with the window's own bar holding the slot.
async function renderBar(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.set("bar", mount(WindowTabBar, { target }) as Record<string, unknown>);
  windowTabBar.on = true;
  await tick();
  const bar = target.querySelector<HTMLElement>(".window-tab-bar");
  if (!bar || !windowTabBar.slot) throw new Error("no bar");
  slot = windowTabBar.slot;
  return bar;
}

function live(id: string): LeafNode {
  const node = layout.nodes[id];
  if (node?.kind !== "leaf") throw new Error(`pane ${id} is not a leaf`);
  return node;
}

function face(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"] .pane-card-face`);
  if (!element) throw new Error(`pane ${id} has no card face`);
  return element;
}

/// The pane's strip where the pane draws it, or null when it is away.
function inPlace(id: string): HTMLElement | null {
  return face(id).querySelector<HTMLElement>(":scope > .tabs");
}

function labels(strip: Element | null): string[] {
  return [...(strip?.querySelectorAll(".tab .path") ?? [])].map((el) => el.textContent ?? "");
}

function barStrips(): HTMLElement[] {
  return [...slot.querySelectorAll<HTMLElement>(":scope > .tabs")];
}

describe("the window tab bar mode", () => {
  test("the active pane's strip lives in the bar and every other pane's is hidden", async () => {
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    expect(barStrips()).toHaveLength(1);
    expect(labels(barStrips()[0])).toEqual(["left one", "left two"]);
    expect(barStrips()[0]?.classList.contains("in-bar")).toBe(true);
    expect(inPlace("left"), "the active pane draws no strip of its own").toBeNull();
    expect(inPlace("right")?.classList.contains("bar-hidden"), "another pane's strip is hidden").toBe(true);
  });

  test("the strip keeps its handlers in the bar", async () => {
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    const second = barStrips()[0]?.querySelectorAll<HTMLElement>(".tab")[1];
    second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    second?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await tick();
    expect(live("left").activeTabId, "a press on a tab in the bar selects it").toBe("l2");

    barStrips()[0]?.querySelector<HTMLButtonElement>(".side-toggle")?.click();
    await tick();
    expect(live("left").side, "the side toggle in the bar flips the pane").toBe("b");
    expect(barStrips(), "the flipped side's strip stays in the bar").toHaveLength(1);
  });

  test("a focus change moves the strip to the newly active pane", async () => {
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    setActivePane("right");
    await tick();
    expect(labels(barStrips()[0])).toEqual(["right one", "right two"]);
    expect(barStrips()).toHaveLength(1);
    expect(inPlace("right")).toBeNull();
    const left = inPlace("left");
    expect(left?.classList.contains("bar-hidden"), "the old strip is back in its pane, hidden").toBe(true);
    expect(left?.nextElementSibling?.classList.contains("editor-wrap"), "in its own place, above the body").toBe(true);
  });

  test("leaving the mode puts every strip back in its pane", async () => {
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    windowTabBar.on = false;
    await tick();
    expect(slot.children).toHaveLength(0);
    for (const id of ["left", "right"]) {
      const strip = inPlace(id);
      expect(strip, `${id} draws its strip again`).not.toBeNull();
      expect(strip?.classList.contains("bar-hidden")).toBe(false);
      expect(strip?.classList.contains("in-bar")).toBe(false);
      expect(strip?.nextElementSibling?.classList.contains("editor-wrap")).toBe(true);
    }
  });

  test("a destroyed pane takes its strip out of the bar", async () => {
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    const component = mounted.get("left");
    mounted.delete("left");
    if (component) await unmount(component);
    expect(slot.children).toHaveLength(0);
  });

  test("Hybrid Nav's staged focus moves the strip, and its staged rows show in the bar", async () => {
    twoPanes();
    barOn();
    enterPaneMode();
    await renderPanes("left", "right");
    expect(labels(barStrips()[0])).toEqual(["left one", "left two"]);

    paneModeMoveFocus("right");
    await tick();
    expect(labels(barStrips()[0])).toEqual(["right one", "right two"]);
    expect(layout.activePaneId, "the live layout's focus is untouched").toBe("left");

    paneModeStageDraftEditor();
    await tick();
    expect(barStrips()[0]?.querySelector(".tab.staged-editor"), "the staged row is in the bar").not.toBeNull();
  });

  test("the auto-hide preference does not hide the strip in the bar", async () => {
    workspace.info = demoWorkspaceInfo(
      { metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 }, files: [] },
      preferences({ pane_strip_auto_hide: true }),
    );
    splitLayout([terminalTab({ id: "lone", title: "lone" })], [terminalTab({ id: "other", title: "other" })]);
    barOn();
    await renderPanes("left", "right");
    expect(barStrips()[0]?.classList.contains("auto-hidden")).toBe(false);

    windowTabBar.on = false;
    await tick();
    expect(inPlace("left")?.classList.contains("auto-hidden"), "in place it hides again").toBe(true);
  });

  test("a tmux pane's strip stays hidden in the bar, which shows the window's title and the badge", async () => {
    const TITLE = "↓︎ local Terminal Window 3 [editor]";
    windowTabBar.title = TITLE;
    splitLayout(
      [terminalTab({ id: "tmux", title: "editor", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })],
      [terminalTab({ id: "plain", title: "plain one" })],
    );
    const bar = await renderBar();
    await renderPanes("left", "right");
    expect(barStrips()).toHaveLength(1);
    expect(barStrips()[0]?.classList.contains("control-hidden"), "the strip in the bar stays hidden").toBe(true);
    // The bar's text, in order, outside what it hides.
    const visible = (): string[] => {
      const texts: string[] = [];
      const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (text && !node.parentElement?.closest("[hidden], .control-hidden")) texts.push(text);
      }
      return texts;
    };
    expect(visible(), "the window's title and the badge, no pane's name").toEqual([TITLE, "tmux"]);

    setActivePane("right");
    await tick();
    expect(labels(barStrips()[0]), "a plain pane's strip shows in the bar").toEqual(["plain one"]);
    expect(barStrips()[0]?.classList.contains("control-hidden")).toBe(false);
    expect(bar.querySelector(".tmux-badge"), "and the bar marks no tmux").toBeNull();
  });

  describe("the window's title", () => {
    const TITLE = "\u2191\uFE0E geekom / chan Window 1 [label]";

    function titleBox(): HTMLElement {
      const box = document.querySelector<HTMLElement>(".bar-title");
      if (!box) throw new Error("no title");
      return box;
    }

    /// The classes of the strip's parts in order, the title's place opened
    /// up, since it draws no box of its own.
    function stripParts(strip: HTMLElement): string[] {
      return [...strip.children].flatMap((part) =>
        part.classList.contains("bar-title-slot")
          ? [...part.children].map((inner) => inner.classList[0] ?? "")
          : [part.classList[0] ?? ""],
      );
    }

    test("sits in the strip in the bar, after the tabs and left of the side toggle", async () => {
      twoPanes();
      windowTabBar.title = TITLE;
      await renderBar();
      await renderPanes("left", "right");

      const strip = barStrips()[0]!;
      const box = titleBox();
      expect(strip.contains(box)).toBe(true);
      expect(box.textContent?.trim()).toBe(TITLE);
      expect(stripParts(strip)).toEqual(["tab-scroll", "dead-zone", "bar-title", "actions"]);
      expect(strip.querySelector(".actions")?.firstElementChild?.classList.contains("side-toggle")).toBe(true);
      expect(inPlace("right")?.querySelector(".bar-title-slot"), "a strip out of the bar offers no place").toBeNull();
    });

    test("with no tab in the window it sits after the tree button, and the strip keeps its actions", async () => {
      splitLayout([], []);
      windowTabBar.title = TITLE;
      const bar = await renderBar();
      await renderPanes("left", "right");

      const box = titleBox();
      expect(box.parentElement).toBe(bar);
      expect(box.previousElementSibling).toBe(bar.querySelector(".tree-button"));
      expect(box.nextElementSibling, "the strip follows it").toBe(slot);
      expect(stripParts(barStrips()[0]!)).toEqual(["tab-scroll", "dead-zone", "actions"]);
    });

    test("follows the strip to the newly active pane, and survives its pane's destruction", async () => {
      twoPanes();
      windowTabBar.title = TITLE;
      const bar = await renderBar();
      await renderPanes("left", "right");
      const box = titleBox();

      setActivePane("right");
      await tick();
      expect(labels(barStrips()[0])).toEqual(["right one", "right two"]);
      expect(barStrips()[0]!.contains(box)).toBe(true);
      expect(inPlace("left")?.contains(box), "the strip that went home left the title behind").toBe(false);

      await unmount(mounted.get("right")!);
      mounted.delete("right");
      await tick();
      expect(titleBox(), "the same element").toBe(box);
      expect(bar.contains(box)).toBe(true);
      expect(box.parentElement?.classList.contains("title-end"), "no strip in the bar: the bar's own end").toBe(true);
    });

    test("a tmux pane's hidden strip offers no place, so the title sits at the bar's end before the badge", async () => {
      splitLayout(
        [terminalTab({ id: "tmux", title: "editor", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })],
        [terminalTab({ id: "plain", title: "plain one" })],
      );
      windowTabBar.title = TITLE;
      const bar = await renderBar();
      await renderPanes("left", "right");
      const box = titleBox();
      expect(box.parentElement?.classList.contains("title-end")).toBe(true);
      expect(box.parentElement?.nextElementSibling).toBe(bar.querySelector(".tmux-badge"));

      setActivePane("right");
      await tick();
      expect(barStrips()[0]!.contains(box), "a plain pane's strip takes it").toBe(true);
    });

    test("the strip's tabs fade toward it only while more of them lie past the strip's end", async () => {
      twoPanes();
      windowTabBar.title = TITLE;
      await renderBar();
      await renderPanes("left", "right");
      const view = barStrips()[0]!.querySelector<HTMLElement>(".tab-scroll")!;
      expect(view.classList.contains("fade-end"), "the tabs fit").toBe(false);

      // jsdom lays nothing out: the tabs are 900 px wide in a 400 px viewport.
      Object.defineProperty(view, "scrollWidth", { configurable: true, get: () => 900 });
      Object.defineProperty(view, "clientWidth", { configurable: true, get: () => 400 });
      view.dispatchEvent(new Event("scroll"));
      await tick();
      expect(view.classList.contains("fade-end")).toBe(true);

      view.scrollLeft = 500;
      view.dispatchEvent(new Event("scroll"));
      await tick();
      expect(view.classList.contains("fade-end"), "scrolled to the end, the last tab is whole").toBe(false);

      view.scrollLeft = 0;
      view.dispatchEvent(new Event("scroll"));
      await tick();
      windowTabBar.on = false;
      await tick();
      expect(inPlace("left")?.querySelector(".tab-scroll")?.classList.contains("fade-end"), "in place nothing fades").toBe(false);
    });
  });

  test("on the desktop the strip's empty stretch in the bar drags the window", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async () => null } });
    twoPanes();
    barOn();
    await renderPanes("left", "right");

    const strip = barStrips()[0];
    expect(strip?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(strip?.querySelector(".dead-zone")?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(inPlace("right")?.hasAttribute("data-tauri-drag-region")).toBe(false);

    windowTabBar.on = false;
    await tick();
    expect(inPlace("left")?.hasAttribute("data-tauri-drag-region"), "in place the strip drags nothing").toBe(false);
  });
});
