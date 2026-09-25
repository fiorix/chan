// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

// Static top-level component import (not a per-test `await import(...)`).
// The flake was the dynamic import inside `renderPane` timing out (30s)
// under the full parallel suite, where Svelte-component transform/import
// is contended across workers - not an assertion or shared-state race.
// Resolving the module once at module-eval takes the import off the timed
// path.
import Pane from "./Pane.svelte";
import paneSource from "./Pane.svelte?raw";
import {
  adoptCrossWindowTab,
  cancelPaneMode,
  crossWindowTabSnapshot,
  enterPaneMode,
  enterPaneModeTransaction,
  layout,
  paneMode,
  paneModeOpenBrowser,
  paneModeSetGrab,
  paneModeSetHover,
  paneModeSetMouseSplit,
  paneModeStageDiagramEditor,
  paneModeStageDraftEditor,
  clearRecentlyClosedTabsForTest,
  closeTab,
  paneSide,
  paneSideToggleFlash,
  requestPaneSideToggleFlash,
  requestPaneWobble,
  splitPane,
  type BrowserTab,
  type DashboardTab,
  type GraphTab,
  type LeafNode,
  type Tab,
} from "../state/tabs.svelte";
import { ui } from "../state/store.svelte";
import { dragScopeMimeToken, sessionWindowId, windowDragScope, windowLibraryId } from "../api/client";
import { fileTab, terminalTab } from "../__tests__/tabs";

const mounted: Array<Record<string, any>> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as any;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as any;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
  paneSideToggleFlash.versions = {};
});

function graphTab(partial: Partial<GraphTab> = {}): GraphTab {
  return {
    kind: "graph",
    id: "graph-1",
    title: "Graph",
    mode: "semantic",
    scopeId: "workspace",
    depth: 1,
    expanded: { "": true },
    filters: {
      link: true,
      tag: true,
      mention: true,
      language: true,
      img: true,
      folder: true,
      markdown: true,
      source: true,
    },
    inspectorOpen: false,
    pendingSelectId: null,
    ...partial,
  };
}

function browserTab(partial: Partial<BrowserTab> = {}): BrowserTab {
  return {
    kind: "browser",
    id: "browser-1",
    title: "Files",
    inspectorOpen: false,
    ...partial,
  };
}

function dashboardTab(partial: Partial<DashboardTab> = {}): DashboardTab {
  return {
    kind: "dashboard",
    id: "dash-1",
    title: "Dashboard",
    ...partial,
  };
}

async function renderPane(
  pane: LeafNode,
  options: { paneMode?: boolean } = {},
) {
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  if (options.paneMode ?? true) enterPaneMode();
  else cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const livePane = layout.nodes[pane.id];
  if (livePane?.kind !== "leaf") throw new Error("expected leaf");
  const component = mount(Pane, { target, props: { pane: livePane } });
  mounted.push(component);
  await tick();
  return target;
}

function menuLabels(): string[] {
  return [...document.body.querySelectorAll(".hamburger-menu button")]
    .map((button) =>
      [...button.querySelectorAll(".menu-row-label, span:not(.menu-row-chord)")]
        .map((span) => span.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .trim(),
    )
    .filter(Boolean);
}

/// Give every `.pane` a fixed box; answers the restore.
function stubPaneRect(width: number, height: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("pane")) {
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

/// A pane with a tab on each side, ready to flip.
function renderFlippablePane(id: string): Promise<HTMLElement> {
  const a = terminalTab({ id: `${id}-a`, title: "A tab" });
  const b = terminalTab({ id: `${id}-b`, title: "B tab" });
  return renderPane({ kind: "leaf", id, tabs: [a], activeTabId: a.id, bTabs: [b], bActiveTabId: b.id }, { paneMode: false });
}

function scopedAnimationEnd(name: string): AnimationEvent {
  const end = new Event("animationend", { bubbles: true }) as AnimationEvent;
  Object.defineProperty(end, "animationName", { configurable: true, value: name });
  return end;
}

function menuRowChords(): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const button of document.body.querySelectorAll(
    ".hamburger-menu button",
  )) {
    const label = button.querySelector(".menu-row-label")?.textContent?.trim();
    if (!label) continue;
    rows[label] =
      button.querySelector(".menu-row-chord")?.textContent?.trim() ?? "";
  }
  return rows;
}

describe("Pane terminal tab activity marker", () => {
  test("tabs expose selected state and labelled close buttons", async () => {
    const active = terminalTab({ id: "term-active", title: "Active" });
    const inactive = terminalTab({ id: "term-bg", title: "Background" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-tabs-a11y",
      tabs: [active, inactive],
      activeTabId: active.id,
    };

    const target = await renderPane(pane, { paneMode: false });
    const tabs = target.querySelectorAll<HTMLElement>('[role="tab"]');

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(
      tabs[0]
        ?.querySelector<HTMLButtonElement>(".close")
        ?.getAttribute("aria-label"),
    ).toBe("close Active");
  });

  test("renders output-since-focus marker for inactive terminal tabs", async () => {
    const active = terminalTab({ id: "term-active", title: "Active" });
    const inactive = terminalTab({
      id: "term-bg",
      title: "Background",
      terminalActivity: true,
    });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-test",
      tabs: [active, inactive],
      activeTabId: active.id,
    };

    const target = await renderPane(pane);

    expect(
      target.querySelector('[aria-label="terminal output since last focus"]'),
    ).not.toBeNull();
  });
});

// Every hamburger row in menu order: Commands / Hybrid Nav, the eight
// Apps spawn rows (alphabetical by title), the focus colours, then
// Close pane last (launcher parity).
const HAMBURGER_LABELS = [
  "Commands",
  "Hybrid Nav",
  "New dashboard",
  "New diagram",
  "New draft",
  "New file browser",
  "New graph",
  "New slide deck",
  "New team",
  "New terminal",
  "blue",
  "orange",
  "green",
  "pink",
  "Close pane",
];

