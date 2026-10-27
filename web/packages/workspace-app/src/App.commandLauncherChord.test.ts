// @vitest-environment jsdom
//
// The command launcher has one chord: Cmd+K in chan-desktop on macOS and
// Ctrl+Alt+K everywhere else. The deck carries the Computers scope itself, so
// the Shift form of either chord is not claimed: it reaches a focused
// terminal, and a host command or saved keymap override naming the old
// Computers launcher id opens nothing.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

const host = vi.hoisted(() => ({ desktop: false }));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
}));

import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { hydrateOverrides } from "./state/keymapOverrides.svelte";
import { renderTable, SHORTCUTS, shouldEscapeTerminal } from "./state/shortcuts";
import { launcherPanel } from "./state/store.svelte";

stubAppEnvironment();

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const DESKTOPS = [
  ["macOS", MAC_UA, { metaKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }],
  ["Linux", LINUX_UA, { ctrlKey: true, altKey: true }, { ctrlKey: true, altKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }],
] as const;

beforeEach(async () => {
  host.desktop = true;
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  launcherPanel.open = false;
});

afterEach(async () => {
  hydrateOverrides(null);
  launcherPanel.open = false;
  await unmountApp();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe.each(DESKTOPS)("chan-desktop on %s", (_os, ua, plain, shifted, assigned) => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  });

  test("the Shift form of the launcher chord does not open the deck", async () => {
    const event = press({ key: "K", code: "KeyK", ...shifted });
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(launcherPanel.open).toBe(false);

    press({ key: "k", code: "KeyK", ...plain });
    await settle();
    expect(launcherPanel.open).toBe(true);
  });

  test("the Shift form reaches a focused terminal", () => {
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", { key: "K", code: "KeyK", ...shifted }))).toBe(false);
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ...plain }))).toBe(true);
  });

  test("a host command for the Computers launcher opens nothing", async () => {
    hostCommand("app.launcher.computers");
    await settle();
    expect(launcherPanel.open).toBe(false);

    hostCommand("app.launcher.toggle");
    await settle();
    expect(launcherPanel.open).toBe(true);
  });

  test("a saved override for the Computers launcher id is ignored", async () => {
    hydrateOverrides({
      "app.launcher.computers": { macos: "Mod+Alt+Y", linux: "Ctrl+Alt+Y" },
    });
    const event = press({ key: "y", code: "KeyY", ...assigned });
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(launcherPanel.open).toBe(false);
  });
});

describe("the shortcut table", () => {
  test("lists one command launcher chord per platform", () => {
    expect(SHORTCUTS.some((s) => s.id === "app.launcher.computers")).toBe(false);
    for (const [platform, os] of [["native", "mac"], ["native", "linux"], ["native", "windows"], ["web", "linux"]] as const) {
      const table = renderTable(platform, os);
      expect(table).not.toMatch(/Computers command launcher/);
      expect(table).not.toMatch(/Shift\+K/);
      expect(table).toMatch(/^Command launcher +(Cmd\+K|Ctrl\+Alt\+K)( |$)/m);
    }
  });
});
