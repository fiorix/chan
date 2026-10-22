// @vitest-environment jsdom
//
// An upload in chan-desktop is sent by the Rust side, which carries no window
// or transfer tracking headers, so its cancel is the native cancel alone: the
// page asks the server to withdraw nothing.

import { afterEach, expect, test, vi } from "vitest";
import { runDesktopUpload } from "./desktop";
import { setFetchImpl } from "./transport";
import { transfers } from "../state/transfers.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  setFetchImpl(null);
  transfers.items = [];
  transfers.shown = false;
});

test("cancelling a native upload cancels it natively and asks the server for nothing", async () => {
  const requests: string[] = [];
  setFetchImpl(async (input) => {
    requests.push(new URL(input, "http://x").pathname);
    return new Response("{}", { status: 200 });
  });
  let refuse: (error: Error) => void = () => {};
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "native_transfer_status") return null;
    if (cmd === "cancel_native_transfer") {
      refuse(new Error("upload cancelled"));
      return true;
    }
    if (cmd === "upload_files_native") return new Promise((_, reject) => (refuse = reject));
    throw new Error(`unexpected ${cmd}`);
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });

  const upload = runDesktopUpload({ dir: "docs", multiple: true }, "Upload files");
  await vi.waitFor(() => expect(transfers.items[0]?.cancel).toBeTypeOf("function"));
  transfers.items[0]!.cancel!();

  await expect(upload).rejects.toThrow("upload cancelled");
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toContain("cancel_native_transfer");
  expect(transfers.items[0]?.state).toBe("cancelled");
  expect(requests, "no request reaches the server").toEqual([]);
});
