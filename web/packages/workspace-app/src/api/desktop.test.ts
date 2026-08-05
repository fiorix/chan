import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  isTauriDesktop,
  openWebInspector,
  readGatewayCsrfToken,
  reloadWindow,
  runDesktopDownload,
  runDesktopUpload,
  saveBytesToDownloads,
  setWindowFullscreen,
  tauriInvoke,
} from "./desktop";
import { transfers } from "../state/transfers.svelte";

type W = Window & typeof globalThis & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

function clearTauriGlobals(): void {
  delete (window as W).__TAURI__;
  delete (window as W).__TAURI_INTERNALS__;
}

afterEach(() => {
  transfers.items = [];
  transfers.shown = false;
  vi.useRealTimers();
});

function setTauriInternals(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke },
    configurable: true,
  });
}

/// Tauri publishes the current window and webview labels through
/// `__TAURI_INTERNALS__.metadata`; the refusal record reads them from there.
function setTauriInternalsWithLabel(
  invoke: (cmd: string, args?: unknown) => Promise<unknown>,
  label: string,
): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      invoke,
      metadata: { currentWindow: { label }, currentWebview: { label } },
    },
    configurable: true,
  });
}

/// A fresh module instance, so the module-level refusal record starts null and
/// these cases stay order-independent.
async function freshDesktopModule(): Promise<typeof import("./desktop")> {
  vi.resetModules();
  return await import("./desktop");
}

describe("isTauriDesktop", () => {
  afterEach(clearTauriGlobals);

  test("returns false when neither global is set (web build)", () => {
    expect(isTauriDesktop()).toBe(false);
  });

  test("returns true when __TAURI__ is present (old Tauri runtime)", () => {
    Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
    expect(isTauriDesktop()).toBe(true);
  });

  test("returns true when __TAURI_INTERNALS__ is present (Tauri 2 runtime)", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    expect(isTauriDesktop()).toBe(true);
  });
});

describe("tauriInvoke", () => {
  afterEach(clearTauriGlobals);

  test("throws when no Tauri runtime is present", async () => {
    await expect(tauriInvoke("anything")).rejects.toThrow(/not running under Tauri/);
  });

  test("dispatches via __TAURI_INTERNALS__.invoke", async () => {
    const spy = vi.fn().mockResolvedValue("ok");
    setTauriInternals(spy);
    await expect(tauriInvoke("ping")).resolves.toBe("ok");
    expect(spy).toHaveBeenCalledWith("ping", undefined);
  });
});

describe("readGatewayCsrfToken", () => {
  afterEach(clearTauriGlobals);

  test("returns null outside Tauri", async () => {
    await expect(readGatewayCsrfToken()).resolves.toBeNull();
  });

  test("dispatches the no-argument gateway command", async () => {
    const invoke = vi.fn(async () => "csrf-current");
    setTauriInternals(invoke);

    await expect(readGatewayCsrfToken()).resolves.toBe("csrf-current");
    expect(invoke).toHaveBeenCalledWith("gateway_csrf_token", undefined);
  });

  test("treats an expected capability denial as unavailable", async () => {
    setTauriInternals(async () => {
      throw new Error("not allowed");
    });

    await expect(readGatewayCsrfToken()).resolves.toBeNull();
  });
});

