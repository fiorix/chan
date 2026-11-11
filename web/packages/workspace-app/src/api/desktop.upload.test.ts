// @vitest-environment jsdom
//
// An upload in chan-desktop is sent by the Rust side, which carries no window
// or transfer tracking headers, so its cancel is the native cancel alone: the
// page asks the server to withdraw nothing.
//
// Its transfer row begins while the native picker is still open, before the
// page knows any file. The row waits for the selection, then names what was
// picked from the desktop's status, the file's name for one file and the
// count for several, and never reads as a verb before a sentence. A picker
// closed without a choice leaves no row, as a browser picker's does.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runDesktopUpload } from "./desktop";
import { setFetchImpl } from "./transport";
import TransferBubble from "../components/TransferBubble.svelte";
import { restoreTransfers, transfers } from "../state/transfers.svelte";

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

  const upload = runDesktopUpload({ dir: "docs", multiple: true }, null);
  await vi.waitFor(() => expect(transfers.items[0]?.cancel).toBeTypeOf("function"));
  transfers.items[0]!.cancel!();

  await expect(upload).rejects.toThrow("upload cancelled");
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toContain("cancel_native_transfer");
  expect(transfers.items[0]?.state).toBe("cancelled");
  expect(requests, "no request reaches the server").toEqual([]);
});

