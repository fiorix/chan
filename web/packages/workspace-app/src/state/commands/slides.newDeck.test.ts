// @vitest-environment jsdom
//
// New slide deck opens the fresh deck with the caret at the end of its
// "# Slide 1" heading, ready to type. Without an explicit caret request the
// open falls back to the editor's document-start default (inside the
// frontmatter block), and the post-load saved-caret restore can land a stale
// offset when a deleted draft's untitled-N name is reused.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import { demoWorkspaceInfo, type MockWorkspaceData } from "../../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../../demo/install";
import { readCaret, recordCaret } from "../caretIndex";
import { activePane, activeTabInPane, openInActivePane, type FileTab } from "../tabs.svelte";
import { workspace } from "../workspace.svelte";
import { fileTab, resetLayout } from "../../__tests__/tabs";
import { createSlidesAndOpen } from "./slides";

vi.mock("../tabs.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tabs.svelte")>();
  return { ...actual, openInActivePane: vi.fn(actual.openInActivePane) };
});

// chan-server's NEW_SLIDES_CONTENT seed (routes/drafts.rs).
const DECK = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1
* use \`@pagebreak\` on empty line to create new slide
`;
const DECK_PATH = ".Drafts/untitled-1/draft.md";
const HEADING_END = DECK.indexOf("# Slide 1") + "# Slide 1".length;

const DEMO: MockWorkspaceData = {
  metadata: {
    workspaceRoot: "demo",
    label: "demo",
    generatedAt: 1,
    fileCount: 1,
    textCount: 1,
  },
  files: [{ path: DECK_PATH, kind: "document", size: DECK.length, mtime: 1, content: DECK }],
};

beforeEach(() => {
  installDemoWorkspace(DEMO);
  vi.spyOn(api, "createDraft").mockResolvedValue({ path: DECK_PATH, name: "untitled-1" });
  resetLayout([]);
});

afterEach(() => {
  uninstallDemoWorkspace();
  workspace.info = null;
  vi.restoreAllMocks();
  localStorage.clear();
});

function activeFile(): FileTab {
  const tab = activeTabInPane(activePane());
  expect(tab?.kind).toBe("file");
  return tab as FileTab;
}

describe("New slide deck", () => {
  test("opens the deck with the caret at the end of its first heading", async () => {
    await createSlidesAndOpen();

    const deck = activeFile();
    expect(deck.path).toBe(DECK_PATH);
    expect(deck.caretCommand).toEqual({ from: HEADING_END, to: HEADING_END });
  });

  test("wins over a caret saved for a reused draft path", async () => {
    // The per-file caret index keys by workspace root and writes after a
    // debounce.
    workspace.info = demoWorkspaceInfo(DEMO);
    vi.useFakeTimers();
    recordCaret(DECK_PATH, 3, 3);
    vi.runAllTimers();
    vi.useRealTimers();
    expect(readCaret(DECK_PATH)).toEqual({ from: 3, to: 3 });
    await createSlidesAndOpen();

    expect(activeFile().caretCommand).toEqual({ from: HEADING_END, to: HEADING_END });
  });

  test("leaves another active tab's caret alone when the deck is not what opened", async () => {
    const other = fileTab({ id: "other", path: "notes/other.md", content: DECK, saved: DECK });
    resetLayout([other]);
    vi.mocked(openInActivePane).mockResolvedValueOnce(undefined);
    await createSlidesAndOpen();

    expect(activeFile().path).toBe("notes/other.md");
    expect(activeFile().caretCommand).toBeUndefined();
  });
});
