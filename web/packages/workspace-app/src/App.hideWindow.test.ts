// @vitest-environment jsdom
//
// Hide window buries this window in chan-desktop: its sessions stay warm and
// it reopens from the launcher. It is the close prompt's Hide answer without
// the prompt, so every way to reach it (Cmd/Ctrl+Shift+H, the launcher row,
// the host command and the prompt's own Hide button) calls the one hide the
// prompt uses. A browser has no such IPC, so there the chord is not claimed
// and the launcher does not offer it.

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
  hideWindowFromCloseConfirm: vi.fn(async () => {}),
}));

import { hideWindowFromCloseConfirm } from "./api/desktop";
import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { uiCloseConfirm } from "./state/closeConfirm.svelte";
import { allCommands, type CommandContext } from "./state/commands";
import { renderTable, shouldEscapeTerminal } from "./state/shortcuts";

stubAppEnvironment();

const HIDE_CHORD = { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true } as const;

beforeEach(async () => {
  host.desktop = false;
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  vi.clearAllMocks();
});

afterEach(async () => {
  await unmountApp();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function launcherContext(): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
  };
}

describe("under chan-desktop", () => {
  beforeEach(() => {
    host.desktop = true;
  });

  test("Ctrl+Shift+H hides the window", async () => {
    press(HIDE_CHORD);
    await settle();
    expect(hideWindowFromCloseConfirm).toHaveBeenCalledTimes(1);
  });

  test("the host's hide command hides it", async () => {
    hostCommand("app.window.hide");
    await settle();
    expect(hideWindowFromCloseConfirm).toHaveBeenCalledTimes(1);
  });

  test("the launcher offers Hide window and runs the same hide", () => {
    const hide = allCommands().find((command) => command.id === "app.window.hide");
    expect(hide?.available(launcherContext())).toBe(true);
    hide!.run();
    expect(hideWindowFromCloseConfirm).toHaveBeenCalledTimes(1);
  });

  test("the close prompt's Hide button hides it the same way", async () => {
    const answer = uiCloseConfirm();
    await settle();
    document.querySelector<HTMLButtonElement>(".actions button.hide")!.click();

    await expect(answer).resolves.toBe("hide");
    expect(hideWindowFromCloseConfirm).toHaveBeenCalledTimes(1);
  });

  test("the chord escapes a focused terminal", () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", HIDE_CHORD))).toBe(true);
  });
});

describe("in a browser", () => {
  test("the chord is not claimed and the launcher does not offer it", async () => {
    press(HIDE_CHORD);
    await settle();
    expect(hideWindowFromCloseConfirm).not.toHaveBeenCalled();
    const hide = allCommands().find((command) => command.id === "app.window.hide");
    expect(hide?.available(launcherContext())).toBe(false);
  });
});

describe("the shortcut table", () => {
  test("lists the chord for the desktop only", () => {
    expect(renderTable("native", "linux")).toMatch(/^Hide window +Ctrl\+Shift\+H /m);
    expect(renderTable("native", "mac")).toMatch(/^Hide window +Cmd\+Shift\+H /m);
    expect(renderTable("web", "linux")).not.toMatch(/^Hide window/m);
  });
});
