// @vitest-environment jsdom
//
// FB2 (File Browser clipboard): cmd/ctrl+C/X/V over the per-instance
// multi-selection. The store owns the clipboard state + the paste, which
// routes through POST /api/fs/transfer (op=copy for a copy, op=move for a
// cut). These tests pin the transitions + the wire op so the clipboard
// can't silently regress.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the transfer endpoint before the store module evaluates so the
// import binding the store reads is the mock.
const fsTransfer =
  vi.fn<
    (
      op: "move" | "copy",
      sources: string[],
      destDir: string,
    ) => Promise<{ moved: Array<{ from: string; to: string }>; skipped: string[]; conflicts: string[] }>
  >();

// `list` is part of the surface a paste touches: a cut checks the
// destination's listing for an occupied name before it sends anything, and
// the tree refreshes after the transfer lands.
const list = vi.fn<(dir: string) => Promise<unknown[]>>();

vi.mock("../api/client", () => ({
  api: {
    fsTransfer: (op: "move" | "copy", sources: string[], destDir: string) =>
      fsTransfer(op, sources, destDir),
    list: (dir: string) => list(dir),
  },
}));

let store: typeof import("./store.svelte");

beforeEach(async () => {
  vi.resetAllMocks();
  list.mockResolvedValue([]);
  store = await import("./store.svelte");
  store.fbClipboardClear();
  store.tree.entries = [];
  store.tree.loadedDirs = {};
  store.tree.loadingDirs = {};
  store.tree.dirErrors = {};
});

afterEach(() => {
  store.fbClipboardClear();
});

describe("FB clipboard (FB2)", () => {
  test("copy captures a snapshot of the selection as mode=copy", () => {
    store.fbClipboardSet("copy", ["notes/a.md", "notes/b.md"]);
    expect(store.fbClipboard.mode).toBe("copy");
    expect(store.fbClipboard.paths).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("cut captures the selection as mode=cut", () => {
    store.fbClipboardSet("cut", ["notes/a.md"]);
    expect(store.fbClipboard.mode).toBe("cut");
    expect(store.fbClipboard.paths).toEqual(["notes/a.md"]);
  });

  test("set is a no-op for an empty selection", () => {
    store.fbClipboardSet("copy", []);
    expect(store.fbClipboard.mode).toBeNull();
    expect(store.fbClipboard.paths).toEqual([]);
  });

  test("the snapshot is independent of later selection mutation", () => {
    const sel = ["notes/a.md", "notes/b.md"];
    store.fbClipboardSet("copy", sel);
    sel.push("notes/c.md"); // mutate the caller's array after capture
    expect(store.fbClipboard.paths).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("paste of a copy calls fsTransfer with op=copy and keeps the clipboard", async () => {
    fsTransfer.mockResolvedValue({
      moved: [{ from: "notes/a.md", to: "archive/a.md" }],
      skipped: [],
      conflicts: [],
    });
    store.fbClipboardSet("copy", ["notes/a.md"]);
    const landed = await store.fbClipboardPaste("archive");
    expect(fsTransfer).toHaveBeenCalledWith("copy", ["notes/a.md"], "archive");
    expect(landed).toEqual(["archive/a.md"]);
    // A copy clipboard persists so it can be pasted again.
    expect(store.fbClipboard.mode).toBe("copy");
  });

  test("paste of a cut calls fsTransfer with op=move and clears the clipboard", async () => {
    fsTransfer.mockResolvedValue({
      moved: [{ from: "notes/a.md", to: "archive/a.md" }],
      skipped: [],
      conflicts: [],
    });
    store.fbClipboardSet("cut", ["notes/a.md"]);
    const landed = await store.fbClipboardPaste("archive");
    expect(fsTransfer).toHaveBeenCalledWith("move", ["notes/a.md"], "archive");
    expect(landed).toEqual(["archive/a.md"]);
    // A cut is one-shot: the clipboard empties so the source can't be
    // moved a second time.
    expect(store.fbClipboard.mode).toBeNull();
    expect(store.fbClipboard.paths).toEqual([]);
  });

  test("paste of a cut onto an occupied name is refused and keeps the clipboard", async () => {
    // Same answer a single move gives: the name is taken, so nothing is sent
    // and the path is named. The clipboard survives so the user can paste
    // somewhere else without re-cutting.
    store.tree.entries = [
      { path: "archive", is_dir: true, size: 0, mtime: null },
      { path: "archive/a.md", is_dir: false, size: 1, mtime: null },
    ] as never;
    store.tree.loadedDirs = { archive: true };
    store.fbClipboardSet("cut", ["notes/a.md"]);

    const landed = await store.fbClipboardPaste("archive");

    expect(fsTransfer).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
    expect(store.ui.status).toBe("paste failed: 'archive/a.md' already exists");
    expect(store.fbClipboard.mode).toBe("cut");
  });

  test("pasting a cut into the directory it already sits in is not a collision", async () => {
    // The server skips a move into a source's own parent and reports it in
    // `skipped`; it is a no-op, not a name taken by something else. The drag
    // gesture never reaches this because isInvalidDrop filters it, but a paste
    // resolves a file selection to its parent, so cutting and pasting without
    // moving the selection lands here.
    store.tree.entries = [
      { path: "notes", is_dir: true, size: 0, mtime: null },
      { path: "notes/a.md", is_dir: false, size: 1, mtime: null },
    ] as never;
    store.tree.loadedDirs = { notes: true };
    fsTransfer.mockResolvedValue({
      moved: [],
      skipped: ["notes/a.md"],
      conflicts: [],
    });
    store.fbClipboardSet("cut", ["notes/a.md"]);

    await store.fbClipboardPaste("notes");

    expect(fsTransfer).toHaveBeenCalledWith("move", ["notes/a.md"], "notes");
    expect(String(store.ui.status ?? "")).not.toContain("already exists");
  });

  test("paste with an empty clipboard is a no-op (no transfer call)", async () => {
    const landed = await store.fbClipboardPaste("archive");
    expect(fsTransfer).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
  });

  test("clear empties the clipboard", () => {
    store.fbClipboardSet("cut", ["notes/a.md"]);
    store.fbClipboardClear();
    expect(store.fbClipboard.mode).toBeNull();
    expect(store.fbClipboard.paths).toEqual([]);
  });

  test("a failed paste keeps the clipboard (so the user can retry)", async () => {
    fsTransfer.mockRejectedValue(new Error("boom"));
    store.fbClipboardSet("cut", ["notes/a.md"]);
    const landed = await store.fbClipboardPaste("archive");
    expect(landed).toEqual([]);
    // Not cleared on failure: a cut that errored is still pending.
    expect(store.fbClipboard.mode).toBe("cut");
  });
});
