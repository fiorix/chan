// @vitest-environment jsdom
//
// A tab strip whose tabs need more room than it has. Only the tabs scroll,
// in a viewport of their own; the dead zone and the actions stay outside it.
// While the tabs overflow a scroll button stands on each side of them, each
// reading as disabled at its end and paging the tabs its way; a vertical
// wheel scrolls them sideways, a drag held over a button scrolls them, and
// the active tab is brought into view by its nearest edge. The strip in the
// window tab bar behaves the same. jsdom lays nothing out, so each test sets
// the viewport's widths and scroll offset itself and fires the scroll event
// a browser would.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import Pane from "./Pane.svelte";
import { cancelPaneMode, layout, selectTabInPane, type LeafNode } from "../state/tabs.svelte";
import { persistStateToHash } from "../state/store.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { terminalTab } from "../__tests__/tabs";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

/// Records what each observer watches, so a test can deliver the resize a
/// browser would after a layout change.
class TestResizeObserver {
  static all = new Set<TestResizeObserver>();
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.all.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
    TestResizeObserver.all.delete(this);
  }
}

async function resized(target: Element): Promise<void> {
  for (const observer of TestResizeObserver.all) {
    if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver);
  }
  await tick();
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

const FILE_MIME = "application/x-md-file";
const TAB_WIDTH = 100;
const ROW_PADDING = 4;

const mounted: Record<string, unknown>[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  windowTabBar.on = false;
  windowTabBar.slot = null;
  cancelPaneMode();
  document.body.innerHTML = "";
  delete (window as W).__TAURI_INTERNALS__;
  persistStateToHash();
});

/// One pane of `count` terminal tabs, the first active, mounted as the
/// window shows it.
async function renderPane(count: number): Promise<HTMLElement> {
  const tabs = Array.from({ length: count }, (_, i) => terminalTab({ id: `t${i}`, title: `tab ${i}` }));
  const pane: LeafNode = { kind: "leaf", id: "pane-overflow", tabs, activeTabId: "t0" };
  layout.nodes = { [pane.id]: pane };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.focusColor = "blue";
  cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const live = layout.nodes[pane.id] as LeafNode;
  mounted.push(mount(Pane, { target, props: { pane: live } }) as Record<string, unknown>);
  await tick();
  return target;
}

type Viewport = {
  view: HTMLElement;
  geometry: { scrollWidth: number; clientWidth: number; widths: number[] };
  /// Scroll to `left` and fire the scroll event, as the browser would.
  scrollTo(left: number): Promise<void>;
  /// Fire the scroll event without moving, for a change of widths.
  remeasure(): Promise<void>;
};

/// Lay out the strip's viewport: `clientWidth` of room, tabs of TAB_WIDTH
/// (or `widths`) side by side after the row's padding, and a scroll offset
/// clamped to the range, as a browser keeps it. Smooth paging lands at once.
function layOut(strip: Element, clientWidth: number): Viewport {
  const view = strip.querySelector<HTMLElement>(".tab-scroll");
  if (!view) throw new Error("the strip has no tab viewport");
  const count = view.querySelectorAll(".tab").length;
  const widths = Array.from({ length: count }, () => TAB_WIDTH);
  const geometry = { scrollWidth: count * TAB_WIDTH + 2 * ROW_PADDING, clientWidth, widths };
  let left = 0;
  Object.defineProperties(view, {
    scrollWidth: { configurable: true, get: () => geometry.scrollWidth },
    clientWidth: { configurable: true, get: () => geometry.clientWidth },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, Math.min(value, geometry.scrollWidth - geometry.clientWidth));
      },
    },
  });
  view.scrollBy = ((options: ScrollToOptions) => {
    view.scrollLeft += options.left ?? 0;
    view.dispatchEvent(new Event("scroll"));
  }) as typeof view.scrollBy;
  view.getBoundingClientRect = () => new DOMRect(0, 0, geometry.clientWidth, 24);
  view.querySelectorAll<HTMLElement>(".tab").forEach((tab, i) => {
    tab.getBoundingClientRect = () => {
      const start = ROW_PADDING + widths.slice(0, i).reduce((sum, width) => sum + width, 0);
      return new DOMRect(start - left, 0, widths[i], 24);
    };
  });
  const remeasure = async () => {
    view.dispatchEvent(new Event("scroll"));
    await tick();
  };
  return {
    view,
    geometry,
    async scrollTo(next: number) {
      view.scrollLeft = next;
      await remeasure();
    },
    remeasure,
  };
}

