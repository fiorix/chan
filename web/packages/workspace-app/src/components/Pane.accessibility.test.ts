// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import Pane from "./Pane.svelte";
import { stubAppEnvironment } from "../__tests__/app";
import { fileTab, terminalTab } from "../__tests__/tabs";
import { api } from "../api/client";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { persistStateToHash } from "../state/store.svelte";
import { cancelPaneMode, enterPaneMode, layout, paneMode, type LeafNode, type Tab } from "../state/tabs.svelte";

stubAppEnvironment();

const PANE = "accessibility-pane";
const OTHER = "other-pane";
const KEPT = "kept-tab";
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  cancelPaneMode();
  vi.spyOn(api, "closeTerminal").mockResolvedValue(undefined);
});

afterEach(async () => {
  if (confirmState.open) resolveConfirm(false);
  await settle();
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
  persistStateToHash();
  vi.restoreAllMocks();
});

const kinds: Array<{ name: string; make: () => Tab; live: boolean }> = [
  {
    name: "a live terminal",
    make: () => terminalTab({ id: "live-terminal", title: "Live", terminalSessionId: "session-live" }),
    live: true,
  },
  {
    name: "a file",
    make: () => fileTab({ id: "file-tab", path: "notes/a.md", mode: "source" }),
    live: false,
  },
  {
    name: "a terminal without a session",
    make: () => terminalTab({ id: "unstarted-terminal", title: "Unstarted" }),
    live: false,
  },
];

async function settle(): Promise<void> {
  await tick();
  await tick();
  await tick();
}

function pane(): LeafNode {
  const node = layout.nodes[PANE];
  if (node?.kind !== "leaf") throw new Error("accessibility pane is not a leaf");
  return node;
}

async function renderTab(tab: Tab, options: { preview?: boolean; stale?: boolean } = {}): Promise<HTMLElement> {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "column", a: OTHER, b: PANE, ratio: 0.5 },
    [OTHER]: { kind: "leaf", id: OTHER, tabs: [], activeTabId: null },
    [PANE]: { kind: "leaf", id: PANE, tabs: [terminalTab({ id: KEPT, title: "Kept" }), tab], activeTabId: KEPT },
  };
  layout.rootId = "root";
  layout.activePaneId = OTHER;
  if (options.preview) {
    enterPaneMode();
    paneMode.stale = options.stale ?? false;
  }
  const node = options.preview ? paneMode.draft?.nodes[PANE] : pane();
  if (node?.kind !== "leaf") throw new Error("rendered pane is not a leaf");
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane: node } }) as Record<string, unknown>);
  await settle();
  const element = target.querySelectorAll<HTMLElement>('[role="tab"]')[1];
  if (!element) throw new Error("target tab has no accessible role");
  expect(element.getAttribute("aria-selected")).toBe("false");
  return element;
}

/// WebKit routes a tab's accessibility action to its first native button or
/// select descendant, falling back to the role element when neither exists.
function webKitActionElement(tab: HTMLElement): HTMLElement {
  return tab.querySelector<HTMLElement>("button, select") ?? tab;
}

