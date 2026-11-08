// @vitest-environment jsdom
//
// The pane strip under the window tab bar mode: no pane draws its strip in
// place; the active pane's strip element moves into the bar's slot with its
// handlers, every other pane's is hidden, a focus change (Hybrid Nav's
// staged one included) moves it, and leaving the mode or destroying the pane
// puts it back where it was. A pane with no strip leaves the slot empty.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import Pane from "./Pane.svelte";
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

  test("a tmux pane leaves the bar with no strip to show", async () => {
    splitLayout(
      [terminalTab({ id: "tmux", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })],
      [terminalTab({ id: "plain" })],
    );
    barOn();
    await renderPanes("left", "right");
    expect(barStrips()[0]?.classList.contains("control-hidden")).toBe(true);
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
