// @vitest-environment jsdom
//
// The view registry of the file browser surfaces: each surface reads the
// defaults until something changes it, a change to one surface leaves the
// others alone, and a dropped surface reads the defaults again. A tab's
// record lasts as long as a layout holds the tab and is forgotten once none
// does; a dock's is its surface's to drop.

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetLayout } from "../__tests__/tabs";
import {
  browserView,
  dropBrowserView,
  setBrowserView,
  toggleBrowserView,
} from "./browserView.svelte";
import {
  cancelPaneMode,
  enterPaneMode,
  layout,
  paneMode,
  reorderTab,
  type BrowserTab,
  type LeafNode,
} from "./tabs.svelte";

const DEFAULTS = { showHidden: true, selectionMode: false, helpOpen: false };

function browserTab(id: string): BrowserTab {
  return { kind: "browser", id, title: "Files", inspectorOpen: false };
}

beforeEach(() => {
  resetLayout([browserTab("a"), browserTab("b")]);
});

afterEach(() => {
  if (paneMode.active) cancelPaneMode();
  resetLayout();
  flushSync();
  dropBrowserView("fb-dock-left");
});

describe("a file browser surface's view", () => {
  test("lists hidden files, marks nothing and shows no key list until changed", () => {
    expect(browserView("fb-tab-a")).toEqual(DEFAULTS);
  });

  test("changes one switch of one surface", () => {
    toggleBrowserView("fb-tab-a", "showHidden");
    setBrowserView("fb-tab-a", { helpOpen: true });

    expect(browserView("fb-tab-a")).toEqual({ showHidden: false, selectionMode: false, helpOpen: true });
    expect(browserView("fb-tab-b")).toEqual(DEFAULTS);
    expect(browserView("fb-dock-left")).toEqual(DEFAULTS);

    toggleBrowserView("fb-tab-a", "showHidden");
    expect(browserView("fb-tab-a").showHidden).toBe(true);
  });

  test("reads the defaults again once dropped", () => {
    toggleBrowserView("fb-dock-left", "selectionMode");
    expect(browserView("fb-dock-left").selectionMode).toBe(true);

    dropBrowserView("fb-dock-left");
    expect(browserView("fb-dock-left").selectionMode).toBe(false);
  });
});

describe("a tab's view", () => {
  test("is kept while the layout holds the tab, through a move that puts a copy of it back", () => {
    toggleBrowserView("fb-tab-a", "showHidden");
    toggleBrowserView("fb-tab-b", "selectionMode");
    flushSync();
    expect(browserView("fb-tab-a").showHidden).toBe(false);

    // A reorder takes the tab out of its pane and puts a copy of it back.
    const pane = layout.nodes[layout.rootId] as LeafNode;
    const before = pane.tabs[0];
    reorderTab(pane.id, "a", 1);
    flushSync();
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
    expect(pane.tabs[1], "the tab is a copy").not.toBe(before);
    expect([browserView("fb-tab-a").showHidden, browserView("fb-tab-b").selectionMode]).toEqual([false, true]);
  });

  test("is forgotten once no layout holds the tab, and a tab of the same id starts from the defaults", () => {
    toggleBrowserView("fb-tab-a", "showHidden");
    toggleBrowserView("fb-tab-b", "helpOpen");
    resetLayout([browserTab("b")]);
    flushSync();
    expect(browserView("fb-tab-a"), "closed").toEqual(DEFAULTS);
    expect(browserView("fb-tab-b").helpOpen, "the tab still open keeps its own").toBe(true);

    resetLayout([browserTab("a"), browserTab("b")]);
    flushSync();
    expect(browserView("fb-tab-a"), "reopened").toEqual(DEFAULTS);
  });

  test("is kept while Hybrid Nav's draft holds a tab the layout does not, and goes with the draft", () => {
    enterPaneMode();
    resetLayout([browserTab("b")]);
    toggleBrowserView("fb-tab-a", "selectionMode");
    flushSync();
    expect(browserView("fb-tab-a").selectionMode, "staged in the draft").toBe(true);

    cancelPaneMode();
    flushSync();
    expect(browserView("fb-tab-a"), "the draft is gone").toEqual(DEFAULTS);
  });

  test("leaves a dock's view alone, which no layout holds", () => {
    toggleBrowserView("fb-dock-left", "helpOpen");
    toggleBrowserView("fb-tab-a", "helpOpen");
    resetLayout();
    flushSync();
    expect([browserView("fb-dock-left").helpOpen, browserView("fb-tab-a").helpOpen]).toEqual([true, false]);
  });
});
