// Unit test: the launcher's Tauri event bridge (global `window.__TAURI__`).
//
// Off-desktop (no global) the bridge is a no-op so launcher boot never breaks;
// on desktop it subscribes via `__TAURI__.event.listen` and delivers the raw
// payload to the handler, returning the unlisten handle.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  hasTauriEvents,
  onTauriEvent,
  requestDesktopQuit,
  restartDesktopAfterUpdate,
} from "./desktop";

type W = Window & typeof globalThis & { __TAURI__?: unknown };

afterEach(() => {
  delete (window as W).__TAURI__;
});

describe("hasTauriEvents", () => {
  it("is false in a plain browser (no __TAURI__)", () => {
    expect(hasTauriEvents()).toBe(false);
  });

  it("is false when __TAURI__ has no event.listen", () => {
    Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
    expect(hasTauriEvents()).toBe(false);
  });

  it("is true when __TAURI__.event.listen is present", () => {
    Object.defineProperty(window, "__TAURI__", {
      value: { event: { listen: () => Promise.resolve(() => {}) } },
      configurable: true,
    });
    expect(hasTauriEvents()).toBe(true);
  });
});

describe("onTauriEvent", () => {
  it("returns a no-op unlisten off-desktop and never calls the handler", async () => {
    const handler = vi.fn();
    const unlisten = await onTauriEvent("devserver-control-attention", handler);
    expect(typeof unlisten).toBe("function");
    expect(handler).not.toHaveBeenCalled();
    unlisten(); // must not throw
  });

  it("subscribes and delivers the payload, returning the unlisten handle", async () => {
    const unlistenSpy = vi.fn();
    let captured: ((e: { payload: unknown }) => void) | null = null;
    const listen = vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
      captured = cb;
      return Promise.resolve(unlistenSpy);
    });
    Object.defineProperty(window, "__TAURI__", {
      value: { event: { listen } },
      configurable: true,
    });

    const handler = vi.fn();
    const unlisten = await onTauriEvent<string>("devserver-control-attention", handler);
    expect(listen).toHaveBeenCalledWith("devserver-control-attention", expect.any(Function));

    captured!({ payload: "ds-1" });
    expect(handler).toHaveBeenCalledWith("ds-1");

    unlisten();
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it("degrades to a no-op when listen rejects", async () => {
    Object.defineProperty(window, "__TAURI__", {
      value: { event: { listen: () => Promise.reject(new Error("boom")) } },
      configurable: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unlisten = await onTauriEvent("devserver-control-attention", vi.fn());
    expect(typeof unlisten).toBe("function");
    unlisten(); // must not throw
    warn.mockRestore();
  });
});

describe("restartDesktopAfterUpdate", () => {
  it("invokes the narrow restart app command", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI__", {
      value: { core: { invoke } },
      configurable: true,
    });

    await restartDesktopAfterUpdate();

    expect(invoke).toHaveBeenCalledWith("restart_desktop_after_update", undefined);
  });
});

describe("requestDesktopQuit", () => {
  it("invokes the narrow confirm-then-quit app command", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI__", {
      value: { core: { invoke } },
      configurable: true,
    });

    await requestDesktopQuit();

    expect(invoke).toHaveBeenCalledWith("request_app_quit", undefined);
  });
});
