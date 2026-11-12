// The view registry of the file browser surfaces: each surface reads the
// defaults until something changes it, a change to one surface leaves the
// others alone, and a dropped surface reads the defaults again.

import { afterEach, describe, expect, test } from "vitest";
import {
  browserView,
  dropBrowserView,
  setBrowserView,
  toggleBrowserView,
} from "./browserView.svelte";

afterEach(() => {
  dropBrowserView("fb-tab-a");
  dropBrowserView("fb-dock-left");
});

describe("a file browser surface's view", () => {
  test("lists hidden files, marks nothing and shows no key list until changed", () => {
    expect(browserView("fb-tab-a")).toEqual({ showHidden: true, selectionMode: false, helpOpen: false });
  });

  test("changes one switch of one surface", () => {
    toggleBrowserView("fb-tab-a", "showHidden");
    setBrowserView("fb-tab-a", { helpOpen: true });

    expect(browserView("fb-tab-a")).toEqual({ showHidden: false, selectionMode: false, helpOpen: true });
    expect(browserView("fb-dock-left")).toEqual({ showHidden: true, selectionMode: false, helpOpen: false });

    toggleBrowserView("fb-tab-a", "showHidden");
    expect(browserView("fb-tab-a").showHidden).toBe(true);
  });

  test("reads the defaults again once dropped", () => {
    toggleBrowserView("fb-tab-a", "selectionMode");
    expect(browserView("fb-tab-a").selectionMode).toBe(true);

    dropBrowserView("fb-tab-a");
    expect(browserView("fb-tab-a").selectionMode).toBe(false);
  });
});