describe("Pane right-click menus", () => {
  test("hamburger exposes Commands, Apps rows, and focus colour order", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-menu",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    expect(
      document.body.querySelector(".menu-label span")?.textContent?.trim(),
    ).toBe("Focus border colour");
    expect(menuLabels()).toEqual(HAMBURGER_LABELS);

    const orange = [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        ".hamburger-menu button",
      ),
    ].find((button) => button.textContent?.includes("orange"));
    orange?.click();
    await tick();

    expect(
      target.querySelector(".pane")?.getAttribute("data-focus-color"),
    ).toBe("orange");
  });

  test("pane hamburger keeps pane actions in the launcher (Apps rows aside)", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-trim",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    const labels = menuLabels();
    expect(labels).toEqual(HAMBURGER_LABELS);
    for (const label of [
      "New Draft",
      "Terminal",
      "File Browser",
      "Team Work",
      "Graph",
      "Search",
      "Dashboard",
      "Split right",
      "Split bottom",
      "Next pane",
      "Previous pane",
      "Close all tabs",
      "Kill pane",
    ]) {
      expect(labels).not.toContain(label);
    }
  });

  test("terminal-only hamburger keeps New terminal as the sole spawn row", async () => {
    // ui is module-global $state: restore in finally so the workspace-order
    // tests above stay on the default surface.
    ui.terminalOnly = true;
    try {
      const pane: LeafNode = {
        kind: "leaf",
        id: "pane-terminal-only-menu",
        tabs: [terminalTab()],
        activeTabId: "term-1",
      };
      const target = await renderPane(pane, { paneMode: false });

      target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
      await tick();

      // Order mirrors the workspace menu with the app-spawn block reduced to
      // the one command a terminal-only window can run.
      expect(menuLabels()).toEqual([
        "Commands",
        "Hybrid Nav",
        "New terminal",
        "blue",
        "orange",
        "green",
        "pink",
        "Close pane",
      ]);

      const items = [...document.body.querySelectorAll(".hamburger-menu li")];
      const sepIdx = items
        .map((li, i) => (li.classList.contains("sep") ? i : -1))
        .filter((i) => i >= 0);
      expect(sepIdx).toHaveLength(3);
      const between = items
        .slice(sepIdx[0]! + 1, sepIdx[1]!)
        .map((li) => li.querySelector(".menu-row-label")?.textContent?.trim());
      expect(between).toEqual(["New terminal"]);
      const chord = items[sepIdx[0]! + 1]?.querySelector(".menu-row-chord");
      expect(chord).not.toBeNull();
    } finally {
      ui.terminalOnly = false;
    }
  });

  test("hamburger nests the Apps rows between the two separators", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-apps-rows",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    // Menu structure: Commands / Hybrid Nav, separator, the eight Apps
    // rows, separator, the Focus border colour section, separator, then
    // the Close pane row last.
    const items = [...document.body.querySelectorAll(".hamburger-menu li")];
    const sepIdx = items
      .map((li, i) => (li.classList.contains("sep") ? i : -1))
      .filter((i) => i >= 0);
    expect(sepIdx).toHaveLength(3);
    const between = items
      .slice(sepIdx[0]! + 1, sepIdx[1]!)
      .map((li) => li.querySelector(".menu-row-label")?.textContent?.trim());
    expect(between).toEqual([
      "New dashboard",
      "New diagram",
      "New draft",
      "New file browser",
      "New graph",
      "New slide deck",
      "New team",
      "New terminal",
    ]);
    // Every Apps row renders a chord slot so the right column stays
    // aligned even for the chordless catalog spawns.
    for (const li of items.slice(sepIdx[0]! + 1, sepIdx[1]!)) {
      expect(li.querySelector(".menu-row-chord")).not.toBeNull();
    }
    // The Focus border colour section follows the second separator.
    expect(items[sepIdx[1]! + 1]?.classList.contains("menu-label")).toBe(true);
    // The Close pane row follows the third separator and closes the menu.
    const closeRow = items[sepIdx[2]! + 1];
    expect(
      closeRow?.querySelector(".menu-row-label")?.textContent?.trim(),
    ).toBe("Close pane");
    expect(closeRow).toBe(items[items.length - 1]);
  });

  test("Close pane row dispatches app.pane.kill and closes the menu", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-close-row",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    const dispatched: string[] = [];
    const onCommand = (e: Event): void => {
      dispatched.push((e as CustomEvent<{ name: string }>).detail.name);
    };
    window.addEventListener("chan:command", onCommand);
    try {
      const closeRow = [
        ...document.body.querySelectorAll<HTMLButtonElement>(
          ".hamburger-menu button",
        ),
      ].find(
        (button) =>
          button.querySelector(".menu-row-label")?.textContent?.trim() ===
          "Close pane",
      );
      expect(closeRow).not.toBeUndefined();
      closeRow!.click();
      await tick();
    } finally {
      window.removeEventListener("chan:command", onCommand);
    }

    expect(dispatched).toEqual(["app.pane.kill"]);
    // The row closes the menu after dispatching (the popover node only
    // exists while open).
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("pane hamburger shows the launcher chord", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-web-chords",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    const chords = menuRowChords();
    expect(chords["Commands"]).toBe("Ctrl+Alt+K");
  });

  test("Ctrl+Alt+Shift+T reopens the tab the focused pane closed last", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-reopen",
      tabs: [fileTab({ id: "keep", path: "keep.md" }), fileTab({ id: "gone", path: "gone.md" })],
      activeTabId: "keep",
    };
    await renderPane(pane, { paneMode: false });
    try {
      await closeTab("pane-reopen", "gone");
      const live = layout.nodes["pane-reopen"] as LeafNode;
      expect(live.tabs.map((tab) => tab.id)).toEqual(["keep"]);

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "T", code: "KeyT", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }),
      );
      await tick();

      expect(live.tabs.map((tab) => (tab.kind === "file" ? tab.path : tab.id))).toEqual(["keep.md", "gone.md"]);
    } finally {
      clearRecentlyClosedTabsForTest();
    }
  });

  test("empty pane right-click opens NO menu (empty-pane-menu)", async () => {
    // The command launcher carries spawn actions; right-clicking an
    // empty pane is a no-op.
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-empty",
      tabs: [],
      activeTabId: null,
    };
    const target = await renderPane(pane, { paneMode: false });
    expect(target.querySelector(".welcome")).not.toBeNull();

    target.querySelector(".placeholder")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
    await tick();

    // Right-clicking an empty pane is a no-op; no popover opens.
    // The hamburger trigger button is present but its menu stays closed.
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("empty pane left-click leaves the welcome menu closed", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-empty-leftclick",
      tabs: [],
      activeTabId: null,
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector(".placeholder")?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
        button: 0,
      }),
    );
    await tick();

    // No menu should be open after a plain left-click on the
    // empty-pane background - the welcome menu is right-click only.
    // The hamburger trigger (in the tabs strip) renders its own
    // button without opening a popover, so any `.hamburger-menu`
    // node in the DOM means the welcome popover actually opened.
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("loaded pane right-click keeps reload and inspector menu", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-loaded",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector(".tabs")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
    await tick();

    expect(menuLabels()).toEqual(["Reload", "Open Inspector"]);
  });

  // Side B is a normal tab side, so activity belongs to its own tab strip.
});

