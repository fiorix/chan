// @vitest-environment jsdom
//
// The click that brings a window back to the front selects the pane under
// the cursor. On macOS the OS can take that first mousedown for the window's
// activation, so it never reaches the pane's own handler; App listens on the
// window in the capture phase and takes a mousedown that lands within 50 ms
// of the window regaining focus. Only that first click counts, and a focus
// with no click after it (Cmd+Tab) changes nothing.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { layout, splitPane } from "./state/tabs.svelte";

stubAppEnvironment();

let other: string;
let now = 0;

// Keeps the mousedown from the pane's own handler, the way the OS keeps an
// activation click, so only App's window listener can act on it.
function swallowBeforePanes(event: Event): void {
  event.stopPropagation();
}

beforeEach(async () => {
  await mountApp();
  resetLayout([fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })]);
  other = splitPane("pane-test", "row")!;
  layout.activePaneId = "pane-test";
  await settle();
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  document.addEventListener("mousedown", swallowBeforePanes, true);
});

afterEach(async () => {
  document.removeEventListener("mousedown", swallowBeforePanes, true);
  vi.restoreAllMocks();
  await unmountApp();
});

function paneElement(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`)!;
}

function clickAt(target: Element, at: number): void {
  now = at;
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

function windowRegainsFocus(at: number): void {
  now = at;
  window.dispatchEvent(new FocusEvent("focus"));
}

describe("a click as the window regains focus", () => {
  test("selects the pane under the cursor, though the pane never sees the click", () => {
    windowRegainsFocus(1_000);
    clickAt(paneElement(other), 1_020);

    expect(layout.activePaneId).toBe(other);
  });

  test("counts only once: the next click is the pane's own", () => {
    windowRegainsFocus(1_000);
    clickAt(paneElement(other), 1_010);
    clickAt(paneElement("pane-test"), 1_020);

    expect(layout.activePaneId).toBe(other);
  });
});

describe("the selection is left alone", () => {
  test("by a focus with no click after it", () => {
    windowRegainsFocus(1_000);

    expect(layout.activePaneId).toBe("pane-test");
  });

  test("by a click more than 50 ms after the focus", () => {
    windowRegainsFocus(1_000);
    clickAt(paneElement(other), 1_051);

    expect(layout.activePaneId).toBe("pane-test");
  });

  test("by a click with no focus before it", () => {
    clickAt(paneElement(other), 1_000);

    expect(layout.activePaneId).toBe("pane-test");
  });

  test("once App is unmounted", async () => {
    await unmountApp();
    resetLayout([fileTab({ id: "doc" })]);
    const second = splitPane("pane-test", "row")!;
    layout.activePaneId = "pane-test";
    const stale = document.createElement("div");
    stale.className = "pane";
    stale.dataset.paneId = second;
    document.body.append(stale);

    windowRegainsFocus(1_000);
    clickAt(stale, 1_010);

    expect(layout.activePaneId).toBe("pane-test");
  });
});
