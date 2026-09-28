// @vitest-environment jsdom
//
// A tab whose file moved offers Re-open, which asks the user to pick the
// moved file in Files, and Re-open there, which opens the path the lookup
// suggested. Either one replaces the missing tab with the file it opens. A
// re-open the user leaves must not wait for the next file opened into that
// pane: the pick is live only while its instruction shows in the status bar,
// and the suggested re-open ends when its own open settles.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileEditorTab from "./FileEditorTab.svelte";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { dismissStatus, refreshWorkspace, ui } from "../state/store.svelte";
import { layout, openInPane, type FileTab, type FileMissingState, type LeafNode } from "../state/tabs.svelte";

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

const PANE = "missing-reopen-pane";
const NEXT = "notes/next.md";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: NEXT, kind: "document", size: 7, mtime: 100, content: "# Next\n" }],
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

function missingTab(fileMissing: FileMissingState): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "moved-tab",
    path: "notes/moved.md",
    content: "",
    saved: "",
    savedMtime: 1,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
}

async function hostMissingTab(fileMissing: FileMissingState): Promise<HTMLElement> {
  const seed = missingTab(fileMissing);
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [seed], activeTabId: seed.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const tab = (layout.nodes[PANE] as LeafNode).tabs[0] as FileTab;
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(FileEditorTab, { target, props: { tab, active: true, focused: false } }));
  await settle();
  return target;
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".missing-actions button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function paneFileTabs(): Array<{ id: string; path: string; missing: boolean }> {
  return (layout.nodes[PANE] as LeafNode).tabs
    .filter((t): t is FileTab => t.kind === "file")
    .map((t) => ({ id: t.id, path: t.path, missing: t.fileMissing !== null }));
}

describe("a re-open the user leaves", () => {
  test("a pick whose instruction was dismissed opens the next file beside the missing tab", async () => {
    const target = await hostMissingTab({ path: "notes/moved.md", fragment: null });
    button(target, "Re-open").click();
    await settle();
    expect(ui.status, "the pick asks for the moved file").toBe("Choose the moved file in Files to re-open this tab");
    expect(paneFileTabs(), "the tab is still missing").toEqual([{ id: "moved-tab", path: "notes/moved.md", missing: true }]);

    dismissStatus();
    await openInPane(PANE, NEXT);
    await settle();

    expect(paneFileTabs().find((t) => t.id === "moved-tab"), "the missing tab stays").toEqual({
      id: "moved-tab",
      path: "notes/moved.md",
      missing: true,
    });
    expect(paneFileTabs().some((t) => t.id !== "moved-tab" && t.path === NEXT), "the file opens beside").toBe(true);
  });

  test("a pick made while its instruction shows replaces the missing tab", async () => {
    const target = await hostMissingTab({ path: "notes/moved.md", fragment: null });
    button(target, "Re-open").click();
    await settle();

    await openInPane(PANE, NEXT);
    await settle();

    expect(paneFileTabs()).toEqual([{ id: "moved-tab", path: NEXT, missing: false }]);
  });

  test("a suggested re-open whose open was refused leaves the next file beside the missing tab", async () => {
    const readStream = api.readStream.bind(api);
    vi.spyOn(api, "readStream").mockImplementation((path, opts) =>
      path === "notes/blob.bin"
        ? Promise.reject(new ApiError(415, "not a text file"))
        : readStream(path, opts),
    );
    const target = await hostMissingTab({ path: "notes/moved.md", fragment: null, suggestedPath: "notes/blob.bin" });
    button(target, "Re-open there").click();
    await settle();
    expect(paneFileTabs(), "the refused open leaves the tab missing").toEqual([
      { id: "moved-tab", path: "notes/moved.md", missing: true },
    ]);

    await openInPane(PANE, NEXT);
    await settle();

    expect(paneFileTabs().find((t) => t.id === "moved-tab"), "the missing tab stays").toEqual({
      id: "moved-tab",
      path: "notes/moved.md",
      missing: true,
    });
    expect(paneFileTabs().some((t) => t.id !== "moved-tab" && t.path === NEXT), "the file opens beside").toBe(true);
  });
});
