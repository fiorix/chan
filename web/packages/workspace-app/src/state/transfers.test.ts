// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  beginTransfer,
  cancelAllTransfers,
  cancelTransfer,
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

describe("bounded transfer concurrency", () => {
  test("a third download queues visibly and drains when either slot completes", async () => {
    resetTransfers();
    const first = beginTransfer({
      kind: "download",
      filename: "one",
      cancel: null,
    });
    const second = beginTransfer({
      kind: "download",
      filename: "two",
      cancel: null,
    });
    const third = beginTransfer({
      kind: "download",
      filename: "three",
      cancel: null,
    });

    expect(transfers.items.map((transfer) => transfer.state)).toEqual([
      "active",
      "active",
      "queued",
    ]);
    const thirdSlot = waitForTransferSlot(third);
    finishTransfer(first);
    await expect(thirdSlot).resolves.toBe(true);
    expect(transfers.items.find((transfer) => transfer.id === third)?.state).toBe("active");
    finishTransfer(second);
    finishTransfer(third);
  });

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

  test("uploads use one slot and a queued cancellation never starts", async () => {
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
    const secondSlot = waitForTransferSlot(second);

    expect(transfers.items.map((transfer) => transfer.state)).toEqual([
      "active",
      "queued",
    ]);
    transfers.items.find((transfer) => transfer.id === second)?.cancel?.();
    await expect(secondSlot).resolves.toBe(false);
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(transfers.items.find((transfer) => transfer.id === second)?.state).toBe(
      "cancelled",
    );
    finishTransfer(first);
  });

  test("app shutdown cancels active and queued work deterministically", () => {
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

  test("shutdown cancellation wins over a queued waiter promoted mid-pass", async () => {
    resetTransfers();
    beginTransfer({ kind: "download", filename: "one", cancel: vi.fn() });
    beginTransfer({ kind: "download", filename: "two", cancel: vi.fn() });
    const queued = beginTransfer({
      kind: "download",
      filename: "three",
      cancel: vi.fn(),
    });
    const queuedSlot = waitForTransferSlot(queued);

    cancelAllTransfers();

    await expect(queuedSlot).resolves.toBe(false);
    expect(transfers.items.find((transfer) => transfer.id === queued)?.state).toBe(
      "cancelled",
    );
  });

  test("cancelled active transfer releases its slot to the oldest queued peer", async () => {
    resetTransfers();
    const first = beginTransfer({ kind: "download", filename: "one", cancel: null });
    beginTransfer({ kind: "download", filename: "two", cancel: null });
    const third = beginTransfer({ kind: "download", filename: "three", cancel: null });
    const thirdSlot = waitForTransferSlot(third);

    cancelTransfer(first);

    await expect(thirdSlot).resolves.toBe(true);
    expect(transfers.items.find((transfer) => transfer.id === third)?.state).toBe(
      "active",
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