describe("Pane side flip", () => {
  test("side glyph exposes the Flip shortcut outside the hamburger", async () => {
    const front = terminalTab({ id: "front-term" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-flip-menu",
      tabs: [front],
      activeTabId: front.id,
    };
    const target = await renderPane(pane, { paneMode: false });
    const sideButton = target.querySelector<HTMLButtonElement>(".side-toggle");
    expect(sideButton?.title).toBe("Flip to side B (Ctrl+`)");
    expect(sideButton?.getAttribute("aria-label")).toBe(
      "Flip to side B (Ctrl+`)",
    );

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    expect(menuLabels()).toEqual(HAMBURGER_LABELS);
    expect(menuRowChords()["Flip"]).toBeUndefined();
  });

  test("side glyph flips between A and B", async () => {
    const a = terminalTab({ id: "side-a", title: "A tab" });
    const b = terminalTab({ id: "side-b", title: "B tab" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-side-button",
      tabs: [a],
      activeTabId: a.id,
      bTabs: [b],
      bActiveTabId: b.id,
    };
    const target = await renderPane(pane, { paneMode: false });
    expect(target.querySelector(".welcome")).toBeNull();
    const button = target.querySelector<HTMLButtonElement>(".side-toggle");
    expect(button?.textContent?.trim()).toBe("A");
    expect(button?.title).toBe("Flip to side B (Ctrl+`)");

    button?.click();
    await tick();

    const live = layout.nodes[pane.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(paneSide(live)).toBe("b");
    expect(button?.textContent?.trim()).toBe("B");
    expect(button?.title).toBe("Flip to side A (Ctrl+`)");
    const labels = [...target.querySelectorAll('[role="tab"] .path')].map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(["B tab"]);
  });

  test("side glyph flashes when a close shortcut is blocked by the hidden side", async () => {
    const hidden = terminalTab({ id: "hidden-side", title: "Hidden" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-side-flash",
      tabs: [],
      activeTabId: null,
      bTabs: [hidden],
      bActiveTabId: hidden.id,
      side: "a",
    };
    const target = await renderPane(pane, { paneMode: false });
    expect(target.querySelector(".welcome")).toBeNull();
    const button = target.querySelector<HTMLButtonElement>(".side-toggle");
    expect(button?.classList.contains("side-toggle-flash")).toBe(false);

    requestPaneSideToggleFlash(pane.id);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await tick();

    expect(button?.classList.contains("side-toggle-flash")).toBe(true);

    const end = new Event("animationend") as AnimationEvent;
    // A browser reports the scoped keyframe name Svelte rewrote.
    Object.defineProperty(end, "animationName", {
      configurable: true,
      value: "svelte-abc123-pane-side-toggle-flash",
    });
    button?.dispatchEvent(end);
    await tick();

    expect(button?.classList.contains("side-toggle-flash")).toBe(false);
  });

  test("split empty pane does not mount the welcome shortcuts", async () => {
    const front = terminalTab({ id: "split-front" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-split-front",
      tabs: [front],
      activeTabId: front.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const emptyPane = layout.nodes[root.b];
    if (emptyPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, {
      target,
      props: { pane: emptyPane },
    });
    mounted.push(component);
    await tick();

    expect(target.querySelector(".placeholder")).not.toBeNull();
    expect(target.querySelector(".welcome")).toBeNull();
  });

  test("side changes trigger a shape-aware flip animation", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("pane")) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 320,
          bottom: 120,
          width: 320,
          height: 120,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalRect.call(this);
    };
    try {
      const a = terminalTab({ id: "flip-a", title: "A tab" });
      const b = terminalTab({ id: "flip-b", title: "B tab" });
      const pane: LeafNode = {
        kind: "leaf",
        id: "pane-side-effect",
        tabs: [a],
        activeTabId: a.id,
        bTabs: [b],
        bActiveTabId: b.id,
      };
      const target = await renderPane(pane, { paneMode: false });
      target.querySelector<HTMLButtonElement>(".side-toggle")?.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      await tick();

      const paneEl = target.querySelector<HTMLElement>(".pane");
      expect(paneEl?.classList.contains("sideFlipActive")).toBe(true);
      expect(paneEl?.classList.contains("sideFlipHorizontal")).toBe(true);
      expect(paneEl?.classList.contains("sideFlipVertical")).toBe(false);
      expect(
        paneEl?.style.getPropertyValue("--pane-side-flip-start"),
      ).toContain("rotateX(-180deg)");

      // A real browser reports the SCOPED keyframe name (Svelte rewrites
      // `pane-side-flip` to `svelte-<hash>-pane-side-flip`), so the cleanup
      // must substring-match; a strict-equality regression fails here and
      // leaves the class stuck until the fallback timer.
      const end = new Event("animationend", {
        bubbles: true,
      }) as AnimationEvent;
      Object.defineProperty(end, "animationName", {
        configurable: true,
        value: "svelte-abc123-pane-side-flip",
      });
      target.querySelector(".pane-card-inner")?.dispatchEvent(end);
      await tick();
      expect(paneEl?.classList.contains("sideFlipActive")).toBe(false);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("a flip clears on its own even when no animationend arrives", async () => {
    const restore = stubPaneRect(320, 120);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const target = await renderFlippablePane("pane-flip-timer");
      target.querySelector<HTMLButtonElement>(".side-toggle")!.click();
      await tick();
      vi.advanceTimersByTime(16);
      await tick();
      const paneEl = target.querySelector<HTMLElement>(".pane")!;
      expect(paneEl.classList.contains("sideFlipActive")).toBe(true);

      vi.advanceTimersByTime(600);
      await tick();
      expect(paneEl.classList.contains("sideFlipActive")).toBe(false);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  test("a wobble clears on its scoped animationend", async () => {
    const target = await renderFlippablePane("pane-wobble");
    const paneEl = target.querySelector<HTMLElement>(".pane")!;

    requestPaneWobble("pane-wobble");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await tick();
    expect(paneEl.classList.contains("wobble")).toBe(true);

    paneEl.dispatchEvent(scopedAnimationEnd("svelte-abc123-pane-wobble-once"));
    await tick();
    expect(paneEl.classList.contains("wobble")).toBe(false);
  });

  test("a tall pane turns about the vertical axis, a square one either way", async () => {
    async function flipAxis(width: number, height: number, random?: number): Promise<[string, string]> {
      const restore = stubPaneRect(width, height);
      const roll = random === undefined ? null : vi.spyOn(Math, "random").mockReturnValue(random);
      try {
        const target = await renderFlippablePane(`pane-axis-${width}-${height}-${random ?? "x"}`);
        target.querySelector<HTMLButtonElement>(".side-toggle")!.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await tick();
        const paneEl = target.querySelector<HTMLElement>(".pane")!;
        const axis = paneEl.classList.contains("sideFlipVertical") ? "vertical" : "horizontal";
        return [axis, paneEl.style.getPropertyValue("--pane-side-flip-start")];
      } finally {
        roll?.mockRestore();
        restore();
      }
    }

    expect(await flipAxis(120, 320)).toEqual(["vertical", "rotateY(-180deg)"]);
    expect(await flipAxis(200, 200, 0.2)).toEqual(["vertical", "rotateY(-180deg)"]);
    expect(await flipAxis(200, 200, 0.8)).toEqual(["horizontal", "rotateX(-180deg)"]);
  });

  // Source-text contract: the back face's visibility gate is component CSS, which WebKitGTK obeys and jsdom never applies.
  test("the back face never paints at rest", () => {
    // WebKitGTK, the Linux desktop webview, ignores backface-visibility, so
    // an opaque back face left to that hint alone covers the card and every
    // terminal renders as a bare side letter. The rest state is a visibility
    // gate, and the handover sits at the easing's 90deg crossing rather than
    // at half the duration, which would show the letter mirrored.
    const backFace = paneSource.match(/\.pane-card-inner::before \{[\s\S]*?\n  \}/)?.[0] ?? "";
    // Anchored: `backface-visibility: hidden;` ends with the same text, so a
    // substring check passes on the very declaration this pin outlives.
    expect(backFace).toMatch(/^\s+visibility: hidden;$/m);
    expect(paneSource).toMatch(
      /\.pane\.sideFlipActive \.pane-card-inner::before \{\s*animation: pane-back-face-turn 520ms/,
    );
    expect(paneSource).toMatch(/@keyframes pane-back-face-turn/);
    expect(paneSource).toMatch(/0%,\s*14\.43% \{\s*visibility: visible;/);
    expect(paneSource).toMatch(/14\.44%,\s*100% \{\s*visibility: hidden;/);

    // Reduced motion drops the turn, so it must drop the handover too or the
    // back face is left painted with no animation to clear it.
    const reducedMotion = paneSource.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(reducedMotion).toContain(".pane.sideFlipActive .pane-card-inner::before");

    // The animationend cleanup substring-matches keyframe names, so no other
    // keyframe may contain one of the names it matches on.
    const keyframes = [...paneSource.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]);
    for (const matched of ["pane-side-flip", "pane-wobble-once", "pane-side-toggle-flash"]) {
      expect(keyframes.filter((name) => name.includes(matched))).toEqual([matched]);
    }
  });

  test("a tab label fades only while it overflows its tab", async () => {
    const widths = (el: HTMLElement): [number, number] =>
      el.textContent?.includes("a long label") ? [300, 100] : [50, 100];
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return widths(this)[0];
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return widths(this)[1];
      },
    });
    try {
      const pane: LeafNode = {
        kind: "leaf",
        id: "pane-fade",
        tabs: [
          terminalTab({ id: "long", title: "a long label that does not fit" }),
          terminalTab({ id: "short", title: "short" }),
        ],
        activeTabId: "long",
      };
      const target = await renderPane(pane, { paneMode: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await tick();

      const labels = [...target.querySelectorAll<HTMLElement>(".tab .path")].map((label) => [
        label.textContent?.trim(),
        label.classList.contains("overflowing"),
      ]);
      expect(labels).toEqual([
        ["a long label that does not fit", true],
        ["short", false],
      ]);
    } finally {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  test("clicking a visible B-side tab swaps only B active state", async () => {
    const a = terminalTab({ id: "front-t1", title: "A" });
    const b1 = terminalTab({ id: "back-t1", title: "B1" });
    const b2 = terminalTab({ id: "back-t2", title: "B2" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-side-click",
      tabs: [a],
      activeTabId: a.id,
      bTabs: [b1, b2],
      bActiveTabId: b1.id,
      side: "b",
    };
    const target = await renderPane(pane, { paneMode: false });
    const tabs = target.querySelectorAll<HTMLElement>(".tabs .tab");

    expect(tabs.length).toBe(2);
    expect(tabs[1]?.classList.contains("active")).toBe(false);
    tabs[1]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();

    const live = layout.nodes[pane.id];
    if (live?.kind !== "leaf") throw new Error("expected leaf");
    expect(live.bActiveTabId).toBe(b2.id);
    expect(live.activeTabId).toBe(a.id);
  });
});

describe("Pane Hybrid NAV transaction mode", () => {
  test("renders dead-zone hit area between last tab and actions", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-dz",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    const tabs = target.querySelector(".tabs");
    const deadZone = target.querySelector(".dead-zone");
    const actions = target.querySelector(".actions");
    expect(deadZone).not.toBeNull();
    // Dead zone must sit inside the tab strip, between the last tab
    // and the .actions block, so it absorbs mouse interactions in
    // the empty stretch the user perceives as "the pane top bar".
    expect(tabs?.contains(deadZone!)).toBe(true);
    expect(tabs?.contains(actions!)).toBe(true);
  });

  test("double-click on the dead zone enters transaction mode with no grab (Entry B)", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-dz-dblclick",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });
    const deadZone = target.querySelector<HTMLElement>(".dead-zone");
    expect(deadZone).not.toBeNull();

    deadZone!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await tick();

    expect(paneMode.active).toBe(true);
    expect(paneMode.transactionMode).toBe(true);
    expect(paneMode.grabPaneId).toBeNull();
  });

  test("pane root flips transaction-grab / transaction-drop-target classes from paneMode state", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    // Render the left pane explicitly so we can assert class flips
    // against the known pane id without relying on multi-pane mount.
    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: leftPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    expect(paneEl!.classList.contains("transaction-active")).toBe(false);

    enterPaneModeTransaction(leftPane.id);
    await tick();
    expect(paneEl!.classList.contains("transaction-active")).toBe(true);
    expect(paneEl!.classList.contains("transaction-grab")).toBe(true);

    // Switching grab to the OTHER pane while hovering THIS pane
    // flips the drop-target class on instead.
    paneModeSetGrab(rightPane.id);
    paneModeSetHover(leftPane.id);
    await tick();
    expect(paneEl!.classList.contains("transaction-grab")).toBe(false);
    expect(paneEl!.classList.contains("transaction-drop-target")).toBe(true);
  });

  test("a press on the dead zone grabs the pane once it moves five pixels, without an HTML5 drag", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-dead-zone",
      tabs: [terminalTab({ id: "dz" })],
      activeTabId: "dz",
    };
    const target = await renderPane(pane, { paneMode: false });
    const deadZone = target.querySelector<HTMLElement>(".dead-zone")!;
    expect(deadZone.getAttribute("draggable")).toBeNull();

    deadZone.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 103, clientY: 10 }));
    await tick();
    expect(paneMode.active).toBe(false);

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 106, clientY: 10 }));
    await tick();
    expect(paneMode.active).toBe(true);
    expect(paneMode.grabPaneId).toBe("pane-dead-zone");
  });

  test("touch events do not enter the mouse-only transaction", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-touch-isolation",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });
    const deadZone = target.querySelector<HTMLElement>(".dead-zone");
    expect(deadZone).not.toBeNull();

    deadZone!.dispatchEvent(new Event("touchstart", { bubbles: true }));
    deadZone!.dispatchEvent(new Event("touchmove", { bubbles: true }));
    deadZone!.dispatchEvent(new Event("touchend", { bubbles: true }));
    await tick();

    expect(paneMode.active).toBe(false);
    expect(paneMode.transactionMode).toBe(false);
  });
});

describe("Pane Hybrid NAV mouse edge splits", () => {
  test("dead-zone drag can split the only pane against its own edge", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-only-edge",
      tabs: [terminalTab({ id: "term-only", title: "Only" })],
      activeTabId: "term-only",
    };
    const target = await renderPane(pane, { paneMode: false });
    const paneEl = target.querySelector<HTMLElement>(".pane");
    const deadZone = target.querySelector<HTMLElement>(".dead-zone");
    expect(paneEl).not.toBeNull();
    expect(deadZone).not.toBeNull();
    paneEl!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    deadZone!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 106, clientY: 100 }),
    );
    expect(paneMode.transactionMode).toBe(true);
    expect(paneMode.grabPaneId).toBe(pane.id);

    paneEl!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 300 }),
    );
    await tick();
    expect(paneMode.mouseSplit).toEqual({ paneId: pane.id, edge: "left" });
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(true);
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(1);
    expect(Object.keys(layout.nodes)).toHaveLength(1);

    paneEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await tick();
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(1);
    const root = paneMode.draft?.nodes[paneMode.draft.rootId];
    expect(root?.kind).toBe("split");
    if (!root || root.kind !== "split") throw new Error("expected split root");
    expect(root.direction).toBe("row");
    expect(root.b).toBe(pane.id);
    const moved = paneMode.draft?.nodes[root.a];
    expect(moved?.kind === "leaf" && moved.tabs[0]?.id).toBe("term-only");
    const source = paneMode.draft?.nodes[pane.id];
    expect(source?.kind === "leaf" && source.tabs).toHaveLength(0);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();
  });

  test("an armed edge replaces the swap cue with the per-edge split preview class", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: rightPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();

    enterPaneModeTransaction(leftPane.id);
    paneModeSetHover(rightPane.id);
    await tick();
    // Center zone: the full-pane swap cue shows, no split preview.
    expect(paneEl!.classList.contains("transaction-drop-target")).toBe(true);
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(false);

    paneModeSetMouseSplit({ paneId: rightPane.id, edge: "left" });
    await tick();
    // Edge zone: the split preview owns the cue and the swap highlight
    // is suppressed so the two never read as the same drop.
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(true);
    expect(paneEl!.classList.contains("transaction-drop-target")).toBe(false);

    paneModeSetMouseSplit({ paneId: rightPane.id, edge: "bottom" });
    await tick();
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(false);
    expect(paneEl!.classList.contains("transaction-split-bottom")).toBe(true);

    // A preview aimed at another pane never leaks onto this one.
    paneModeSetMouseSplit({ paneId: leftPane.id, edge: "top" });
    await tick();
    expect(paneEl!.classList.contains("transaction-split-top")).toBe(false);
  });

  test("mousemove into an allowed edge arms preview only; mouseup runs the draft move", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: rightPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    paneEl!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    enterPaneModeTransaction(leftPane.id);

    // Cursor at (10, 300) of an 800x600 pane: left edge zone, and the
    // 50/50 row split leaves 400x600 halves, inside the 240x160 floor.
    paneEl!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 300 }),
    );
    await tick();
    expect(paneMode.mouseSplit).toEqual({ paneId: rightPane.id, edge: "left" });
    expect(paneMode.hoverPaneId).toBe(rightPane.id);
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(true);
    // Hover armed preview state only: neither the draft tree nor the
    // live layout changed shape.
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(3);

    paneEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await tick();
    // The draft gained the split + the moved leaf; live is untouched.
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(5);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
    const parent = Object.values(paneMode.draft?.nodes ?? {}).find(
      (n): n is Extract<typeof n, { kind: "split" }> =>
        n.kind === "split" && (n.a === rightPane.id || n.b === rightPane.id),
    );
    expect(parent?.direction).toBe("row");
    expect(parent?.b).toBe(rightPane.id);
    const moved = paneMode.draft?.nodes[parent!.a];
    expect(moved?.kind === "leaf" && moved.tabs.map((t) => t.id)).toEqual([
      "term-left",
    ]);
    const source = paneMode.draft?.nodes[leftPane.id];
    expect(source?.kind === "leaf" && source.tabs).toHaveLength(0);
    // The transaction cleared grab / hover / preview for the next drop.
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();
  });

  test("a refused undersized edge drops the target through the real handler", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: rightPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    // 400 wide halves to 200 per side, under the 240 floor: the left
    // edge zone must refuse rather than fall back to a swap.
    paneEl!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    enterPaneModeTransaction(leftPane.id);
    paneEl!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 300 }),
    );
    await tick();
    expect(paneMode.mouseSplit).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneEl!.classList.contains("transaction-drop-target")).toBe(false);
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(false);

    paneEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await tick();
    // No split, no swap: both trees keep their shape and the grab
    // survives so the user can aim again.
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
    expect(paneMode.grabPaneId).toBe(leftPane.id);
    const source = paneMode.draft?.nodes[leftPane.id];
    expect(source?.kind === "leaf" && source.tabs[0]?.id).toBe("term-left");
  });

  test("mouseup revalidates an armed edge after the pane shrinks", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: rightPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    let width = 800;
    paneEl!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width,
        height: 600,
        right: width,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    enterPaneModeTransaction(leftPane.id);
    paneEl!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 300 }),
    );
    await tick();
    expect(paneMode.mouseSplit).toEqual({ paneId: rightPane.id, edge: "left" });

    width = 491;
    paneEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await tick();

    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
    expect(paneMode.grabPaneId).toBe(leftPane.id);
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();
  });

  test("re-grab and same-pane mouseup clear the armed edge preview through the real handlers", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: rightPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    paneEl!.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    enterPaneModeTransaction(leftPane.id);
    paneEl!.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 300 }),
    );
    await tick();
    expect(paneMode.mouseSplit).toEqual({ paneId: rightPane.id, edge: "left" });
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(true);

    // Re-grab THIS pane: the preview it was carrying must not survive.
    paneEl!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    await tick();
    expect(paneMode.grabPaneId).toBe(rightPane.id);
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();
    expect(paneEl!.classList.contains("transaction-split-left")).toBe(false);

    // The same-pane mouseup releases the grab and leaves no target
    // state behind for a later grab to inherit.
    paneEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await tick();
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
  });

});