/// The ACL refuses `gateway_csrf_token` before any command handler runs, so the
/// desktop side never sees the caller. These pin the webview-side record that
/// carries the refused window's origin and label into the console, which is what
/// distinguishes an origin that was never minted from a mismatched one.
describe("gateway CSRF refusal diagnostics", () => {
  afterEach(() => {
    clearTauriGlobals();
    vi.restoreAllMocks();
  });

  test("records the refused window's origin and label on a lib window", async () => {
    const desktop = await freshDesktopModule();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setTauriInternalsWithLabel(async () => {
      throw new Error("Not allowed to request resource");
    }, "lib-0a1b2c3d::w-4e5f6a7b");

    await expect(desktop.readGatewayCsrfToken()).resolves.toBeNull();

    expect(desktop.gatewayCsrfRefusal()).toEqual({
      origin: window.location.origin,
      windowLabel: "lib-0a1b2c3d::w-4e5f6a7b",
      webviewLabel: "lib-0a1b2c3d::w-4e5f6a7b",
      message: "Not allowed to request resource",
    });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("records a refusal whatever label the window presents", async () => {
    const desktop = await freshDesktopModule();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setTauriInternalsWithLabel(async () => {
      throw new Error("not allowed");
    }, "workspace-window");

    await expect(desktop.readGatewayCsrfToken()).resolves.toBeNull();
    // A window whose label the minted capability does not match is a candidate
    // explanation, so it must be recorded rather than filtered away.
    expect(desktop.gatewayCsrfRefusal()?.windowLabel).toBe("workspace-window");
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("logs one line per distinct refusal, not one per request", async () => {
    const desktop = await freshDesktopModule();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setTauriInternalsWithLabel(async () => {
      throw new Error("Not allowed to request resource");
    }, "lib-0a1b2c3d::w-4e5f6a7b");

    await desktop.readGatewayCsrfToken();
    await desktop.readGatewayCsrfToken();
    await desktop.readGatewayCsrfToken();

    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("blockedWindowMessage keeps the browser wording until a refusal", async () => {
    const desktop = await freshDesktopModule();
    expect(desktop.blockedWindowMessage("browser wording")).toBe("browser wording");
  });

  test("blockedWindowMessage names the desktop denial after a refusal", async () => {
    const desktop = await freshDesktopModule();
    vi.spyOn(console, "error").mockImplementation(() => {});
    setTauriInternalsWithLabel(async () => {
      throw new Error("Not allowed to request resource");
    }, "lib-0a1b2c3d::w-4e5f6a7b");
    await desktop.readGatewayCsrfToken();

    const message = desktop.blockedWindowMessage("browser wording");
    expect(message).not.toContain("browser wording");
    expect(message).toContain("chan-desktop denied native access");
    expect(message).toContain(window.location.origin);
    expect(message).toContain("lib-0a1b2c3d::w-4e5f6a7b");
  });
});

describe("reloadWindow dispatch", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    reloadSpy = vi.fn();
    originalLocation = window.location;
    // jsdom's `window.location.reload` is non-configurable, so swap
    // the whole `location` object instead of patching the field.
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, reload: reloadSpy },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    clearTauriGlobals();
    Object.defineProperty(window, "location", {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
  });

  test("falls back to window.location.reload() on web", async () => {
    await reloadWindow();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("invokes reload_window IPC on chan-desktop", async () => {
    const invokeSpy = vi.fn().mockResolvedValue(undefined);
    setTauriInternals(invokeSpy);
    await reloadWindow();
    expect(invokeSpy).toHaveBeenCalledWith("reload_window", undefined);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("falls back to window.location.reload() when reload_window IPC throws", async () => {
    const invokeSpy = vi.fn().mockRejectedValue(new Error("ipc fail"));
    setTauriInternals(invokeSpy);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reloadWindow();
    expect(invokeSpy).toHaveBeenCalledWith("reload_window", undefined);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });
});

describe("setWindowFullscreen dispatch", () => {
  afterEach(clearTauriGlobals);

  test("is a no-op on web (no Tauri runtime)", async () => {
    // Would throw in tauriInvoke if it reached the IPC; the guard returns first.
    await expect(setWindowFullscreen(true)).resolves.toBeUndefined();
  });

  test("invokes the core window set_fullscreen command on chan-desktop", async () => {
    const invokeSpy = vi.fn().mockResolvedValue(undefined);
    setTauriInternals(invokeSpy);
    await setWindowFullscreen(true);
    expect(invokeSpy).toHaveBeenCalledWith("plugin:window|set_fullscreen", {
      value: true,
    });
    await setWindowFullscreen(false);
    expect(invokeSpy).toHaveBeenLastCalledWith("plugin:window|set_fullscreen", {
      value: false,
    });
  });

  test("swallows a failed IPC so the caller never throws", async () => {
    const invokeSpy = vi.fn().mockRejectedValue(new Error("acl denied"));
    setTauriInternals(invokeSpy);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(setWindowFullscreen(true)).resolves.toBeUndefined();
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });
});

describe("openWebInspector dispatch", () => {
  afterEach(clearTauriGlobals);

  test("returns false on web (no Tauri runtime)", async () => {
    await expect(openWebInspector()).resolves.toBe(false);
  });

  test("invokes open_devtools IPC and returns true on chan-desktop", async () => {
    const invokeSpy = vi.fn().mockResolvedValue(undefined);
    setTauriInternals(invokeSpy);
    await expect(openWebInspector()).resolves.toBe(true);
    expect(invokeSpy).toHaveBeenCalledWith("open_devtools", undefined);
  });

  test("returns false when open_devtools IPC throws", async () => {
    const invokeSpy = vi.fn().mockRejectedValue(new Error("ipc fail"));
    setTauriInternals(invokeSpy);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(openWebInspector()).resolves.toBe(false);
    consoleWarn.mockRestore();
  });
});

describe("native streaming transfers", () => {
  afterEach(clearTauriGlobals);

  test("download delegates the URL to Rust without creating an XHR body", async () => {
    const invokeSpy = vi.fn(async (cmd: string) => {
      if (cmd === "native_transfer_status") return null;
      if (cmd === "download_file_native") return { path: "/Downloads/a.bin" };
      throw new Error(`unexpected ${cmd}`);
    });
    setTauriInternals(invokeSpy);

    await expect(
      runDesktopDownload(
        "http://127.0.0.1:4000/api/files/a.bin?download=1&t=x",
        "a.bin",
      ),
    ).resolves.toBe("/Downloads/a.bin");

    expect(invokeSpy).toHaveBeenCalledWith(
      "download_file_native",
      expect.objectContaining({
        url: "http://127.0.0.1:4000/api/files/a.bin?download=1&t=x",
        filename: "a.bin",
        transferId: expect.stringMatching(/^native-/),
      }),
    );
  });

  test("native upload returns server paths without File or byte IPC payloads", async () => {
    const invokeSpy = vi.fn(async (cmd: string) => {
      if (cmd === "native_transfer_status") return null;
      if (cmd === "upload_files_native") return [{ path: "docs/a.bin", size: 9 }];
      throw new Error(`unexpected ${cmd}`);
    });
    setTauriInternals(invokeSpy);

    const uploaded = await runDesktopUpload(
      { dir: "docs", multiple: true },
      "Upload files",
    );

    expect(uploaded).toEqual([{ path: "docs/a.bin", size: 9 }]);
    expect(invokeSpy).toHaveBeenCalledWith(
      "upload_files_native",
      expect.objectContaining({
        target: { dir: "docs", multiple: true },
        transferId: expect.stringMatching(/^native-/),
      }),
    );
  });

  test("generated bytes cross IPC only in bounded chunks", async () => {
    const appendSizes: number[] = [];
    const invokeSpy = vi.fn(async (cmd: string, args?: unknown) => {
      if (cmd === "begin_generated_download") return { handle: "sink-1" };
      if (cmd === "append_generated_download") {
        appendSizes.push(
          ((args as { bytes: number[] }).bytes).length,
        );
        return undefined;
      }
      if (cmd === "finish_generated_download") return { path: "/Downloads/report.pdf" };
      throw new Error(`unexpected ${cmd}`);
    });
    setTauriInternals(invokeSpy);

    await saveBytesToDownloads(new Uint8Array(128 * 1024 + 7), "report.pdf");

    expect(appendSizes).toEqual([64 * 1024, 64 * 1024, 7]);
  });
});