function strip(target: ParentNode): HTMLElement {
  const element = target.querySelector<HTMLElement>(".tabs");
  if (!element) throw new Error("no strip");
  return element;
}

function button(target: ParentNode, side: "left" | "right"): HTMLButtonElement | null {
  return target.querySelector<HTMLButtonElement>(`.tab-scroll-button.${side}`);
}

/// A drag of a file-tree file, which every strip takes.
function dragEvent(type: string, relatedTarget: EventTarget | null = null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { types: [FILE_MIME], dropEffect: "", getData: () => "" } },
    relatedTarget: { value: relatedTarget },
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  return event;
}

describe("a strip whose tabs fit", () => {
  test("draws no scroll button, and its dead zone and actions sit outside the tabs' viewport", async () => {
    const target = await renderPane(3);
    const { view, remeasure } = layOut(strip(target), 600);
    await remeasure();

    expect(target.querySelector(".tab-scroll-button")).toBeNull();
    expect(view.querySelectorAll(".tab")).toHaveLength(3);
    for (const outside of [".dead-zone", ".actions", ".side-toggle", ".hamburger-trigger"]) {
      const element = strip(target).querySelector(outside);
      expect(element, `${outside} is in the strip`).not.toBeNull();
      expect(view.contains(element), `${outside} stays out of the scrolling viewport`).toBe(false);
    }
    expect(view.parentElement, "the viewport is the strip's own child").toBe(strip(target));
    expect(strip(target).lastElementChild?.classList.contains("actions"), "the actions end the strip").toBe(true);
  });

  test("the dead zone keeps its attributes, and in place nothing drags the window", async () => {
    const target = await renderPane(3);
    const deadZone = strip(target).querySelector<HTMLElement>(":scope > .dead-zone");
    expect(deadZone?.getAttribute("aria-hidden")).toBe("true");
    expect(deadZone?.nextElementSibling?.classList.contains("actions")).toBe(true);
    expect(strip(target).querySelector("[data-tauri-drag-region]")).toBeNull();
  });
});