describe("Pane tab drag and drop between windows", () => {
  // A drag names its window, pane, side and tab, and stamps the window's drag
  // scope (its library and workspace) as a MIME type, the one part a target can
  // read while hovering. A target refuses a tab from another scope at hover and
  // at drop. A drop from this window moves the tab; one from another window,
  // even from a pane whose id matches one here, is adopted, and is claimed only
  // once the tab has been rebuilt here, so the source keeps a tab this window
  // could not rebuild. Both the tab strip and a tab accept drops.
  const TAB_MIME = "application/x-md-tab";
  const CROSS_MIME = "application/x-chan-tab+json";
  const SCOPE_PREFIX = "application/x-chan-tab-scope+";
  const OURS = SCOPE_PREFIX + dragScopeMimeToken(
    windowDragScope({ libraryId: windowLibraryId(), standalone: false, workspaceKey: null }),
  );
  const THEIRS = SCOPE_PREFIX + dragScopeMimeToken("lib:other|workspace:elsewhere");

  class DragData {
    store = new Map<string, string>();
    effectAllowed = "";
    dropEffect = "";
    constructor(entries: Record<string, string> = {}, readonly listTypes = false) {
      for (const [type, value] of Object.entries(entries)) this.store.set(type, value);
    }
    setData(type: string, value: string): void {
      this.store.set(type, value);
    }
    getData(type: string): string {
      return this.store.get(type) ?? "";
    }
    // WKWebView hands back a DOMStringList rather than an array.
    get types(): unknown {
      const types = [...this.store.keys()];
      if (!this.listTypes) return types;
      return { length: types.length, item: (i: number) => types[i], contains: (type: string) => types.includes(type) };
    }
    setDragImage(): void {}
  }

  function fire(el: Element, type: string, data: DragData): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    el.dispatchEvent(event);
    return event;
  }

  /// Drag a graph tab out of a pane of its own and return what it put on the
  /// wire, the way another window's drag arrives here.
  async function draggedGraph(): Promise<Record<string, string>> {
    const target = await renderPane(
      { kind: "leaf", id: "pane-source", tabs: [graphTab({ id: "g-src", scopeId: "src" })], activeTabId: "g-src" },
      { paneMode: false },
    );
    const data = new DragData();
    fire(target.querySelector('[draggable="true"]')!, "dragstart", data);
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = "";
    return Object.fromEntries(data.store);
  }

  async function renderTarget(): Promise<HTMLElement> {
    return renderPane(
      { kind: "leaf", id: "pane-here", tabs: [fileTab({ id: "here", path: "here.md" })], activeTabId: "here" },
      { paneMode: false },
    );
  }

  const SPOTS = [
    ["the tab strip", '[role="tablist"]'],
    ["a tab", '.tab[draggable="true"]'],
  ] as const;

  test("dragging a tab names this window, the pane, the side and the tab, and stamps this window's scope", async () => {
    const target = await renderTarget();
    const data = new DragData();

    fire(target.querySelector('.tab[draggable="true"]')!, "dragstart", data);

    expect(JSON.parse(data.getData(TAB_MIME))).toEqual({
      fromPaneId: "pane-here",
      fromSide: "a",
      tabId: "here",
      fromWindow: sessionWindowId(),
    });
    expect(data.getData(OURS)).toBe("1");
    expect(OURS.slice(SCOPE_PREFIX.length)).toMatch(/^[0-9a-f]+$/);
  });

  test.each(SPOTS)("hovering %s refuses a tab from another scope and accepts one from this scope", async (_spot, selector) => {
    const target = await renderTarget();
    const spot = target.querySelector(selector)!;

    const foreign = new DragData({ [TAB_MIME]: "{}", [THEIRS]: "1" });
    expect(fire(spot, "dragover", foreign).defaultPrevented).toBe(false);
    expect(foreign.dropEffect).toBe("none");

    const ours = new DragData({ [TAB_MIME]: "{}", [OURS]: "1" }, true);
    expect(fire(spot, "dragover", ours).defaultPrevented).toBe(true);
    expect(ours.dropEffect).toBe("move");
  });

  test.each(SPOTS)("a drop on %s from another window is claimed only when its scope matches and the tab rebuilds", async (_spot, selector) => {
    const wire = await draggedGraph();
    const foreignTab = JSON.stringify({ ...JSON.parse(wire[TAB_MIME]!), fromWindow: "another-window" });
    const target = await renderTarget();
    const spot = () => target.querySelector(selector)!;
    const kinds = () => (layout.nodes["pane-here"] as LeafNode).tabs.map((tab) => tab.kind);

    const otherScope = fire(spot(), "drop", new DragData({ [TAB_MIME]: foreignTab, [CROSS_MIME]: wire[CROSS_MIME]!, [THEIRS]: "1" }));
    expect(otherScope.defaultPrevented).toBe(false);
    const unbuildable = fire(spot(), "drop", new DragData({ [TAB_MIME]: foreignTab, [CROSS_MIME]: JSON.stringify({ kind: "zzz" }), [OURS]: "1" }));
    expect(unbuildable.defaultPrevented).toBe(false);
    expect(kinds()).toEqual(["file"]);

    const adopted = fire(spot(), "drop", new DragData({ [TAB_MIME]: foreignTab, [CROSS_MIME]: wire[CROSS_MIME]!, [OURS]: "1" }));
    expect(adopted.defaultPrevented).toBe(true);
    expect(kinds()).toEqual(["file", "graph"]);
  });

  test("a drop from another window whose pane id matches a pane here is adopted, not treated as a local move", async () => {
    const wire = await draggedGraph();
    const collidingTab = JSON.stringify({ fromPaneId: "pane-here", fromSide: "a", tabId: "here", fromWindow: "another-window" });
    const target = await renderTarget();

    fire(target.querySelector('[role="tablist"]')!, "drop", new DragData({ [TAB_MIME]: collidingTab, [CROSS_MIME]: wire[CROSS_MIME]!, [OURS]: "1" }));

    expect((layout.nodes["pane-here"] as LeafNode).tabs.map((tab) => tab.kind)).toEqual(["file", "graph"]);
  });

  test("a drop from this window moves the tab from its pane", async () => {
    const target = await renderTarget();
    layout.nodes["pane-there"] = { kind: "leaf", id: "pane-there", tabs: [fileTab({ id: "there", path: "there.md" })], activeTabId: "there" };
    const localTab = JSON.stringify({ fromPaneId: "pane-there", fromSide: "a", tabId: "there", fromWindow: sessionWindowId() });

    const drop = fire(target.querySelector('[role="tablist"]')!, "drop", new DragData({ [TAB_MIME]: localTab, [OURS]: "1" }));

    expect(drop.defaultPrevented).toBe(true);
    expect((layout.nodes["pane-here"] as LeafNode).tabs.map((tab) => tab.id)).toEqual(["here", "there"]);
    expect((layout.nodes["pane-there"] as LeafNode | undefined)?.tabs ?? []).toEqual([]);
  });
});

