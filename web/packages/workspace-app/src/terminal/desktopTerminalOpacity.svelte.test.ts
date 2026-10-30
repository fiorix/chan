// @vitest-environment jsdom
//
// The desktop's terminal background opacity as the page follows it. In a
// chan-desktop window the store subscribes to the desktop's change event
// before it asks for the value, applies the answer and every event after it,
// and writes through the host; everything the host says is clamped to the
// slider bounds. In a browser tab it asks nothing and stays null. The Tauri
// globals are stood in for on the window, so the real bridge helpers run.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/desktop")>();
  return {
    ...actual,
    onTauriEvent: vi.fn(actual.onTauriEvent),
    readTerminalBackgroundOpacity: vi.fn(actual.readTerminalBackgroundOpacity),
  };
});

import { onTauriEvent, readTerminalBackgroundOpacity } from "../api/desktop";
import {
  TERMINAL_BACKGROUND_OPACITY_EVENT,
  applyDesktopTerminalOpacity,
  desktopTerminalOpacity,
  resetDesktopTerminalOpacityForTests,
  setDesktopTerminalOpacity,
  startDesktopTerminalOpacity,
} from "./desktopTerminalOpacity.svelte";

type Listener = (e: { payload: unknown }) => void;

/// A chan-desktop window: the invoke bridge and the global event API, with
/// everything the page asked recorded in order. The desktop answers 100 and
/// echoes a write unless the case says otherwise.
function installDesktop(
  answer: {
    read?: () => Promise<unknown>;
    write?: (percent: unknown) => Promise<unknown>;
  } = {},
) {
  const calls: string[] = [];
  const listeners: Listener[] = [];
  const unlisten = vi.fn();
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    calls.push(`invoke ${cmd}`);
    if (cmd === "terminal_background_opacity") return answer.read ? await answer.read() : 100;
    if (cmd === "set_terminal_background_opacity") {
      const { percent } = args as { percent: unknown };
      return answer.write ? await answer.write(percent) : percent;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const listen = vi.fn(async (event: string, handler: Listener) => {
    calls.push(`listen ${event}`);
    listeners.push(handler);
    return unlisten;
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
  Object.defineProperty(window, "__TAURI__", { value: { event: { listen } }, configurable: true });
  const emit = (payload: unknown): void => {
    for (const listener of listeners) listener({ payload });
  };
  return { calls, invoke, unlisten, emit };
}

afterEach(() => {
  resetDesktopTerminalOpacityForTests();
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

describe("outside chan-desktop", () => {
  test("the value stays null and nothing is asked of the host", async () => {
    await startDesktopTerminalOpacity();
    expect(desktopTerminalOpacity()).toBeNull();
    expect(onTauriEvent).not.toHaveBeenCalled();
    expect(readTerminalBackgroundOpacity).not.toHaveBeenCalled();
  });
});

describe("in a chan-desktop window", () => {
  test("it subscribes to the desktop's event before it asks, and applies the answer", async () => {
    const { calls } = installDesktop({ read: async () => 90 });
    await startDesktopTerminalOpacity();
    expect(calls).toEqual([
      `listen ${TERMINAL_BACKGROUND_OPACITY_EVENT}`,
      "invoke terminal_background_opacity",
    ]);
    expect(desktopTerminalOpacity()).toBe(90);
  });

  test("a second start asks nothing more", async () => {
    const { calls } = installDesktop();
    await Promise.all([startDesktopTerminalOpacity(), startDesktopTerminalOpacity()]);
    await startDesktopTerminalOpacity();
    expect(calls).toHaveLength(2);
  });

  test("an event applies its payload, clamped like a stored value", async () => {
    const { emit } = installDesktop();
    await startDesktopTerminalOpacity();
    emit({ percent: 85 });
    expect(desktopTerminalOpacity()).toBe(85);
    emit({ percent: 120 });
    expect(desktopTerminalOpacity()).toBe(100);
    emit({ percent: 10 });
    expect(desktopTerminalOpacity()).toBe(80);
    emit({ percent: "90" });
    expect(desktopTerminalOpacity(), "a non-number reads as opaque").toBe(100);
    emit({ percent: 85 });
    emit(null);
    expect(desktopTerminalOpacity(), "a payload with no percent reads as opaque").toBe(100);
  });

  test("an event that lands while the read is in flight wins over the read's answer", async () => {
    let answer: ((value: number) => void) | undefined;
    const { emit } = installDesktop({
      read: () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    });
    const started = startDesktopTerminalOpacity();
    await vi.waitFor(() => expect(answer).toBeDefined());
    emit({ percent: 85 });
    answer!(90);
    await started;
    expect(desktopTerminalOpacity()).toBe(85);
  });

  test("set writes { percent } through the host and applies what it wrote", async () => {
    const { invoke } = installDesktop();
    await startDesktopTerminalOpacity();
    await expect(setDesktopTerminalOpacity(90)).resolves.toBe(90);
    expect(invoke).toHaveBeenLastCalledWith("set_terminal_background_opacity", { percent: 90 });
    expect(desktopTerminalOpacity()).toBe(90);
  });

  test("set rounds and clamps before it writes, and clamps the host's answer", async () => {
    const { invoke } = installDesktop({ write: async () => 1000 });
    await expect(setDesktopTerminalOpacity(84.6)).resolves.toBe(100);
    expect(invoke).toHaveBeenLastCalledWith("set_terminal_background_opacity", { percent: 85 });
    expect(desktopTerminalOpacity()).toBe(100);
    await setDesktopTerminalOpacity(10);
    expect(invoke).toHaveBeenLastCalledWith("set_terminal_background_opacity", { percent: 80 });
  });

  test("a refused write rejects and leaves the value", async () => {
    installDesktop({
      write: async () => {
        throw new Error("refused");
      },
    });
    applyDesktopTerminalOpacity(90);
    await expect(setDesktopTerminalOpacity(85)).rejects.toThrow("refused");
    expect(desktopTerminalOpacity()).toBe(90);
  });

  test("a desktop that cannot answer leaves the terminals opaque", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installDesktop({
        read: async () => {
          throw new Error("not allowed");
        },
      });
      await startDesktopTerminalOpacity();
      expect(desktopTerminalOpacity()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("a reset drops the subscription", async () => {
    const { unlisten } = installDesktop();
    await startDesktopTerminalOpacity();
    resetDesktopTerminalOpacityForTests();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(desktopTerminalOpacity()).toBeNull();
  });
});

describe("applyDesktopTerminalOpacity", () => {
  test("clamps out-of-range values and reads a non-number as opaque", () => {
    expect(applyDesktopTerminalOpacity(120)).toBe(100);
    expect(desktopTerminalOpacity()).toBe(100);
    expect(applyDesktopTerminalOpacity(70)).toBe(80);
    expect(applyDesktopTerminalOpacity(84.4)).toBe(84);
    expect(applyDesktopTerminalOpacity("90")).toBe(100);
    expect(applyDesktopTerminalOpacity(Number.NaN)).toBe(100);
    expect(applyDesktopTerminalOpacity(undefined)).toBe(100);
    expect(desktopTerminalOpacity()).toBe(100);
  });
});
