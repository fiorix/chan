// @vitest-environment jsdom
//
// copyTextToClipboard is the copy behind the UI's Copy actions. In
// chan-desktop it writes through the native clipboard, which needs no user
// gesture; in a browser it writes through the Clipboard API. Either way it
// reports the outcome through the caller's callbacks and never throws.

import { afterEach, describe, expect, test, vi } from "vitest";
import { copyTextToClipboard } from "./store.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

function setDesktopBridge(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
}

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  setClipboard(undefined);
  vi.restoreAllMocks();
});

async function copy(text: string): Promise<{ onSuccess: () => void; onError: (msg: string) => void }> {
  const onSuccess = vi.fn();
  const onError = vi.fn();
  await copyTextToClipboard(text, { onSuccess, onError });
  return { onSuccess, onError };
}

describe("copyTextToClipboard", () => {
  test("on the desktop, writes through the native clipboard where the webview has no Clipboard API", async () => {
    const invoke = vi.fn(async () => undefined);
    setDesktopBridge(invoke);

    const { onSuccess, onError } = await copy("notes/a.md");

    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "notes/a.md" });
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  // Tauri rejects a failed command with the bare string its Result carried, so
  // the report is the helper's own message.
  test("on the desktop, reports a failed native write that has no Clipboard API to fall back on", async () => {
    setDesktopBridge(async () => Promise.reject("not allowed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { onSuccess, onError } = await copy("notes/a.md");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Failed to copy to clipboard");
  });

  test("in a browser, writes through the Clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    const { onSuccess, onError } = await copy("notes/a.md");

    expect(writeText).toHaveBeenCalledWith("notes/a.md");
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  test("in a browser without the Clipboard API, reports it unavailable", async () => {
    const { onSuccess, onError } = await copy("notes/a.md");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Clipboard unavailable");
  });

  test("reports a refused write with the refusal's message", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("Write permission denied."))) });

    const { onSuccess, onError } = await copy("notes/a.md");

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Write permission denied.");
  });
});
