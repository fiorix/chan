// @vitest-environment jsdom

// The transfer bubble + the unified transfers model: a row renders per
// transfer, progress + cancel are wired to the live handles, and a reload
// restores an in-flight transfer as INTERRUPTED (never a frozen bar). Exercises
// the real Svelte 5 runtime (mount + reactive re-render).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import TransferBubble from "./TransferBubble.svelte";
import {
  transfers,
  beginTransfer,
  setTransferProgress,
  finishTransfer,
  cancelTransfer,
  restoreTransfers,
  showTransfers,
  setTransferSignalSink,
  activeTransferCount,
} from "../state/transfers.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
  transfers.items = [];
  transfers.shown = false;
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
});

function render(): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(TransferBubble, { target });
  return target;
}

describe("TransferBubble", () => {
  test("renders nothing until shown, then a row per active transfer with Cancel", () => {
    const el = render();
    expect(el.querySelector(".transfer-bubble")).toBeNull();

    const cancel = vi.fn();
    beginTransfer({ kind: "upload", filename: "notes.md", cancel });
    transfers.shown = true;
    flushSync();

    expect(el.querySelector(".transfer-bubble")).not.toBeNull();
    expect(el.textContent).toContain("Uploading notes.md");
    const btn = el.querySelector(".tb-action") as HTMLButtonElement;
    expect(btn.textContent).toBe("Cancel");
    btn.click();
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("queued transfers remain visible and cancellable", () => {
    beginTransfer({ kind: "upload", filename: "active.md", cancel: vi.fn() });
    const queuedCancel = vi.fn();
    beginTransfer({ kind: "upload", filename: "queued.md", cancel: queuedCancel });
    transfers.shown = true;
    const el = render();
    flushSync();

    expect(el.textContent).toContain("Queued queued.md");
    const actions = [...el.querySelectorAll(".tb-action")] as HTMLButtonElement[];
    expect(actions.map((button) => button.textContent)).toEqual(["Cancel", "Cancel"]);
    actions[1]!.click();
    expect(queuedCancel).toHaveBeenCalledOnce();
  });

  test("progress updates the bar width and percentage", () => {
    const id = beginTransfer({ kind: "download", filename: "data.bin", cancel: vi.fn() });
    transfers.shown = true;
    const el = render();
    setTransferProgress(id, 0.42);
    flushSync();
    expect(el.textContent).toContain("(42%)");
    const bar = el.querySelector(".tb-bar") as HTMLElement;
    expect(bar.style.width).toBe("42%");
  });

  test("a finished transfer shows a Dismiss action and counts as inactive", () => {
    const id = beginTransfer({ kind: "upload", filename: "a.md", cancel: vi.fn() });
    transfers.shown = true;
    expect(activeTransferCount()).toBe(1);
    finishTransfer(id);
    expect(activeTransferCount()).toBe(0);
    const el = render();
    flushSync();
    expect(el.textContent).toContain("Uploaded a.md");
    expect((el.querySelector(".tb-action") as HTMLButtonElement).textContent).toBe("Dismiss");
  });

  test("restore turns an in-flight transfer into INTERRUPTED, never a frozen bar", () => {
    // Persist an active upload + an active download, then restore (simulating a
    // window reload that killed both XHRs).
    beginTransfer({ kind: "upload", filename: "big.zip", cancel: vi.fn() });
    beginTransfer({
      kind: "download",
      filename: "dump.sql",
      cancel: vi.fn(),
      source: { path: "dump.sql", isDir: false },
    });
    setTransferProgress(transfers.items[1]!.id, 0.5);
    showTransfers(); // persists shown:true so restore can verify it round-trips

    // Fresh module state (as after reload) + restore from sessionStorage.
    transfers.items = [];
    const retry = vi.fn();
    restoreTransfers(() => retry);

    expect(transfers.shown).toBe(true);
    expect(transfers.items).toHaveLength(2);
    for (const t of transfers.items) {
      expect(t.state).toBe("interrupted");
      expect(t.progress).toBeNull(); // no frozen mid-transfer fraction
      expect(t.cancel).toBeNull();
    }
    // Download interrupted → a retry handle; upload → none (the File is gone).
    const up = transfers.items.find((t) => t.kind === "upload")!;
    const down = transfers.items.find((t) => t.kind === "download")!;
    expect(up.retry).toBeNull();
    expect(down.retry).toBe(retry);

    const el = render();
    flushSync();
    expect(el.textContent).toContain("Interrupted big.zip");
    expect(el.textContent).toContain("Interrupted dump.sql");
    // The interrupted download offers Retry; the interrupted upload Dismiss.
    const actions = [...el.querySelectorAll(".tb-action")].map((b) => b.textContent);
    expect(actions).toContain("Retry");
    expect(actions).toContain("Dismiss");
  });

  test("cancelTransfer marks the row cancelled (terminal, inactive)", () => {
    const id = beginTransfer({ kind: "upload", filename: "x.md", cancel: vi.fn() });
    cancelTransfer(id);
    expect(activeTransferCount()).toBe(0);
    expect(transfers.items[0]!.state).toBe("cancelled");
  });

  test("the signal sink fires the active count on start/end (the /ws emit feed)", () => {
    const seen: number[] = [];
    setTransferSignalSink((active) => seen.push(active));
    const id = beginTransfer({ kind: "upload", filename: "x.md", cancel: vi.fn() });
    finishTransfer(id);
    setTransferSignalSink(null);
    // begin -> 1, finish -> 0: the count the server tracks per socket.
    expect(seen).toEqual([1, 0]);
  });
});