describe("a desktop upload's transfer row", () => {
  type Status = { loaded: number; total: number | null; picked?: unknown };

  let target: HTMLElement | null = null;
  let bubble: Record<string, unknown> | null = null;

  beforeEach(() => {
    window.sessionStorage.clear();
    target = document.createElement("div");
    document.body.appendChild(target);
    bubble = mount(TransferBubble, { target });
    transfers.shown = true;
  });

  afterEach(() => {
    if (bubble) unmount(bubble);
    target?.remove();
    target = null;
    bubble = null;
  });

  /// The rows' texts as the bubble renders them.
  function lines(): (string | null)[] {
    flushSync();
    return [...target!.querySelectorAll(".tb-line")].map((line) => line.textContent);
  }

  /// Wait until `check` passes, looking often. The page polls the desktop
  /// every 100 ms, and the bound leaves a loaded host room for a few polls.
  function eventually(check: () => void): Promise<void> {
    return vi.waitFor(check, { timeout: 3000, interval: 10 });
  }

  /// A desktop whose picker is open: no selection in its status, and an
  /// upload that stays unsettled until the test ends it. `pick` is the
  /// desktop validating a selection, `finish` and `fail` end the upload,
  /// `refuse` ends it with the value a desktop's refusal carries over IPC (a
  /// bare reason, or a named failure), and a native cancel refuses it, as the
  /// desktop does. `holdStatus` leaves the status polls asked from then on
  /// unanswered until the test answers.
  function desktop() {
    let status: Status | null = { loaded: 0, total: null };
    let settle: { resolve: (files: unknown) => void; reject: (error: unknown) => void } | null = null;
    let held: ((status: Status | null) => void)[] | null = null;
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "native_transfer_status") {
        if (held) return new Promise((resolve) => held!.push(resolve));
        return status;
      }
      if (cmd === "cancel_native_transfer") {
        status = null;
        settle?.reject(new Error("upload cancelled"));
        return true;
      }
      if (cmd === "upload_files_native") {
        return new Promise((resolve, reject) => (settle = { resolve, reject }));
      }
      throw new Error(`unexpected ${cmd}`);
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke }, configurable: true });
    const started = (): Promise<void> => eventually(() => expect(settle).not.toBeNull());
    return {
      invoke,
      pick(next: Status): void {
        status = next;
      },
      async finish(files: { path: string; size: number }[]): Promise<void> {
        await started();
        status = null;
        settle!.resolve(files);
      },
      async fail(message: string): Promise<void> {
        await started();
        status = null;
        settle!.reject(new Error(message));
      },
      async refuse(refusal: unknown): Promise<void> {
        await started();
        status = null;
        settle!.reject(refusal);
      },
      holdStatus(): { asked: () => number; answer: (late: Status) => void } {
        const polls: ((status: Status | null) => void)[] = [];
        held = polls;
        return {
          asked: () => polls.length,
          answer: (late) => polls.forEach((resolve) => resolve(late)),
        };
      },
    };
  }

  test("waits for the selection, then names the one picked file to the end", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);

    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));
    expect(target!.querySelector(".tb-bar.indeterminate"), "no bytes move yet").toBeNull();
    expect(target!.querySelector(".tb-action")?.textContent).toBe("Cancel");

    native.pick({ loaded: 50, total: 200, picked: { name: "report.pdf", count: 1 } });
    await eventually(() => expect(lines()).toEqual(["Uploading report.pdf (25%)"]));

    await native.finish([{ path: "dev/report.pdf", size: 200 }]);
    await expect(upload).resolves.toEqual([{ path: "dev/report.pdf", size: 200 }]);
    expect(lines()).toEqual(["Uploaded report.pdf"]);
  });

  test("names several picked files by their count", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);

    native.pick({ loaded: 30, total: 60, picked: { name: "a.md", count: 3 } });
    await eventually(() => expect(lines()).toEqual(["Uploading 3 files (50%)"]));

    await native.finish(["a.md", "b.md", "c.md"].map((name) => ({ path: `dev/${name}`, size: 20 })));
    await upload;
    expect(lines()).toEqual(["Uploaded 3 files"]);
  });

  test.each([
    ["one file", [{ path: "dev/sub/report.pdf", size: 9 }], "Uploaded report.pdf"],
    ["one file at the root", [{ path: "report.pdf", size: 9 }], "Uploaded report.pdf"],
    ["one file under a Windows host path", [{ path: "C:\\in\\report.pdf", size: 9 }], "Uploaded report.pdf"],
    ["two files", [{ path: "dev/a.md", size: 1 }, { path: "dev/b.md", size: 1 }], "Uploaded 2 files"],
  ])("an upload that ends before a status named it is named by what the server stored: %s", async (_case, stored, line) => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.finish(stored);
    await upload;

    expect(lines()).toEqual([line]);
  });

  test("a desktop that reports no selection leaves the row unnamed once its total says files are moving", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    native.pick({ loaded: 100, total: 200 });
    await eventually(() => expect(lines()).toEqual(["Uploading files (50%)"]));

    await native.fail("upload failed: HTTP 503 Service Unavailable");
    await expect(upload).rejects.toThrow("HTTP 503");
    expect(lines()).toEqual(["Failed upload: upload failed: HTTP 503 Service Unavailable"]);
  });

  test.each([
    ["an empty name", { name: "", count: 1 }],
    ["a name that is not text", { name: 7, count: 1 }],
    ["no files", { name: "a.md", count: 0 }],
    ["a count that is not whole", { name: "a.md", count: 1.5 }],
    ["a count that is not a number", { name: "a.md", count: "3" }],
  ])("a selection of another shape names nothing: %s", async (_case, picked) => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);

    native.pick({ loaded: 100, total: 200, picked });
    await eventually(() => expect(lines()).toEqual(["Uploading files (50%)"]));

    await native.fail("disk full");
    await expect(upload).rejects.toThrow("disk full");
  });

  test("a cancel while the picker is open reads as a cancelled upload", async () => {
    desktop();
    const cancelled = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));
    transfers.items[0]!.cancel!();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError", message: "upload cancelled" });
    expect(lines()).toEqual(["Cancelled upload"]);
  });

  test("a picker closed without a choice leaves no row", async () => {
    const native = desktop();
    const dismissed = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.finish([]);
    await expect(dismissed).resolves.toEqual([]);
    expect(lines()).toEqual([]);
    expect(transfers.items, "no record either, so a reload restores none").toEqual([]);
  });

  test("the page asks the desktop for a named failure", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);

    await native.finish([{ path: "dev/report.pdf", size: 9 }]);
    await upload;
    expect(native.invoke).toHaveBeenCalledWith(
      "upload_files_native",
      expect.objectContaining({ namedFailure: true }),
    );
  });

  // The pick and the failure land between two status polls, so no poll read
  // the selection: only the failure can name the row.
  test.each([
    ["one file", { name: "report.pdf", count: 1 }, "Failed report.pdf: HTTP 409 Conflict"],
    ["several files", { name: "a.md", count: 3 }, "Failed 3 files: HTTP 409 Conflict"],
    ["no selection yet", undefined, "Failed upload: HTTP 409 Conflict"],
    ["a selection of another shape", { name: "a.md", count: 0 }, "Failed upload: HTTP 409 Conflict"],
  ])("a failure before any status named the row names it from the failure: %s", async (_case, picked, line) => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.refuse({ message: "HTTP 409 Conflict", picked });
    await expect(upload).rejects.toThrow(new Error("HTTP 409 Conflict"));
    expect(lines()).toEqual([line]);
  });

  test("a desktop that answers the bare reason leaves the row unnamed", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.refuse("HTTP 409 Conflict");
    await expect(upload).rejects.toThrow(new Error("HTTP 409 Conflict"));
    expect(lines()).toEqual(["Failed upload: HTTP 409 Conflict"]);
  });

  test("a named failure that is a cancel reads as a cancel", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.refuse({ message: "upload cancelled", picked: { name: "report.pdf", count: 1 } });
    await expect(upload).rejects.toMatchObject({ name: "AbortError", message: "upload cancelled" });
    expect(lines()).toEqual(["Cancelled report.pdf"]);
  });

  test("a cancel and a failure after the pick name the picked file", async () => {
    const native = desktop();
    const cancelled = runDesktopUpload({ dir: "dev", multiple: true }, null);
    native.pick({ loaded: 50, total: 200, picked: { name: "report.pdf", count: 1 } });
    await eventually(() => expect(lines()).toEqual(["Uploading report.pdf (25%)"]));
    transfers.items[0]!.cancel!();
    await expect(cancelled).rejects.toThrow("upload cancelled");
    expect(lines()).toEqual(["Cancelled report.pdf"]);

    const failed = runDesktopUpload({ dir: "dev", multiple: true }, null);
    native.pick({ loaded: 0, total: 200, picked: { name: "big.iso", count: 1 } });
    await eventually(() => expect(lines()[1]).toBe("Uploading big.iso (0%)"));
    await native.fail("disk full");
    await expect(failed).rejects.toThrow("disk full");
    expect(lines()).toEqual(["Cancelled report.pdf", "Failed big.iso: disk full"]);
  });

  test("a failure before any file is known reads as a failed upload", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    await native.fail("scheduling native upload picker: closed");
    await expect(upload).rejects.toThrow("closed");
    expect(lines()).toEqual(["Failed upload: scheduling native upload picker: closed"]);
  });

  test("a status that arrives after the upload ended leaves the row as it ended", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    const late = native.holdStatus();
    await eventually(() => expect(late.asked(), "a poll is in flight").toBe(1));
    await native.fail("disk full");
    await expect(upload).rejects.toThrow("disk full");
    late.answer({ loaded: 50, total: 200, picked: { name: "report.pdf", count: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lines()).toEqual(["Failed upload: disk full"]);
  });

  test("a replace keeps its target's name whatever file is picked", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ path: "notes/a.md", multiple: false }, "a.md");
    await eventually(() => expect(lines()).toEqual(["Waiting for file selection"]));

    native.pick({ loaded: 5, total: 10, picked: { name: "local draft.md", count: 1 } });
    await eventually(() => expect(lines()).toEqual(["Uploading a.md (50%)"]));

    await native.finish([{ path: "notes/a.md", size: 10 }]);
    await upload;
    expect(lines()).toEqual(["Uploaded a.md"]);
  });

  test("the picked name is in the record a reload restores as interrupted", async () => {
    const native = desktop();
    const upload = runDesktopUpload({ dir: "dev", multiple: true }, null);
    native.pick({ loaded: 50, total: 200, picked: { name: "report.pdf", count: 1 } });
    await eventually(() => expect(lines()).toEqual(["Uploading report.pdf (25%)"]));

    // The page as a reload leaves it: the stored record, and no live row.
    transfers.items = [];
    restoreTransfers(() => vi.fn());
    expect(lines()).toEqual(["Interrupted report.pdf (window reloaded)"]);

    await native.fail("upload cancelled");
    await expect(upload).rejects.toThrow("upload cancelled");
  });
});
