// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  beginTransfer,
  cancelAllTransfers,
  failTransfer,
  finishTransfer,
  restoreTransfers,
  setTransferProgress,
  transfers,
  waitForTransferSlot,
} from "./transfers.svelte";

function resetTransfers(): void {
  transfers.items = [];
  transfers.shown = false;
  window.sessionStorage.clear();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetTransfers();
});

// Admission belongs to the server, so there is no client-side concurrency
// suite here any more. What the browser still owns is the record: progress
// coalescing, cancellation, failure, and reload recovery. The server-reported
// half lives in transferQueueReporting.test.ts.
describe("transfer records", () => {
  test("progress is coalesced and never persists every producer tick", async () => {
    vi.useFakeTimers();
    resetTransfers();
    const id = beginTransfer({
      kind: "upload",
      filename: "many.bin",
      cancel: null,
    });
    const persist = vi.spyOn(Storage.prototype, "setItem");
    for (let tick = 1; tick <= 50; tick += 1) {
      setTransferProgress(id, tick / 50);
    }

    expect(persist.mock.calls.length).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(transfers.items[0]?.progress).toBe(1);
    expect(persist.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("cancelling one transfer leaves its peers alone", async () => {
    resetTransfers();
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const first = beginTransfer({
      kind: "upload",
      filename: "one",
      cancel: firstCancel,
    });
    const second = beginTransfer({
      kind: "upload",
      filename: "two",
      cancel: secondCancel,
    });

    transfers.items.find((transfer) => transfer.id === second)?.cancel?.();

    await expect(waitForTransferSlot(second)).resolves.toBe(false);
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(firstCancel).not.toHaveBeenCalled();
    expect(transfers.items.find((transfer) => transfer.id === second)?.state).toBe(
      "cancelled",
    );
    expect(transfers.items.find((transfer) => transfer.id === first)?.state).toBe(
      "active",
    );
    finishTransfer(first);
  });

  test("app shutdown cancels every in-flight transfer deterministically", () => {
    resetTransfers();
    const cancels = [vi.fn(), vi.fn(), vi.fn()];
    for (const [index, cancel] of cancels.entries()) {
      beginTransfer({
        kind: "download",
        filename: `${index}`,
        cancel,
      });
    }

    cancelAllTransfers();

    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
    expect(transfers.items.every((transfer) => transfer.state === "cancelled")).toBe(
      true,
    );
  });

  test("a shutdown-cancelled transfer will not be started afterwards", async () => {
    resetTransfers();
    beginTransfer({ kind: "download", filename: "one", cancel: vi.fn() });
    const last = beginTransfer({
      kind: "download",
      filename: "two",
      cancel: vi.fn(),
    });

    cancelAllTransfers();

    await expect(waitForTransferSlot(last)).resolves.toBe(false);
    expect(transfers.items.find((transfer) => transfer.id === last)?.state).toBe(
      "cancelled",
    );
  });

  test("failed downloads expose their deterministic retry handle", () => {
    resetTransfers();
    const retry = vi.fn();
    const id = beginTransfer({
      kind: "download",
      filename: "archive.zip",
      cancel: vi.fn(),
      source: { path: "archive", isDir: true },
    });

    failTransfer(id, "server restarted", retry);
    transfers.items.find((transfer) => transfer.id === id)?.retry?.();

    expect(retry).toHaveBeenCalledOnce();
    expect(transfers.items.find((transfer) => transfer.id === id)?.state).toBe(
      "failed",
    );
  });

  test("failed download retry reconstructs after a window reload", () => {
    resetTransfers();
    const id = beginTransfer({
      kind: "download",
      filename: "archive.zip",
      cancel: vi.fn(),
      source: { path: "archive", isDir: true },
    });
    failTransfer(id, "server restarted");
    transfers.items = [];
    const retry = vi.fn();

    restoreTransfers(() => retry);
    transfers.items[0]?.retry?.();

    expect(transfers.items[0]?.state).toBe("failed");
    expect(retry).toHaveBeenCalledOnce();
  });
});
