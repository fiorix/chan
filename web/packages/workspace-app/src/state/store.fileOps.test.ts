// @vitest-environment jsdom
//
// The File Browser's create and move operations in fileOps, over the in-memory
// demo workspace. The create prompts are answered through pathPromptState the
// way PathPromptModal answers them; the assertions read the prompt, the demo
// disk and the status line.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import type { MockWorkspaceStore } from "../demo/store";
import { trackTimers, type TimerTrack } from "../demo/timers";
import {
  browserSelection,
  fileOps,
  loadTreeDir,
  pathPromptState,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
  tree,
  ui,
} from "./store.svelte";
import { draftsDir, workspace } from "./workspace.svelte";

const DRAFTS_REASON = "Drafts are saved or discarded from editor tabs";

let disk: MockWorkspaceStore;
let timers: TimerTrack;

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function draft(rest: string): string {
  return `${draftsDir()}/${rest}`;
}

beforeEach(async () => {
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: ".Drafts/untitled/draft.md", kind: "document", size: 5, mtime: 100, content: "draft" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  ui.status = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (pathPromptState.open) resolvePathPrompt(null);
  await settle(2);
  uninstallDemoWorkspace();
  ui.status = null;
  timers.release();
});

describe("a move that touches Drafts", () => {
  test("from a draft is refused by name and leaves the disk alone", async () => {
    await fileOps.moveTo(draft("untitled/draft.md"), "notes/draft.md");

    expect(ui.status).toBe(`move failed: ${DRAFTS_REASON}`);
    expect(disk.get(draft("untitled/draft.md"))).toBeDefined();
    expect(disk.get("notes/draft.md")).toBeUndefined();
  });

  test("into Drafts is refused the same way", async () => {
    await fileOps.moveTo("notes/a.md", draft("untitled/a.md"));

    expect(ui.status).toBe(`move failed: ${DRAFTS_REASON}`);
    expect(disk.get("notes/a.md")).toBeDefined();
  });
});

describe("a backslash in a moved name", () => {
  const REFUSED = "rename failed: \\ cannot be added to a name";

  beforeEach(async () => {
    disk.create("a\\b.md", false, "kept");
    disk.create("deep/x\\y/keep.md", false, "keep");
    await refreshTree();
    ui.status = null;
  });

  test("a rename in place refuses a name that gains one, and sends nothing", async () => {
    const move = vi.spyOn(api, "move");
    await fileOps.renameInPlace("notes/a.md", "notes/a\\b");

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe(REFUSED);
    expect(disk.get("notes/a.md")?.content).toBe("hello");
  });

  test("a rename in place refuses a new directory whose name holds one", async () => {
    const move = vi.spyOn(api, "move");
    await fileOps.renameInPlace("notes/a.md", "p\\q/a.md");

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe(REFUSED);
  });

  test("a rename in place keeps the one a name holds", async () => {
    await fileOps.renameInPlace("a\\b.md", "a\\c");

    expect(ui.status).toBeNull();
    expect(disk.get("a\\c.md")?.content).toBe("kept");
    expect(disk.get("a\\b.md")).toBeUndefined();
  });

  test("a rename in place moves into a directory that holds one before the tree has listed it", async () => {
    expect(tree.loadedDirs.deep, "the directory's parent is not listed").toBeUndefined();
    await fileOps.renameInPlace("notes/a.md", "deep/x\\y/a.md");

    expect(ui.status).toBeNull();
    expect(disk.get("deep/x\\y/a.md")?.content).toBe("hello");
  });

  test("a drop's move refuses a target whose name gains one as a move, and sends nothing", async () => {
    const move = vi.spyOn(api, "move");
    await fileOps.moveTo("notes/a.md", "notes/a\\b.md");

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe("move failed: \\ cannot be added to a name");
    expect(disk.get("notes/a.md")?.content).toBe("hello");
  });

  test("a move into a directory that holds one waits for a listing of its parent that is in flight", async () => {
    const list = api.list.bind(api);
    let arrive: () => void = () => {};
    const held = new Promise<void>((resolve) => (arrive = resolve));
    vi.spyOn(api, "list").mockImplementation(async (dir) => {
      if (dir === "deep") await held;
      return list(dir);
    });
    // The tree lists an expanded directory by itself, and a move typed
    // meanwhile finds that listing in flight.
    const listing = loadTreeDir("deep");
    expect(tree.loadingDirs.deep).toBe(true);
    const move = fileOps.renameInPlace("notes/a.md", "deep/x\\y/a.md");
    await settle(1);
    arrive();
    await listing;
    await move;

    expect(ui.status).toBeNull();
    expect(disk.get("deep/x\\y/a.md")?.content).toBe("hello");
  });

  test("a move through a directory that cannot be listed is refused as that, by name, and sends nothing", async () => {
    const list = api.list.bind(api);
    vi.spyOn(api, "list").mockImplementation(async (dir) => {
      if (dir === "deep") throw new Error("permission denied");
      return list(dir);
    });
    const move = vi.spyOn(api, "move");
    await fileOps.renameInPlace("notes/a.md", "deep/x\\y/a.md");

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe("rename failed: 'deep' could not be listed");
  });

  test("a move onto a name that exists says so, though the name holds one", async () => {
    const move = vi.spyOn(api, "move");
    await fileOps.renameInPlace("notes/a.md", "a\\b.md");

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe("move failed: 'a\\b.md' already exists");
  });

  test("a drop's move keeps the one a name holds", async () => {
    await fileOps.moveTo("a\\b.md", "notes/a\\b.md");

    expect(ui.status).toBeNull();
    expect(disk.get("notes/a\\b.md")?.content).toBe("kept");
    expect(disk.get("a\\b.md")).toBeUndefined();
  });

  test.each([
    ["a rename in place", () => fileOps.renameInPlace("notes/a.md", "notes\\b"), "notes\\b.md"],
    ["a drop's move", () => fileOps.moveTo("notes/a.md", "notes\\b.md"), "notes\\b.md"],
  ])("on a Windows server %s sends a target in the server's spelling as typed", async (_name, run, target) => {
    workspace.info = { ...workspace.info!, root: "C:\\ws" };
    const move = vi.spyOn(api, "move");
    await run();

    expect({ sent: move.mock.calls, told: ui.status }).toEqual({ sent: [["notes/a.md", target]], told: null });
  });

  test("a rename answered with a name that gains one is refused by the move", async () => {
    const move = vi.spyOn(api, "move");
    const renamed = fileOps.rename("notes/a.md");
    await settle(2);
    expect(pathPromptState.sourcePath, "the prompt is told which entry it renames").toBe("notes/a.md");
    resolvePathPrompt("notes/a\\b.md");
    await renamed;

    expect(move).not.toHaveBeenCalled();
    expect(ui.status).toBe(REFUSED);
  });
});

