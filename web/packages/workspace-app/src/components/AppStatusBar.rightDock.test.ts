// @vitest-environment jsdom
//
// The status bar sits at the workspace's right edge: 12px in, or beside the
// right-docked Files browser, following its live width as the dock resizes.
// A terminal-only window has no dock, so a docked preference saved elsewhere
// never pushes its status bar in.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { browserSidePanes, paneWidths, ui } from "../state/store.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;
const width = paneWidths.browser;

beforeEach(() => {
  // Any status makes the bar render.
  ui.status = "ready";
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  ui.status = null;
  ui.terminalOnly = false;
  browserSidePanes.right = false;
  paneWidths.browser = width;
});

function bar(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(AppStatusBar, { target });
  flushSync();
  return target.querySelector<HTMLElement>(".app-statusbar")!;
}

describe("the status bar's right edge", () => {
  test("sits 12px in with no right dock", () => {
    expect(bar().style.right).toBe("12px");
  });

  test("sits beside the right dock and follows its width", () => {
    browserSidePanes.right = true;
    paneWidths.browser = 300;
    const statusBar = bar();
    expect(statusBar.style.right).toBe("312px");

    paneWidths.browser = 420;
    flushSync();
    expect(statusBar.style.right).toBe("432px");
  });

  test("ignores a docked preference in a terminal-only window", () => {
    ui.terminalOnly = true;
    browserSidePanes.right = true;
    paneWidths.browser = 300;

    expect(bar().style.right).toBe("12px");
  });
});
