// @vitest-environment jsdom
//
// toggleLauncherPanel asks the desktop to show its Computers launcher over
// the invoking window, by the command the desktop's key bridge sends for
// the launcher chord. Off the desktop there is no such panel and it throws,
// and a refusal by the desktop reaches the caller.

import { afterEach, describe, expect, test, vi } from "vitest";

import { toggleLauncherPanel } from "./desktop";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
});

function onDesktop(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
}

describe("toggleLauncherPanel", () => {
  test("invokes the desktop's toggle_launcher_panel, with no arguments", async () => {
    const invoke = vi.fn(async () => undefined);
    onDesktop(invoke);

    await toggleLauncherPanel();

    expect(invoke.mock.calls).toEqual([["toggle_launcher_panel", undefined]]);
  });

  test("throws off the desktop, where no panel exists", async () => {
    await expect(toggleLauncherPanel()).rejects.toThrow("not running under Tauri");
  });

  test("hands the caller the desktop's refusal", async () => {
    onDesktop(async () => {
      throw "terminal cannot host the launcher";
    });

    await expect(toggleLauncherPanel()).rejects.toBe("terminal cannot host the launcher");
  });
});
