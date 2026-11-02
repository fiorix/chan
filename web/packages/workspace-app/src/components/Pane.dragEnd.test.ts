// @vitest-environment jsdom
//
// A tab dropped on an edge of the window's only pane splits that pane, and the
// split takes the layout root from it, so the root Workspace renders the pane
// anew and destroys the Pane the drag started in. The source's dragend still
// arrives, on the tab element that Pane rendered, after it is gone; it settles
// the drag by the pane and side recorded at dragstart and leaves nothing
// behind.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { clearRecentlyClosedTabsForTest, layout, localTabDropKeysForTest, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(demoData([]));
});

afterEach(async () => {
  clearRecentlyClosedTabsForTest();
  await settle();
  await unmountApp();
  vi.restoreAllMocks();
});

/// A drag's data as the page reads it: a dragover sees the types and not the
/// values, as a browser shows them.
class DragData {
  store = new Map<string, string>();
  protected = false;
  effectAllowed = "";
  dropEffect = "";
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.protected ? "" : (this.store.get(type) ?? "");
  }
  get types(): string[] {
    return [...this.store.keys()];
  }
  setDragImage(): void {}
}

function fire(el: Element, type: string, data: DragData, clientX = 0, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
  data.protected = type === "dragover" || type === "dragenter";
  try {
    el.dispatchEvent(event);
  } finally {
    data.protected = false;
  }
  return event;
}

function leaves(): LeafNode[] {
  return Object.values(layout.nodes).filter((node): node is LeafNode => node.kind === "leaf");
}

test("a pressed terminal tab dropped on the right edge of the only pane splits it, and its late dragend settles cleanly", async () => {
  resetLayout([terminalTab({ id: "first", terminalSessionId: "sess-first" }), terminalTab({ id: "second", terminalSessionId: "sess-second" })]);
  await settle();
  const tab = document.querySelectorAll<HTMLElement>('.tab[draggable="true"]')[1]!;
  const body = document.querySelector<HTMLElement>(".editor-wrap")!;
  body.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);

  const data = new DragData();
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  fire(tab, "dragstart", data);
  expect(fire(body, "dragover", data, 799, 300).defaultPrevented).toBe(true);
  expect(fire(body, "drop", data, 799, 300).defaultPrevented).toBe(true);
  await settle();
  expect(tab.isConnected, "the split destroyed the Pane that rendered the tab").toBe(false);

  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    errors.push(event.error ?? event.message);
  };
  window.addEventListener("error", onError);
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  try {
    fire(tab, "dragend", data);
    await settle();
  } finally {
    window.removeEventListener("error", onError);
  }

  expect.soft(errors).toEqual([]);
  expect.soft([...warn.mock.calls, ...error.mock.calls]).toEqual([]);
  expect.soft(leaves().map((pane) => pane.tabs.map((t) => t.id))).toEqual([["first"], ["second"]]);
  expect.soft(localTabDropKeysForTest()).toEqual([]);
});
