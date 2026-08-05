// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

// Static top-level component import (not a per-test `await import(...)`).
// The flake was the dynamic import inside `renderPane` timing out (30s)
// under the full parallel suite, where Svelte-component transform/import
// is contended across workers - not an assertion or shared-state race.
// Resolving the module once at module-eval matches the non-flaky
// TerminalTeamWork.test.ts pattern and takes the import off the timed
// path.
import Pane from "./Pane.svelte";
import paneSource from "./Pane.svelte?raw";
import {
  cancelPaneMode,
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
  paneSide,
  paneSideToggleFlash,
  requestPaneSideToggleFlash,
  splitPane,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";
import { ui } from "../state/store.svelte";

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

function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
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

  test("pane hamburger uses the launcher registry chord label", () => {
    expect(paneSource).toMatch(
      /dispatchCommand\("app\.launcher\.toggle"\)[\s\S]{1,300}<span class="menu-row-label">Commands<\/span>[\s\S]{1,200}chordLabel\("app\.launcher\.toggle"\)/,
    );
  });

  test("reopen-tab listener matches the advertised Ctrl+Alt+Shift+T chord", () => {
    expect(paneSource).toMatch(
      /e\.ctrlKey &&\s*e\.altKey &&\s*e\.shiftKey &&\s*!e\.metaKey &&\s*e\.code === "KeyT"[\s\S]{0,80}reopenClosedTab\(\)/,
    );
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
    Object.defineProperty(end, "animationName", {
      configurable: true,
      value: "pane-side-toggle-flash",
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

  test("flip cleanup tolerates scoped keyframe names and outlasts the animation", () => {
    expect(paneSource).toMatch(
      /e\.animationName\.includes\("pane-side-flip"\)/,
    );
    expect(paneSource).toMatch(
      /e\.animationName\.includes\("pane-wobble-once"\)/,
    );
    expect(paneSource).toMatch(
      /e\.animationName\.includes\("pane-side-toggle-flash"\)/,
    );
    expect(paneSource).toMatch(/SIDE_FLIP_DURATION_MS = 520/);
    expect(paneSource).toContain("}, SIDE_FLIP_DURATION_MS + 80);");
  });

  test("flip axis follows pane dimensions", () => {
    expect(paneSource).toMatch(/if \(height > width\) return "vertical"/);
    expect(paneSource).toMatch(/if \(width > height\) return "horizontal"/);
    expect(paneSource).toMatch(
      /return Math\.random\(\) < 0\.5 \? "vertical" : "horizontal"/,
    );
    expect(paneSource).toMatch(/axis === "vertical" \? "rotateY" : "rotateX"/);
    expect(paneSource).toMatch(/class:sideFlipActive=\{sideFlipActive\}/);
    expect(paneSource).toContain(
      "sideFlipStartTransform = `${rotate}(-180deg)`;",
    );
    expect(paneSource).toContain(
      "sideFlipBackTransform = `${rotate}(-180deg)`;",
    );
    expect(paneSource).not.toMatch(/from === "a" && to === "b"/);
    expect(paneSource).toContain('class="pane-card-inner"');
    expect(paneSource).toMatch(/backface-visibility: hidden/);
    expect(paneSource).toMatch(/@keyframes pane-side-flip/);
  });

  test("tab label fade is gated on measured overflow", () => {
    const basePathBlock =
      paneSource.match(/\.path \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(paneSource).toContain("use:tabPathOverflow={label}");
    expect(paneSource).toMatch(/scrollWidth > node\.clientWidth \+ 1/);
    expect(paneSource).toMatch(/\.path\.overflowing \{[\s\S]*?mask-image:/);
    expect(basePathBlock).not.toContain("mask-image");
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

  test("dead-zone uses manual mousedown + threshold tracking, not HTML5 dragstart", () => {
    // The per-tab DnD on each `.tab` already owns HTML5 drag for
    // inter-pane tab moves. The dead-zone interaction has to use
    // manual mousedown + a window-level mousemove threshold so the
    // tab-DnD pipeline stays untouched. Pin the wiring shape.
    expect(paneSource).toContain('class="dead-zone"');
    expect(paneSource).toContain("onmousedown={onDeadZoneMouseDown}");
    expect(paneSource).toContain("ondblclick={onDeadZoneDblClick}");
    expect(paneSource).toMatch(/DEAD_ZONE_DRAG_THRESHOLD_PX\s*=\s*5/);
    // The dead-zone element itself must NOT be draggable=true (that
    // would route through HTML5 drag and collide with per-tab DnD).
    expect(paneSource).not.toMatch(
      /class="dead-zone"[\s\S]{0,200}draggable="true"/,
    );
  });
});

describe("Pane Hybrid NAV mouse edge splits", () => {
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

  test("zone classification runs on pane mousemove through the pure helper", () => {
    expect(paneSource).toContain("onmousemove={onPaneBodyMouseMove}");
    expect(paneSource).toMatch(/classifyMouseSplitZone\(/);
    expect(paneSource).toMatch(/edgeSplitAllowed\(/);
  });

  test("the split preview styles tint the half the moved content would occupy", () => {
    expect(paneSource).toMatch(/\.pane\.transaction-split-left::before \{ inset: 0 50% 0 0; \}/);
    expect(paneSource).toMatch(/\.pane\.transaction-split-right::before \{ inset: 0 0 0 50%; \}/);
    expect(paneSource).toMatch(/\.pane\.transaction-split-top::before \{ inset: 0 0 50% 0; \}/);
    expect(paneSource).toMatch(/\.pane\.transaction-split-bottom::before \{ inset: 50% 0 0 0; \}/);
  });
});

describe("Pane cross-window tab DnD (pane-id collision fix)", () => {
  test("the drag payload carries the originating window", () => {
    // Pane ids are a per-window counter and collide across windows, so
    // the drop side must compare the originating window, not the pane id.
    expect(paneSource).toMatch(
      /TAB_DRAG_MIME,[\s\S]{1,160}fromWindow: sessionWindowId\(\)/,
    );
    expect(paneSource).toMatch(
      /JSON\.stringify\(\{ fromPaneId: pane\.id, fromSide, tabId, fromWindow: sessionWindowId\(\) \}\)/,
    );
    expect(paneSource).toMatch(
      /import \{\s*api,\s*dragScopeMimeToken,\s*sessionWindowId,\s*windowDragScope,\s*windowLibraryId,\s*\} from "\.\.\/api\/client"/,
    );
  });

  test("intra-window is decided by window identity, not pane-id presence", () => {
    expect(paneSource).toMatch(
      /function isIntraWindowDrag\(fromWindow: string \| undefined\): boolean \{[\s\S]{1,120}fromWindow === sessionWindowId\(\)/,
    );
    // Both tab-strip drop handlers gate the intra branch on the window
    // check (so a colliding stranger pane id falls through to the
    // cross-window adopt instead of a no-op moveTab).
    const intraGates = paneSource.match(
      /isIntraWindowDrag\(fromWindow\) && paneInThisWindow\(fromPaneId\)/g,
    );
    expect(intraGates?.length).toBe(2);
  });
});

describe("Pane cross-kind / cross-workspace tab DnD guard", () => {
  test("dragstart stamps the window's drag scope as a MIME type", () => {
    // The scope rides a MIME TYPE so the target can read it during dragover
    // (when payload values are not readable).
    expect(paneSource).toMatch(/scopeMime\(currentDragScope\(\)\), "1"/);
    expect(paneSource).toMatch(
      /import \{\s*api,\s*dragScopeMimeToken,\s*sessionWindowId,\s*windowDragScope,\s*windowLibraryId,\s*\} from "\.\.\/api\/client"/,
    );
  });

  test("scopeMime hex-encodes the scope so the MIME type round-trips in WKWebView", () => {
    // The human-readable scope carries `:`/`|`, which WKWebView mangles in a MIME
    // type; the scopeMime boundary hex-encodes via dragScopeMimeToken so the
    // stamped type comes back byte-identically at dragover (the intra-window-drag
    // regression fix -- without this, EVERY drop is rejected).
    expect(paneSource).toMatch(
      /const scopeMime = \(scope: string\): string =>\s*SCOPE_DRAG_MIME_PREFIX \+ dragScopeMimeToken\(scope\)/,
    );
  });

  test("the scope is computed from the owning library + the loaded workspace identity", () => {
    // currentDragScope keys on the chan-library (windowLibraryId) plus
    // workspace.info (metadata_key/root): two windows of one workspace in one
    // library match even with distinct `?w=w-<hex>` ids, while a workspace-key
    // collision across libraries stays rejected.
    expect(paneSource).toMatch(
      /currentDragScope = \(\): string =>[\s\S]{1,280}libraryId: windowLibraryId\(\),[\s\S]{1,220}workspace\.info\?\.metadata_key \?\? workspace\.info\?\.root/,
    );
  });

  test("compatibility is the source scope type matching THIS window's scope", () => {
    expect(paneSource).toMatch(
      /function isTabDragScopeCompatible\(e: DragEvent\): boolean \{[\s\S]{1,120}dragHasType\(e, scopeMime\(currentDragScope\(\)\)\)/,
    );
  });

  test("both dragover handlers reject an incompatible tab move (no-drop cursor)", () => {
    // Bail before preventDefault and force `dropEffect = "none"` so the
    // browser shows the no-drop cursor; file drags (not isTabMoveDrag) are
    // unaffected.
    expect(paneSource).toMatch(
      /function rejectTabMoveDrag\(e: DragEvent\): void \{[\s\S]{1,120}dropEffect = "none"/,
    );
    const overGates = paneSource.match(
      /if \(isTabMoveDrag\(e\) && !isTabDragScopeCompatible\(e\)\) \{[\s\S]{1,80}rejectTabMoveDrag\(e\);[\s\S]{1,80}return;/g,
    );
    expect(overGates?.length).toBe(2);
  });

  test("drag type lookup supports both Array and DOMStringList transfer types", () => {
    expect(paneSource).toMatch(
      /function dragHasType\(e: DragEvent, mime: string\): boolean \{[\s\S]*bag\.includes[\s\S]*bag\.contains[\s\S]*bag\[i\] === mime/,
    );
  });

  test("both drop handlers gate cross-window acceptance on scope compatibility", () => {
    // The guard sits immediately before acceptCrossWindowTab so an incompatible
    // drop returns without preventDefault (dropEffect "none" → source keeps it).
    const dropGates = paneSource.match(
      /if \(!isTabDragScopeCompatible\(e\)\) return;[\s\S]{1,120}acceptCrossWindowTab\(crossRaw\)/g,
    );
    expect(dropGates?.length).toBe(2);
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
