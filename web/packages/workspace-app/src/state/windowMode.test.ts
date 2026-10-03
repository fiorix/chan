import { describe, expect, test } from "vitest";
import {
  TERMINAL_ONLY_COMMANDS,
  windowModeAllowsCommand,
  windowModeAllowsSnapshot,
} from "./windowMode";
import * as windowMode from "./windowMode";

describe("terminal secret masking seed", () => {
  test.each([
    [undefined, false, false],
    [undefined, true, true],
    [true, false, true],
    [true, true, true],
    [false, false, false],
    [false, true, false],
  ] as const)("preference %s in control mode %s seeds %s", (preference, terminalControl, expected) => {
    const rule = (windowMode as unknown as {
      windowModeSecretMaskingEnabled?: (preference: boolean | undefined, mode: { terminalControl: boolean }) => boolean;
    }).windowModeSecretMaskingEnabled;
    expect(typeof rule).toBe("function");
    expect(rule!(preference, { terminalControl })).toBe(expected);
  });
});

describe("terminal-only command gate", () => {
  test("allows the command launcher in standalone and control terminal windows", () => {
    expect(TERMINAL_ONLY_COMMANDS.has("app.launcher.toggle")).toBe(true);
    expect(TERMINAL_ONLY_COMMANDS.has("app.settings.open")).toBe(true);
    expect(TERMINAL_ONLY_COMMANDS.has("app.window.reload")).toBe(true);
    expect(TERMINAL_ONLY_COMMANDS.has("app.pane.mode")).toBe(true);
    expect(
      windowModeAllowsCommand("app.launcher.toggle", {
        terminalOnly: true,
        terminalControl: false,
      }),
    ).toBe(true);
    expect(
      windowModeAllowsCommand("app.launcher.toggle", {
        terminalOnly: true,
        terminalControl: true,
      }),
    ).toBe(true);
  });

  test("allows the window hide/close family in terminal-only and control windows", () => {
    // Standalone terminal (and control) windows are library windows with a
    // red-dot close prompt, so the self-hide command stays live there like
    // close/confirmClose.
    expect(TERMINAL_ONLY_COMMANDS.has("app.window.close")).toBe(true);
    expect(TERMINAL_ONLY_COMMANDS.has("app.window.hide")).toBe(true);
    expect(
      windowModeAllowsCommand("app.window.hide", {
        terminalOnly: true,
        terminalControl: true,
      }),
    ).toBe(true);
  });

  test("still blocks workspace-only commands in terminal-only windows", () => {
    expect(
      windowModeAllowsCommand("app.graph.toggle", {
        terminalOnly: true,
        terminalControl: false,
      }),
    ).toBe(false);
  });

  test("blocks the search toggle in terminal-only windows (slim tenant, no search routes)", () => {
    expect(
      windowModeAllowsCommand("app.search.toggle", {
        terminalOnly: true,
        terminalControl: false,
      }),
    ).toBe(false);
  });
});

// The control terminal's scrollback carries the CHAN_DEVSERVER_TOKEN= marker
// the desktop re-scrapes; persisting it to localStorage would keep a live
// credential on disk for days. Red mutation: have the predicate return true
// for `terminalControl: true`.
describe("terminal snapshot gate", () => {
  test("a control terminal may never persist a scrollback snapshot", () => {
    expect(windowModeAllowsSnapshot({ terminalControl: true })).toBe(false);
  });

  test("ordinary terminal windows still snapshot", () => {
    expect(windowModeAllowsSnapshot({ terminalControl: false })).toBe(true);
  });
});