describe("the create prompts", () => {
  for (const [name, open] of [
    ["New File", () => fileOps.createFile("notes")],
    ["New Directory", () => fileOps.createDir("notes")],
    ["New File or Directory", () => fileOps.createFileOrDir("notes")],
  ] as const) {
    test(`${name} rejects a path under Drafts in the dialog`, async () => {
      const created = open();
      await settle(2);
      expect(pathPromptState.open).toBe(true);

      expect(pathPromptState.validate?.(draft("x.md"))).toBe(DRAFTS_REASON);
      expect(pathPromptState.validate?.(draftsDir()!)).toBe(DRAFTS_REASON);
      expect(pathPromptState.validate?.("notes/x.md") ?? null).toBeNull();
      resolvePathPrompt(null);
      await created;
    });
  }
});

describe("New File or Directory", () => {
  test("opens one prompt at the parent that takes either shape", async () => {
    const created = fileOps.createFileOrDir("notes");
    await settle(2);

    expect(pathPromptState.kind).toBe("either");
    expect(pathPromptState.mode).toBe("create");
    expect(pathPromptState.defaultValue).toBe("notes/");
    resolvePathPrompt(null);
    await created;
  });

  test("a trailing-slash answer creates a directory and selects it", async () => {
    const created = fileOps.createFileOrDir("notes");
    await settle(2);
    const create = vi.spyOn(api, "create");
    resolvePathPrompt("notes/new/");
    await created;

    expect(create).toHaveBeenCalledWith("notes/new/", true);
    expect(ui.status).toBeNull();
    expect(browserSelection.path?.replace(/\/$/, "")).toBe("notes/new");
  });

  test("an answer without an extension creates a Markdown file", async () => {
    const created = fileOps.createFileOrDir("notes");
    await settle(2);
    const create = vi.spyOn(api, "create");
    resolvePathPrompt("notes/plain");
    await created;

    expect(create).toHaveBeenCalledWith("notes/plain.md", false, "");
    expect(disk.get("notes/plain.md")?.content).toBe("");
  });
});