describe("Pane cross-window transfer of view-state tab kinds", () => {
  // The regression: crossWindowPayload's catch-all returned
  // `{ kind: "terminal" }` for every kind it did not list, so dragging a graph
  // tab to another window declared it a terminal. The target read a terminal
  // with no session id, opened a FRESH one, and the accepted drop then closed
  // the original -- a graph went in, a terminal came out. Every kind now
  // carries something the target can rebuild.
  const CROSS_TAB_MIME = "application/x-chan-tab+json";

  class FakeDataTransfer {
    store = new Map<string, string>();
    effectAllowed = "";
    dropEffect = "";
    setData(type: string, value: string): void {
      this.store.set(type, value);
    }
    getData(type: string): string {
      return this.store.get(type) ?? "";
    }
    get types(): string[] {
      return [...this.store.keys()];
    }
    setDragImage(): void {}
  }

  /// Drag the pane's only tab and return what the drag put on the wire.
  async function dragPayload(tab: Tab): Promise<Record<string, any>> {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-drag",
      tabs: [tab],
      activeTabId: tab.id,
    };
    const target = await renderPane(pane, { paneMode: false });
    const tabEl = target.querySelector<HTMLElement>('[draggable="true"]');
    expect(tabEl, `${tab.kind} tab renders draggable`).not.toBeNull();
    const dt = new FakeDataTransfer();
    const event = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dt });
    tabEl!.dispatchEvent(event);
    const raw = dt.getData(CROSS_TAB_MIME);
    expect(raw, `${tab.kind} offers a cross-window payload`).not.toBe("");
    return JSON.parse(raw);
  }

  test("a graph tab crosses as a graph, not a terminal", async () => {
    const payload = await dragPayload(
      graphTab({
        mode: "filesystem",
        scopeId: "src",
        depth: 3,
        inspectorOpen: true,
      }),
    );
    expect(payload.kind).toBe("graph");
    expect(payload.kind).not.toBe("terminal");
  });

  test.each([
    ["browser", browserTab({ inspectorOpen: true })],
    ["dashboard", dashboardTab({ carouselSlide: 2 })],
  ])("a %s tab crosses as itself", async (label, tab) => {
    const payload = await dragPayload(tab as Tab);
    expect(payload.kind).toBe(label);
    expect(payload.ser).toBeTruthy();
  });

  test("a graph tab rebuilt in the target keeps its view state", () => {
    // The round trip that matters: snapshot on the source, adopt in the
    // target. Rebuilt through the same restore path a reload uses.
    const source = graphTab({
      mode: "filesystem",
      scopeId: "src",
      depth: 3,
      inspectorOpen: true,
    });
    layout.nodes = {
      "pane-target": {
        kind: "leaf",
        id: "pane-target",
        tabs: [],
        activeTabId: null,
      },
    };
    layout.rootId = "pane-target";
    // Read the tab back through `layout`: it is $state, so the stored node is
    // a reactive proxy and the literal above is not the object adopt mutates.
    const targetPane = layout.nodes["pane-target"] as LeafNode;

    const adopted = adoptCrossWindowTab(
      targetPane.id,
      crossWindowTabSnapshot(source),
    );

    expect(adopted?.kind).toBe("graph");
    const graph = adopted as GraphTab;
    expect(graph.mode).toBe("filesystem");
    expect(graph.scopeId).toBe("src");
    expect(graph.depth).toBe(3);
    expect(graph.inspectorOpen).toBe(true);
    // A fresh id, so a move can never collide with a tab already live here.
    expect(graph.id).not.toBe(source.id);
    expect(targetPane.tabs).toHaveLength(1);
    expect(targetPane.activeTabId).toBe(graph.id);
  });

  test("an unrebuildable snapshot is refused instead of swallowing the tab", () => {
    layout.nodes = {
      "pane-refuse": {
        kind: "leaf",
        id: "pane-refuse",
        tabs: [],
        activeTabId: null,
      },
    };
    layout.rootId = "pane-refuse";
    const targetPane = layout.nodes["pane-refuse"] as LeafNode;

    // A kind this build cannot rebuild (peer window on another version).
    expect(adoptCrossWindowTab("pane-refuse", { k: "z" } as any)).toBeNull();
    expect(targetPane.tabs).toHaveLength(0);
  });
});

