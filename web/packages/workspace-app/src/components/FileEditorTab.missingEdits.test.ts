// @vitest-environment jsdom
//
// A tab whose file is gone while it still holds unsaved edits offers only
// choices that keep them: Save here writes them back to the tab's path,
// recreating the file, and Find and Close stay. Both re-opens load another
// read over the buffer, so they are offered only to a tab with nothing to
// lose, as before.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { dismissStatus, refreshWorkspace } from "../state/store.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const PANE = "missing-edits-pane";
const GONE = "notes/gone.md";
const OTHER = "notes/other.md";
const TYPED = "# Gone\n\nthe edits only this tab holds\n";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: OTHER, kind: "document", size: 8, mtime: 100, content: "# Other\n" }],
  });
  await refreshWorkspace();
});

afterEach(async () => {
  for (const view of mounted.splice(0)) unmount(view);
  document.body.innerHTML = "";
  dismissStatus();
  await settle();
  uninstallDemoWorkspace();
  timers.release();
  vi.restoreAllMocks();
});

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// A tab on GONE, whose file is not in the workspace, with the move lookup's
/// suggestion so both re-opens would show.
function missingTab(content: string, saved: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "gone-tab",
    path: GONE,
    content,
    saved,
    savedMtime: 1,
    savedMtimeNs: "1000000000",
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: { path: GONE, fragment: null, suggestedPath: OTHER },
    inspectorOpen: false,
    outlineOpen: false,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
}

async function host(seed: FileTab): Promise<HTMLElement> {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [seed], activeTabId: seed.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const tab = (layout.nodes[PANE] as LeafNode).tabs[0] as FileTab;
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(FileEditorTab, { target, props: { tab, active: true, focused: false } }));
  await settle();
  return target;
}

function labels(target: HTMLElement): string[] {
  return [...target.querySelectorAll<HTMLButtonElement>(".missing-actions button")].map(
    (b) => b.textContent?.trim() ?? "",
  );
}

describe("the missing state of a tab with unsaved edits", () => {
  test("offers Save here, Find and Close, and no re-open", async () => {
    const target = await host(missingTab(TYPED, "# Gone\n"));
    expect(labels(target)).toEqual(["Save here", "Find", "Close"]);
    expect(target.querySelector(".missing-file-state")?.textContent).toContain(
      "The unsaved edits are still in this tab.",
    );
  });

  test("Save here recreates the file with the tab's text", async () => {
    await expect(api.read(GONE), "the file is gone before the click").rejects.toThrow();
    const target = await host(missingTab(TYPED, "# Gone\n"));
    const save = [...target.querySelectorAll<HTMLButtonElement>(".missing-actions button")].find(
      (b) => b.textContent?.trim() === "Save here",
    );
    save!.click();
    await vi.waitFor(async () => expect((await api.read(GONE)).content).toBe(TYPED));
    await settle();
    expect(target.querySelector(".missing-file-state"), "the tab is the file's again").toBeNull();
    const tab = (layout.nodes[PANE] as LeafNode).tabs[0] as FileTab;
    expect(tab.saved).toBe(TYPED);
  });
});

describe("the missing state of a tab with nothing unsaved", () => {
  test("offers both re-opens, Find and Close, as before", async () => {
    const target = await host(missingTab("", ""));
    expect(labels(target)).toEqual(["Re-open there", "Re-open", "Find", "Close"]);
    expect(target.querySelector(".missing-file-state")?.textContent).not.toContain("unsaved edits");
  });
});