describe("a strip whose tabs overflow", () => {
  test("draws a scroll button on each side of the tabs, each disabled at its end", async () => {
    const target = await renderPane(9);
    const { view, scrollTo, remeasure } = layOut(strip(target), 300);
    await remeasure();

    const left = button(target, "left");
    const right = button(target, "right");
    expect(left?.nextElementSibling, "the left button comes before the tabs").toBe(view);
    expect(view.nextElementSibling, "the right button comes after them").toBe(right);
    expect(right?.nextElementSibling?.classList.contains("dead-zone")).toBe(true);
    expect(left?.getAttribute("aria-label")).toBe("Scroll tabs left");
    expect(right?.getAttribute("aria-label")).toBe("Scroll tabs right");
    expect(left?.tabIndex, "the buttons stay out of the Tab order").toBe(-1);
    expect(right?.tabIndex).toBe(-1);
    expect(left?.getAttribute("aria-disabled"), "at the start").toBe("true");
    expect(right?.getAttribute("aria-disabled")).toBe("false");

    await scrollTo(250);
    expect(left?.getAttribute("aria-disabled"), "in the middle").toBe("false");
    expect(right?.getAttribute("aria-disabled")).toBe("false");

    await scrollTo(view.scrollWidth - view.clientWidth);
    expect(left?.getAttribute("aria-disabled"), "at the end").toBe("false");
    expect(right?.getAttribute("aria-disabled")).toBe("true");
  });

  test("a press on a button pages the tabs its way and leaves focus where it is", async () => {
    const target = await renderPane(9);
    const { view, remeasure } = layOut(strip(target), 300);
    await remeasure();

    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    button(target, "right")!.dispatchEvent(press);
    expect(press.defaultPrevented, "the press does not take focus").toBe(true);

    button(target, "right")!.click();
    await tick();
    expect(view.scrollLeft).toBe(240);
    button(target, "right")!.click();
    await tick();
    expect(view.scrollLeft).toBe(480);
    button(target, "left")!.click();
    await tick();
    expect(view.scrollLeft).toBe(240);
    button(target, "left")!.click();
    await tick();
    expect(view.scrollLeft).toBe(0);
    expect(button(target, "left")?.getAttribute("aria-disabled")).toBe("true");
  });

  test("the buttons go when the tabs fit again, also when they fit only in the buttons' room", async () => {
    const target = await renderPane(9);
    const viewport = layOut(strip(target), 300);
    await viewport.remeasure();
    expect(button(target, "left")).not.toBeNull();

    // Each button is 20px with a 2px gap: without them the viewport would
    // be 44px wider, enough for 330px of tabs.
    button(target, "left")!.getBoundingClientRect = () => new DOMRect(-22, 0, 20, 24);
    button(target, "right")!.getBoundingClientRect = () => new DOMRect(302, 0, 20, 24);
    viewport.geometry.scrollWidth = 330;
    await viewport.remeasure();
    expect(target.querySelector(".tab-scroll-button")).toBeNull();

    viewport.geometry.scrollWidth = 900;
    await viewport.remeasure();
    expect(button(target, "left"), "back when the tabs overflow again").not.toBeNull();
  });

  test("a vertical wheel over the tabs scrolls them sideways; a sideways one and a pinch are left to the browser", async () => {
    const target = await renderPane(9);
    const { view, remeasure } = layOut(strip(target), 300);
    await remeasure();

    const down = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    view.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(view.scrollLeft).toBe(120);

    const lines = new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true });
    view.dispatchEvent(lines);
    expect(view.scrollLeft, "a wheel that counts lines moves 16px a line").toBe(72);

    const sideways = new WheelEvent("wheel", { deltaX: 40, deltaY: 5, bubbles: true, cancelable: true });
    view.dispatchEvent(sideways);
    expect(sideways.defaultPrevented).toBe(false);
    expect(view.scrollLeft).toBe(72);

    const pinch = new WheelEvent("wheel", { deltaY: 30, ctrlKey: true, bubbles: true, cancelable: true });
    view.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(false);
    expect(view.scrollLeft).toBe(72);
  });

  test("a wheel over tabs that fit is left to the browser", async () => {
    const target = await renderPane(2);
    const { view, remeasure } = layOut(strip(target), 600);
    await remeasure();
    const down = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    view.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(view.scrollLeft).toBe(0);
  });

  test("the active tab comes into view by its nearest edge, and a visible one moves nothing", async () => {
    const target = await renderPane(9);
    const { view, remeasure } = layOut(strip(target), 300);
    await remeasure();

    // Tab 5 spans 504..604: brought in by its right edge, 4px from the end.
    selectTabInPane("pane-overflow", "t5");
    await tick();
    expect(view.scrollLeft).toBe(308);

    // Tab 4 spans 404..504, already inside the view at 312..604.
    selectTabInPane("pane-overflow", "t4");
    await tick();
    expect(view.scrollLeft).toBe(308);

    // Tab 1 spans 104..204: brought in by its left edge.
    selectTabInPane("pane-overflow", "t1");
    await tick();
    expect(view.scrollLeft).toBe(100);
  });

  test("a tab that grows keeps the active tab in view only while it was in view", async () => {
    const target = await renderPane(9);
    const { view, geometry, scrollTo, remeasure } = layOut(strip(target), 300);
    await remeasure();
    const row = view.querySelector(".tab-row")!;

    selectTabInPane("pane-overflow", "t8");
    await tick();
    expect(view.scrollLeft).toBe(608);

    // The active last tab's title arrives and it grows 20px.
    geometry.widths[8] = 120;
    geometry.scrollWidth += 20;
    await resized(row);
    expect(view.scrollLeft, "the grown active tab stays whole").toBe(628);

    // Scrolled away from it, a growth leaves the scroll where it is.
    await scrollTo(0);
    geometry.widths[8] = 140;
    geometry.scrollWidth += 20;
    await resized(row);
    expect(view.scrollLeft).toBe(0);

    // A viewport that changes width brings the active tab back.
    geometry.clientWidth = 280;
    await resized(view);
    expect(view.scrollLeft).toBe(geometry.scrollWidth - geometry.clientWidth);
  });

  test("a drag held over a button scrolls the tabs until the drag leaves it", async () => {
    const target = await renderPane(9);
    const { view, remeasure } = layOut(strip(target), 300);
    await remeasure();
    const right = button(target, "right")!;

    right.dispatchEvent(dragEvent("dragenter"));
    const over = dragEvent("dragover");
    right.dispatchEvent(over);
    expect(over.defaultPrevented, "the strip takes the drag over the button").toBe(true);
    await tick();
    expect(strip(target).classList.contains("drop-active")).toBe(true);
    expect(target.querySelector(".drop-bar"), "no drop bar while over a button").toBeNull();

    await vi.waitFor(() => expect(view.scrollLeft).toBeGreaterThan(20));
    right.dispatchEvent(dragEvent("dragleave", strip(target)));
    const stoppedAt = view.scrollLeft;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(view.scrollLeft, "leaving the button stops the scroll").toBe(stoppedAt);

    // Back over the left button, the tabs scroll to the start and stop.
    const left = button(target, "left")!;
    left.dispatchEvent(dragEvent("dragover"));
    await vi.waitFor(() => expect(view.scrollLeft).toBe(0));
    left.dispatchEvent(dragEvent("dragleave", strip(target)));
  });

  test("the drag's end stops the scroll", async () => {
    const target = await renderPane(9);
    const { view, remeasure } = layOut(strip(target), 300);
    await remeasure();

    button(target, "right")!.dispatchEvent(dragEvent("dragover"));
    await vi.waitFor(() => expect(view.scrollLeft).toBeGreaterThan(0));
    document.dispatchEvent(new Event("dragend"));
    const stoppedAt = view.scrollLeft;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(view.scrollLeft).toBe(stoppedAt);
  });
});

