// @vitest-environment jsdom
//
// A pane marks the sides it has on the window's edge, where it draws flush,
// and whether its strip takes its top, which keeps a terminal's body off that
// side. The marks follow the layout: a split takes the shared side from both
// panes, and closing one hands every side back to the pane left.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import Pane from "./Pane.svelte";
import { activeLayout, layout, type Tab } from "../state/tabs.svelte";
import { __testSetStandalonePreferences, persistStateToHash } from "../state/store.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { preferences } from "../__tests__/standalone";
import { terminalTab } from "../__tests__/tabs";

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

const mounted: Record<string, unknown>[] = [];

afterEach(async () => {
  for (const component of mounted) await unmount(component);
  mounted.length = 0;
  windowTabBar.on = false;
  windowTabBar.slot = null;
  document.body.innerHTML = "";
  __testSetStandalonePreferences(null);
  persistStateToHash();
});

function lonePane(tabs: Tab[]): void {
  layout.nodes = { only: { kind: "leaf", id: "only", tabs, activeTabId: tabs[0]?.id ?? null } };
  layout.rootId = "only";
  layout.activePaneId = "only";
  layout.focusColor = "blue";
}

/// `first` and `second` side by side in a row, or stacked in a column.
function splitLayout(direction: "row" | "column"): void {
  layout.nodes = {
    root: { kind: "split", id: "root", direction, ratio: 0.5, a: "first", b: "second" },
    first: { kind: "leaf", id: "first", tabs: [terminalTab({ id: "t1" })], activeTabId: "t1" },
    second: { kind: "leaf", id: "second", tabs: [terminalTab({ id: "t2" })], activeTabId: "t2" },
  };
  layout.rootId = "root";
  layout.activePaneId = "first";
  layout.focusColor = "blue";
}

async function renderPanes(...ids: string[]): Promise<void> {
  for (const id of ids) {
    const pane = activeLayout().nodes[id];
    if (pane?.kind !== "leaf") throw new Error(`no leaf ${id}`);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  }
  await tick();
}

function paneEl(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
  if (!element) throw new Error(`no pane ${id}`);
  return element;
}

/// The sides the pane marks as the window's edge, clockwise from the top.
function edges(id: string): string {
  const classes = paneEl(id).classList;
  return ["top", "right", "bottom", "left"].filter((side) => classes.contains(`edge-${side}`)).join(" ");
}

describe("a pane's window edges", () => {
  test("a window's only pane is flush on every side", async () => {
    lonePane([terminalTab({ id: "t1" })]);
    await renderPanes("only");

    expect(edges("only")).toBe("top right bottom left");
    expect(paneEl("only").classList.contains("sole")).toBe(true);
  });

  test("panes side by side keep the gap between them", async () => {
    splitLayout("row");
    await renderPanes("first", "second");

    expect(edges("first")).toBe("top bottom left");
    expect(edges("second")).toBe("top right bottom");
    expect(paneEl("first").classList.contains("sole")).toBe(false);
  });

  test("stacked panes keep the gap between them", async () => {
    splitLayout("column");
    await renderPanes("first", "second");

    expect(edges("first")).toBe("top right left");
    expect(edges("second")).toBe("right bottom left");
  });

  test("the pane left after a close takes every side back", async () => {
    splitLayout("row");
    await renderPanes("first");
    expect(edges("first")).toBe("top bottom left");

    layout.rootId = "first";
    delete layout.nodes.root;
    delete layout.nodes.second;
    await tick();

    expect(edges("first")).toBe("top right bottom left");
    expect(paneEl("first").classList.contains("sole")).toBe(true);
  });
});

describe("a pane's strip mark", () => {
  test("a strip drawn in place takes the pane's top", async () => {
    lonePane([terminalTab({ id: "t1" })]);
    await renderPanes("only");

    expect(paneEl("only").classList.contains("has-strip")).toBe(true);
  });

  test("the window tab bar leaves the pane's top to the body", async () => {
    lonePane([terminalTab({ id: "t1" })]);
    windowTabBar.on = true;
    await renderPanes("only");

    expect(paneEl("only").classList.contains("has-strip")).toBe(false);
  });

  test("an auto-hidden strip leaves the pane's top to the body", async () => {
    __testSetStandalonePreferences(preferences({ pane_strip_auto_hide: true }));
    lonePane([terminalTab({ id: "t1" })]);
    await renderPanes("only");

    expect(paneEl("only").classList.contains("has-strip")).toBe(false);
  });
});