describe("Pane staged editor chips", () => {
  test("renders queued labels after real tabs in queue order", async () => {
    const real = terminalTab({ id: "term-real", title: "Real terminal" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-staged-editors",
      tabs: [real],
      activeTabId: real.id,
    };
    const target = await renderPane(pane);

    paneModeStageDraftEditor();
    paneModeStageDiagramEditor();
    paneModeStageDraftEditor();
    await tick();

    const labels = [
      ...target.querySelectorAll<HTMLElement>(".tabs > .tab .path"),
    ].map((element) => element.textContent?.trim());
    expect(labels).toEqual([
      "Real terminal",
      "New draft",
      "New diagram",
      "New draft",
    ]);
    expect(
      new Set(paneMode.stagedDraftEditors.map((intent) => intent.id)).size,
    ).toBe(3);
  });

  test("removes only the chosen keyed chip without selecting it", async () => {
    const real = terminalTab({ id: "term-selected", title: "Selected" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-remove-staged-editor",
      tabs: [real],
      activeTabId: real.id,
    };
    const target = await renderPane(pane);

    paneModeStageDraftEditor();
    paneModeStageDiagramEditor();
    await tick();

    const chips = target.querySelectorAll<HTMLElement>(".staged-editor");
    const diagramChip = chips[1];
    expect(diagramChip?.getAttribute("role")).toBeNull();
    expect(diagramChip?.getAttribute("tabindex")).toBeNull();
    expect(diagramChip?.getAttribute("aria-selected")).toBeNull();

    chips[0]?.querySelector<HTMLButtonElement>(".close")?.click();
    await tick();

    const remaining = target.querySelectorAll<HTMLElement>(".staged-editor");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(diagramChip);
    expect(remaining[0]?.querySelector(".path")?.textContent?.trim()).toBe(
      "New diagram",
    );
    expect(paneMode.draft?.nodes[pane.id]).toMatchObject({
      activeTabId: real.id,
    });
  });

  test("dims staged tabs and disables removal while stale", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-stale-staged-editor",
      tabs: [],
      activeTabId: null,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    layout.focusColor = "blue";
    enterPaneMode();
    paneModeOpenBrowser();
    paneModeStageDraftEditor();
    paneMode.stale = true;

    const draftPane = paneMode.draft?.nodes[pane.id];
    if (!draftPane || draftPane.kind !== "leaf")
      throw new Error("expected draft leaf");
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(Pane, { target, props: { pane: draftPane } });
    mounted.push(component);
    await tick();

    const staged = target.querySelectorAll<HTMLElement>(".tab.staged");
    expect(staged).toHaveLength(2);
    expect([...staged].every((tab) => tab.classList.contains("stale"))).toBe(
      true,
    );
    const close = target.querySelector<HTMLButtonElement>(
      ".staged-editor .close",
    );
    expect(close?.disabled).toBe(true);
    close?.click();
    await tick();
    expect(paneMode.stagedDraftEditors).toHaveLength(1);
    expect(
      target.querySelector(".pane-mode-preview")?.textContent?.trim(),
    ).toBe("Layout changed. Esc to discard.");
  });
});