describe("the strip in the window tab bar", () => {
  test("scrolls its tabs alone, with the buttons, the dead zone and the actions in the bar", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: async () => null } });
    const slot = document.createElement("div");
    document.body.append(slot);
    windowTabBar.slot = slot;
    windowTabBar.on = true;
    await renderPane(9);

    const inBar = slot.querySelector<HTMLElement>(":scope > .tabs");
    expect(inBar?.classList.contains("in-bar")).toBe(true);
    const { view, remeasure } = layOut(inBar!, 300);
    await remeasure();

    expect(button(inBar!, "left")?.getAttribute("aria-disabled")).toBe("true");
    expect(button(inBar!, "right")?.getAttribute("aria-disabled")).toBe("false");
    const deadZone = inBar!.querySelector<HTMLElement>(":scope > .dead-zone");
    expect(deadZone?.getAttribute("data-tauri-drag-region"), "the dead zone still drags the window").toBe("");
    expect(view.getAttribute("data-tauri-drag-region"), "so does the space between tabs").toBe("");
    expect(view.querySelector(".tab-row")?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(button(inBar!, "right")?.hasAttribute("data-tauri-drag-region"), "a press on a button never drags").toBe(false);
    expect(view.contains(inBar!.querySelector(".actions"))).toBe(false);

    button(inBar!, "right")!.click();
    await tick();
    expect(view.scrollLeft).toBe(240);

    selectTabInPane("pane-overflow", "t8");
    await tick();
    expect(view.scrollLeft, "the last tab comes in by its right edge").toBe(view.scrollWidth - view.clientWidth);
    expect(button(inBar!, "right")?.getAttribute("aria-disabled")).toBe("true");
  });
});
