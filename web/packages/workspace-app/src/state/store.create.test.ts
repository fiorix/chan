// @vitest-environment jsdom
//
// What the create flows leave in front of the user once the path exists: an
// editable file opens in the active pane at its top, rendered when it is a
// document and in source mode when it is source; a directory is selected in
// the file browser and nothing opens. Opening goes through the same path
// every other open uses, which peeks a file whose extension is not known to
// be text and refuses it only when the server calls it binary.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import {
  browserSelection,
  fileOps,
  pathPromptState,
  resolvePathPrompt,
  ui,
} from "./store.svelte";
import {
  activePane,
  activeTabInPane,
  openInActivePane,
  type FileTab,
} from "./tabs.svelte";
import { resetLayout } from "../__tests__/tabs";

beforeEach(() => {
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 1, textCount: 1 },
    files: [
      { path: "notes/readme.custom", kind: "text", size: 5, mtime: 1, content: "hello" },
      { path: "photo.raw", kind: "binary", size: 5, mtime: 1, content: "" },
    ],
  });
  resetLayout([]);
});

afterEach(() => {
  uninstallDemoWorkspace();
  ui.status = null;
  ui.statusKind = null;
  vi.restoreAllMocks();
});

/// Run a create flow and answer its path prompt with `answer`.
async function create(flow: Promise<void>, answer: string): Promise<void> {
  await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
  resolvePathPrompt(answer);
  await flow;
}

function activeFile(): FileTab | undefined {
  const tab = activeTabInPane(activePane());
  return tab?.kind === "file" ? tab : undefined;
}

describe("creating a file or directory", () => {
  test("a new document opens rendered, at its top", async () => {
    await create(fileOps.createFileOrDir(""), "notes/new.md");

    expect(activeFile()).toMatchObject({
      path: "notes/new.md",
      mode: "wysiwyg",
      caretCommand: { from: 0, to: 0 },
    });
  });

  test("a new source file opens in source mode", async () => {
    await create(fileOps.createFileOrDir(""), "build.sh");

    expect(activeFile()).toMatchObject({ path: "build.sh", mode: "source" });
  });

  test("New file adds .md to a bare name and opens it", async () => {
    await create(fileOps.createFile(""), "notes/plain");

    expect(activeFile()).toMatchObject({ path: "notes/plain.md", mode: "wysiwyg" });
  });

  test("a new directory is selected in the browser and nothing opens", async () => {
    await create(fileOps.createFileOrDir(""), "sub/");

    expect(browserSelection.path).toBe("sub/");
    expect(activePane().tabs).toEqual([]);
  });

  test("New directory selects it too", async () => {
    await create(fileOps.createDir(""), "dir");

    expect(browserSelection.path).toBe("dir");
    expect(activePane().tabs).toEqual([]);
  });
});

describe("opening a file whose extension is not known to be text", () => {
  test("opens it once the server reads it as text", async () => {
    await openInActivePane("notes/readme.custom");

    expect(activeFile()?.path).toBe("notes/readme.custom");
  });

  test("refuses it with a notice when the server calls it binary", async () => {
    vi.spyOn(api, "readStream").mockRejectedValue(new ApiError(415, "binary"));
    await openInActivePane("photo.raw");

    expect(activePane().tabs).toEqual([]);
    expect(ui.status).toBe("'photo.raw' cannot be opened in the editor");
  });
});
