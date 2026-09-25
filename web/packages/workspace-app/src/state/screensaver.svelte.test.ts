// @vitest-environment jsdom
//
// The screen lock's state machine: it loads the workspace's screensaver
// settings, locks after `timeout_secs` without activity, stays off while
// something pauses it, and unlocks with a PIN the server verifies or, when
// the workspace has no PIN, with any input.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ScreensaverTheme } from "./screensaver";

type State = {
  enabled: boolean;
  timeout_secs: number;
  theme: ScreensaverTheme;
  pin_set: boolean;
};

let machine: typeof import("./screensaver.svelte");
let api: typeof import("../api/client").api;
let defaults: typeof import("./screensaver");

async function load(over: Partial<State> = {}): Promise<void> {
  vi.spyOn(api, "screensaverState").mockResolvedValue({
    enabled: true,
    timeout_secs: 60,
    theme: "matrix",
    pin_set: true,
    ...over,
  });
  await machine.loadScreensaverState();
}

beforeEach(async () => {
  // A fresh module per test: the countdown and the pause count are module
  // state.
  vi.resetModules();
  vi.useFakeTimers();
  machine = await import("./screensaver.svelte");
  api = (await import("../api/client")).api;
  defaults = await import("./screensaver");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("before the settings load", () => {
  test("the lock is off, unlocked and not loaded, on the defaults", () => {
    expect({ ...machine.screensaver }).toEqual({
      enabled: false,
      timeout_secs: defaults.SCREENSAVER_DEFAULT_TIMEOUT_SECS,
      theme: defaults.SCREENSAVER_DEFAULT_THEME,
      pin_set: false,
      locked: false,
      loaded: false,
    });
  });

  test("locking now does nothing", () => {
    machine.lockNow();
    expect(machine.screensaver.locked).toBe(false);
  });
});

describe("loading the settings", () => {
  test("applies the workspace's settings", async () => {
    await load();
    expect({ ...machine.screensaver }).toEqual({
      enabled: true,
      timeout_secs: 60,
      theme: "matrix",
      pin_set: true,
      locked: false,
      loaded: true,
    });
  });

  test("a failed read leaves it unloaded", async () => {
    vi.spyOn(api, "screensaverState").mockRejectedValue(new Error("offline"));
    await machine.loadScreensaverState();
    expect(machine.screensaver.loaded).toBe(false);
  });
});

describe("the countdown", () => {
  test("locks after the timeout without activity", async () => {
    await load();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(machine.screensaver.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(machine.screensaver.locked).toBe(true);
  });

  test("restarts on every kind of input the tracker listens for", async () => {
    await load();
    const uninstall = machine.installScreensaverTracker();
    for (const type of ["keydown", "mousedown", "touchstart", "click", "scroll", "wheel", "pointermove"]) {
      await vi.advanceTimersByTimeAsync(50_000);
      window.dispatchEvent(new Event(type));
    }
    await vi.advanceTimersByTimeAsync(50_000);
    expect(machine.screensaver.locked).toBe(false);

    uninstall();
    window.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(machine.screensaver.locked).toBe(false);
  });

  test("never runs while the lock is disabled", async () => {
    await load({ enabled: false });
    machine.noteScreensaverActivity();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(machine.screensaver.locked).toBe(false);
  });

  test("stays off while anything holds a pause, until the last release", async () => {
    await load();
    const first = machine.pauseScreensaverTimer();
    const second = machine.pauseScreensaverTimer();
    await vi.advanceTimersByTimeAsync(3_600_000);
    first();
    first();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(machine.screensaver.locked).toBe(false);

    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(machine.screensaver.locked).toBe(true);
  });
});

describe("locking and unlocking", () => {
  test("locking now locks at once and ignores activity until unlocked", async () => {
    await load();
    machine.lockNow();
    expect(machine.screensaver.locked).toBe(true);
    machine.noteScreensaverActivity();
    expect(machine.screensaver.locked).toBe(true);
  });

  test("a PIN the server verifies unlocks and restarts the countdown", async () => {
    await load();
    machine.lockNow();
    const verify = vi.spyOn(api, "screensaverVerify").mockResolvedValue({ verified: true });

    await expect(machine.unlockWithPin("1234", "/ws")).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith(await defaults.hashPin("1234", "/ws"));
    expect(machine.screensaver.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(machine.screensaver.locked).toBe(true);
  });

  test("a wrong or empty PIN keeps it locked", async () => {
    await load();
    machine.lockNow();
    const verify = vi.spyOn(api, "screensaverVerify").mockResolvedValue({ verified: false });

    await expect(machine.unlockWithPin("9999", "/ws")).resolves.toBe(false);
    await expect(machine.unlockWithPin("", "/ws")).resolves.toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(machine.screensaver.locked).toBe(true);
  });

  test("with no PIN set any input unlocks; with one set it cannot", async () => {
    await load({ pin_set: true });
    machine.lockNow();
    machine.unlockWithoutPin();
    expect(machine.screensaver.locked).toBe(true);

    await load({ pin_set: false });
    machine.lockNow();
    machine.unlockWithoutPin();
    expect(machine.screensaver.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(machine.screensaver.locked).toBe(true);
  });
});
