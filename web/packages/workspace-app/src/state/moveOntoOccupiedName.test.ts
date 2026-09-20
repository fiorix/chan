// A move onto a name that is already taken is refused, and the refusal names
// the path. There is nothing to confirm: `preflight_rename` in chan-workspace
// answers 409 for any destination that already exists and is not the same
// file, so an overwrite is not something the product performs.
//
// These cases replace the source-text pin that guarded the directory branch
// and the confirm beside it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const moved = vi.hoisted(() => ({ calls: [] as Array<[string, string]> }));
const conflicts = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async () => []),
      move: vi.fn(async (from: string, to: string) => {
        moved.calls.push([from, to]);
        return { rewritten: [], conflicts: conflicts.paths };
      }),
    },
  };
});

import { fileOps, tree, ui } from "./store.svelte";

beforeEach(() => {
  moved.calls = [];
  conflicts.paths = [];
  ui.status = null;
  tree.entries = [
    { path: "a.md", is_dir: false, kind: "document", size: 1, mtime: null },
    { path: "taken.md", is_dir: false, kind: "document", size: 1, mtime: null },
    { path: "dir", is_dir: true, size: 0, mtime: null },
  ];
  tree.loadedDirs = { "": true };
  tree.loadingDirs = {};
  tree.dirErrors = {};
});

afterEach(() => {
  tree.entries = [];
  ui.status = null;
  vi.clearAllMocks();
});

describe("a move onto a name that is taken", () => {
  test("names the occupied file and asks the server nothing", async () => {
    await fileOps.moveTo("a.md", "taken.md");

    expect(moved.calls, "the server is not asked").toHaveLength(0);
    expect(ui.status).toBe("move failed: 'taken.md' already exists");
  });

  test("keeps the existing-directory refusal and its wording", async () => {
    await fileOps.moveTo("a.md", "dir");

    expect(moved.calls, "the server is not asked").toHaveLength(0);
    expect(ui.status).toBe("rename failed: 'dir' is an existing directory");
  });

  test("a free name still moves", async () => {
    await fileOps.moveTo("a.md", "free.md");

    expect(moved.calls).toEqual([["a.md", "free.md"]]);
  });

  test("a single move names its conflicts and counts the rest, as a many-move does", async () => {
    conflicts.paths = ["c1.md", "c2.md", "c3.md", "c4.md"];

    await fileOps.moveTo("a.md", "free.md");

    expect(ui.status).toContain("4 link conflicts: c1.md, c2.md, c3.md, and 1 more");
    expect(ui.status, "the rest are counted, not printed").not.toContain("c4.md");
  });
});
