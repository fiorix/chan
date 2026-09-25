// @vitest-environment jsdom
//
// A download in chan-desktop is streamed by the Rust side, and the transfer
// bubble is its one surface: the download begins a transfer, shows the
// native progress, and ends done with the saved path, failed with the
// reason, or cancelled when the user stops it.

import { afterEach, describe, expect, test, vi } from "vitest";
import { runDesktopDownload } from "./desktop";
import { transfers } from "../state/transfers.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  transfers.items = [];
  transfers.shown = false;
});

/// Stand in for the Tauri IPC with `answer`, recording every command.
function tauri(answer: (cmd: string, args: Record<string, unknown>) => unknown) {
  const invoke = vi.fn(async (cmd: string, args?: unknown) =>
    answer(cmd, (args ?? {}) as Record<string, unknown>),
  );
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
  return invoke;
}

const URL = "http://127.0.0.1:4000/api/fs/a.bin?download=1";

describe("a desktop download", () => {
  test("refuses outside chan-desktop", async () => {
    await expect(runDesktopDownload(URL, "a.bin")).rejects.toThrow(
      "runDesktopDownload called outside chan-desktop",
    );
    expect(transfers.items).toEqual([]);
  });

  test("shows the native progress, then ends done with the saved path", async () => {
    let finish: (value: { path: string }) => void = () => {};
    tauri((cmd) => {
      if (cmd === "native_transfer_status") return { loaded: 50, total: 200 };
      if (cmd === "download_file_native") return new Promise((resolve) => (finish = resolve));
      throw new Error(`unexpected ${cmd}`);
    });
    const download = runDesktopDownload(URL, "a.bin");

    await vi.waitFor(() =>
      expect(transfers.items).toMatchObject([{ kind: "download", filename: "a.bin", progress: 0.25 }]),
    );
    finish({ path: "/Downloads/a.bin" });

    await expect(download).resolves.toBe("/Downloads/a.bin");
    expect(transfers.items).toMatchObject([{ state: "done", savedPath: "/Downloads/a.bin" }]);
  });

  test("a failed download fails its transfer with the reason", async () => {
    tauri((cmd) => {
      if (cmd === "native_transfer_status") return null;
      throw new Error("disk full");
    });

    await expect(runDesktopDownload(URL, "a.bin")).rejects.toThrow("disk full");
    expect(transfers.items).toMatchObject([{ state: "failed", error: "disk full" }]);
  });

  test("cancelling the transfer cancels the native download", async () => {
    let refuse: (error: Error) => void = () => {};
    const invoke = tauri((cmd) => {
      if (cmd === "native_transfer_status") return null;
      if (cmd === "cancel_native_transfer") {
        refuse(new Error("download cancelled"));
        return true;
      }
      if (cmd === "download_file_native") return new Promise((_, reject) => (refuse = reject));
      throw new Error(`unexpected ${cmd}`);
    });
    const download = runDesktopDownload(URL, "a.bin");
    await vi.waitFor(() => expect(transfers.items[0]?.cancel).toBeTypeOf("function"));

    transfers.items[0]!.cancel!();

    await expect(download).rejects.toThrow("download cancelled");
    const started = invoke.mock.calls.find(([cmd]) => cmd === "download_file_native")!;
    expect(invoke).toHaveBeenCalledWith("cancel_native_transfer", {
      transferId: (started[1] as { transferId: string }).transferId,
    });
    expect(transfers.items[0]?.state).toBe("cancelled");
  });
});
