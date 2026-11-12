// The settings surface's overlay state: its open/close helpers
// and its participation in the shared overlay stack (z-order + the
// single-Escape close). Pure state, no rendering.

import { afterEach, describe, expect, test } from "vitest";
import {
  closeCommandLauncher,
  closeOverlay,
  closeSettings,
  launcherPanel,
  openSettings,
  overlayDepth,
  overlayStack,
  searchPanel,
  settingsPanel,
  syncOverlayStack,
  topOverlay,
} from "./store.svelte";

afterEach(() => {
  settingsPanel.open = false;
  settingsPanel.target = null;
  launcherPanel.open = false;
  searchPanel.open = false;
  overlayStack.ids = [];
});

describe("settings overlay state", () => {
  test("open / close drive settingsPanel.open", () => {
    expect(settingsPanel.open).toBe(false);
    openSettings();
    expect(settingsPanel.open).toBe(true);
    closeSettings();
    expect(settingsPanel.open).toBe(false);
  });

  test("an open aimed at a field records where to land, and a plain open records nothing", () => {
    openSettings();
    expect(settingsPanel.target).toBeNull();

    openSettings({ section: "terminal", field: "terminal.engine" });
    expect(settingsPanel.open).toBe(true);
    expect(settingsPanel.target).toEqual({ section: "terminal", field: "terminal.engine" });
  });

  test("syncOverlayStack tracks settings; topOverlay + closeOverlay agree", () => {
    openSettings();
    syncOverlayStack();
    expect(overlayDepth("settings")).toBeGreaterThanOrEqual(0);
    expect(topOverlay()).toBe("settings");

    closeOverlay("settings");
    expect(settingsPanel.open).toBe(false);
    expect(overlayDepth("settings")).toBe(-1);
    expect(topOverlay()).toBeNull();
  });

  test("closing the launcher updates the overlay stack synchronously", () => {
    launcherPanel.open = true;
    syncOverlayStack();
    expect(topOverlay()).toBe("launcher");

    closeCommandLauncher();

    expect(topOverlay()).toBeNull();
  });

  test("an overlay opened over settings sits on top (Escape closes it first)", () => {
    // App.svelte syncs the stack on every .open change, so an overlay
    // opened after settings is appended above it.
    openSettings();
    syncOverlayStack();
    launcherPanel.open = true;
    syncOverlayStack();
    expect(overlayDepth("settings")).toBe(0);
    expect(overlayDepth("launcher")).toBe(1);
    expect(topOverlay()).toBe("launcher");
  });
});
