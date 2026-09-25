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
  pathPromptState,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
  ui,
} from "./store.svelte";
import { draftsDir } from "./workspace.svelte";

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