async function press(element: HTMLElement): Promise<void> {
  for (const type of ["mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true }));
    await settle();
  }
}

function expectSelectedAndOpen(tab: Tab): void {
  expect(pane().activeTabId, "the pressed tab is selected").toBe(tab.id);
  expect(layout.activePaneId, "the pressed tab owns pane focus").toBe(PANE);
  expect(pane().tabs.map((item) => item.id), "both tabs remain open").toEqual([KEPT, tab.id]);
  expect(confirmState.open, "selecting a tab asks no close question").toBe(false);
  expect(api.closeTerminal, "selecting a tab closes no session").not.toHaveBeenCalled();
}

describe("tab accessibility activation", () => {
  for (const kind of kinds) {
    test(`a WebKit press selects ${kind.name} without closing it`, async () => {
      const tab = kind.make();
      const element = await renderTab(tab);
      await press(webKitActionElement(element));
      expectSelectedAndOpen(tab);
      expect(element.getAttribute("aria-selected")).toBe("true");
    });

    test(`the close control closes ${kind.name}`, async () => {
      const tab = kind.make();
      const element = await renderTab(tab);
      const container = element.closest(".tab");
      const button = container?.querySelector<HTMLButtonElement>("button.close");
      if (!button) throw new Error("tab has no close control");
      const label = element.querySelector(".path")?.textContent?.trim();
      expect(button.getAttribute("aria-label")).toBe(`close ${label}`);

      await press(button);
      if (kind.live) {
        expect(confirmState.open, "a live terminal asks before closing").toBe(true);
        expect(confirmState.title).toBe("Close tab?");
        expect(confirmState.message).toContain("Live is still running");
        expect(pane().tabs.some((item) => item.id === tab.id)).toBe(true);
        expect(api.closeTerminal).not.toHaveBeenCalled();
        resolveConfirm(true);
      } else {
        expect(confirmState.open, "an idle terminal or clean file needs no prompt").toBe(false);
      }
      await vi.waitFor(() => expect(pane().tabs.map((item) => item.id)).toEqual([KEPT]));
      if (kind.live) expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith("session-live");
      else expect(api.closeTerminal).not.toHaveBeenCalled();
    });

    test.each(["Enter", " "])(`%j on the focused label selects ${kind.name}`, async (key) => {
      const tab = kind.make();
      const element = await renderTab(tab);
      element.focus();
      expect(document.activeElement).toBe(element);
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      await settle();
      expectSelectedAndOpen(tab);
      expect(element.getAttribute("aria-selected")).toBe("true");
      expect(event.defaultPrevented, "activation does not also scroll or invoke a window command").toBe(true);
    });
  }
});

describe("tab label keyboard ownership", () => {
  test.each([
    { key: "Enter", ctrlKey: true },
    { key: " ", ctrlKey: true },
    { key: "Enter", metaKey: true },
    { key: " ", metaKey: true },
    { key: "Enter", altKey: true },
    { key: " ", altKey: true },
    { key: "ArrowLeft" },
    { key: "ArrowRight" },
  ])("leaves the existing key path intact for %j", async (init) => {
    const element = await renderTab(terminalTab({ id: "inactive", title: "Inactive" }));
    element.focus();
    const received = vi.fn();
    document.addEventListener("keydown", received);
    try {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      await settle();
      expect(pane().activeTabId).toBe(KEPT);
      expect(layout.activePaneId).toBe(OTHER);
      expect(event.defaultPrevented).toBe(false);
      expect(received).toHaveBeenCalledOnce();
      expect(confirmState.open).toBe(false);
    } finally {
      document.removeEventListener("keydown", received);
    }
  });

  test.each([false, true])("leaves Hybrid Nav's key path intact when stale=%s", async (stale) => {
    const element = await renderTab(terminalTab({ id: "preview-tab", title: "Preview" }), { preview: true, stale });
    expect(element.getAttribute("tabindex")).toBe(stale ? "-1" : "0");
    expect(element.getAttribute("aria-disabled")).toBe(String(stale));
    expect(element.closest(".tab")?.querySelector<HTMLButtonElement>("button.close")?.disabled).toBe(stale);
    element.focus();
    const received = vi.fn();
    document.addEventListener("keydown", received);
    try {
      for (const key of ["Enter", " "]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        await settle();
        expect(pane().activeTabId).toBe(KEPT);
        expect(paneMode.draft?.nodes[PANE]).toMatchObject({ activeTabId: KEPT });
        expect(event.defaultPrevented).toBe(false);
      }
      expect(received).toHaveBeenCalledTimes(2);
      expect(confirmState.open).toBe(false);
    } finally {
      document.removeEventListener("keydown", received);
    }
  });
});
