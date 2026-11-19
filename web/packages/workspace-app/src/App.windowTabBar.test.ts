// @vitest-environment jsdom
//
// The app in the window tab bar mode: a stored "1" draws the bar in a
// browser, the panes start below it, the active pane's strip sits in it, and
// the status pill keeps clear of it; without the override a browser draws
// no bar and every pane keeps its strip. The bar comes and goes in a running
// window, taking the strip with it, and the pane tree overlay is mounted in
// every mode.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { closePaneTree, openPaneTree } from "./state/paneTree.svelte";
import { ui } from "./state/store.svelte";
import { WINDOW_TAB_BAR_STORAGE_KEY, windowTabBar } from "./state/windowTabBar.svelte";

stubAppEnvironment();

afterEach(async () => {
  closePaneTree();
  ui.status = null;
  await unmountApp();
  localStorage.removeItem(WINDOW_TAB_BAR_STORAGE_KEY);
  windowTabBar.on = false;
});

describe("the window tab bar in the app", () => {
  test("a stored 1 draws the bar in a browser with the active pane's strip in it", async () => {
    localStorage.setItem(WINDOW_TAB_BAR_STORAGE_KEY, "1");
    const target = await mountApp();

    const bar = target.querySelector<HTMLElement>(".app > .window-tab-bar");
    expect(bar, "the bar is drawn inside the app").not.toBeNull();
    expect(target.querySelector(".app")?.classList.contains("window-tab-bar")).toBe(true);
    expect(bar?.querySelector(".slot > .tabs"), "the active pane's strip is in the bar").not.toBeNull();
    expect(target.querySelector(".pane .pane-card-face > .tabs"), "no pane draws a strip in place").toBeNull();
    expect(bar?.querySelector(".inset")?.getAttribute("style")).toContain("width: 0px");

    ui.status = "working";
    await settle();
    expect(document.querySelector<HTMLElement>(".app-statusbar")?.style.top).toBe(`${windowTabBar.height + 10}px`);
  });

  test("without the override a browser draws no bar and the pane keeps its strip", async () => {
    const target = await mountApp();
    expect(target.querySelector(".window-tab-bar")).toBeNull();
    expect(target.querySelector(".pane .pane-card-face > .tabs")).not.toBeNull();

    ui.status = "working";
    await settle();
    expect(document.querySelector<HTMLElement>(".app-statusbar")?.style.top).toBe("48px");
  });

  test("the bar comes and goes in a running window and the strip follows it", async () => {
    const target = await mountApp();
    const inPane = () => target.querySelector(".pane .pane-card-face > .tabs");
    expect(inPane()).not.toBeNull();

    windowTabBar.on = true;
    await settle();
    expect(target.querySelector(".app > .window-tab-bar .slot > .tabs"), "the strip moves into the bar").not.toBeNull();
    expect(inPane()).toBeNull();

    windowTabBar.on = false;
    await settle();
    expect(target.querySelector(".app > .window-tab-bar")).toBeNull();
    expect(inPane(), "the strip is back in its pane").not.toBeNull();
  });

  test("the pane tree overlay is mounted in every mode", async () => {
    await mountApp();
    const before = document.querySelectorAll('[role="dialog"]').length;
    openPaneTree();
    await settle();
    expect(document.querySelectorAll('[role="dialog"]').length, "opening the tree draws its dialog").toBeGreaterThan(before);
  });
});
