// @vitest-environment jsdom
//
// A pane whose tab lists carry one id twice keeps drawing. The strip and every
// keep-alive body list are keyed by tab id, and a keyed each raises
// `each_key_duplicate` from its own evaluation, which no per-tab boundary
// encloses: in the strip it reaches the window, and in the body lists it
// fails the whole pane body until the user chooses Try again.
//
// The app is mounted for real because the claim is about what survives: the
// strip, the pane's other tab bodies and the other pane.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import {
  demoTransportSettled,
  installDemoWorkspace,
  uninstallDemoWorkspace,
} from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import "../state/commands/install";
import { stopIndexStatusPoller, ui } from "../state/store.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});
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

const PANE_A = "duplicate-pane-a";
const PANE_B = "duplicate-pane-b";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack | null = null;

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 3,
      textCount: 3,
    },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes.md", kind: "document", size: 5, mtime: 100, content: "notes" },
      { path: "other.md", kind: "document", size: 5, mtime: 100, content: "other" },
    ],
  };
}

function fileTab(id: string, path: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id,
    path,
    content: path,
    saved: path,
    savedMtime: 1,
    mode: "source",
    loading: false,
    error: null,
    fileMissing: null,
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

/// Two panes side by side: the left one carries the duplicate, the right one
/// is healthy, so "the rest of the window" is something to assert on.
function seedLayout(left: LeafNode): void {
  const right: LeafNode = {
    kind: "leaf",
    id: PANE_B,
    tabs: [fileTab("dup-right", "other.md")],
    activeTabId: "dup-right",
  };
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", a: PANE_A, b: PANE_B, ratio: 0.5 },
    [PANE_A]: left,
    [PANE_B]: right,
  };
  layout.rootId = "root";
  layout.activePaneId = PANE_A;
}

async function mountApp(left: LeafNode): Promise<HTMLElement> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }) as Record<string, unknown>);
  await tick();
  await tick();
  seedLayout(left);
  await tick();
  await tick();
  return target;
}

beforeEach(() => {
  timers = trackTimers();
});

afterEach(async () => {
  await demoTransportSettled();
  for (const c of mounted.splice(0)) unmount(c);
  stopIndexStatusPoller();
  timers?.release();
  timers = null;
  uninstallDemoWorkspace();
  // The settle above yields to the event loop with the app still mounted, so
  // a debounce that came due there can have written this test's layout into
  // the URL hash or the reload snapshot. The next mount's bootstrap restores
  // from either, after that test has seeded its own layout.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  sessionStorage.clear();
  document.body.innerHTML = "";
  ui.authMissing = false;
  ui.disconnectBlocking = false;
  vi.restoreAllMocks();
});

function paneEl(target: HTMLElement, id: string): HTMLElement {
  const el = target.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  expect(el, `pane ${id} is rendered`).not.toBeNull();
  return el!;
}

/// What a pane shows: the tabs in its strip (a file tab's title is its path),
/// how many file bodies it drew, and whether a failure card replaced them.
function drawn(pane: HTMLElement): { strip: string[]; bodies: number; failed: boolean } {
  return {
    strip: [...pane.querySelectorAll(".tabs .tab")].map((tab) => tab.getAttribute("title") ?? ""),
    bodies: pane.querySelectorAll(".editor-tab").length,
    failed: pane.querySelector(".pane-failed") !== null,
  };
}

describe("a pane whose tab lists repeat an id", () => {
  test("keeps its bodies when the id is on both Hybrid sides", async () => {
    // `allPaneTabs` concatenates both sides, so the body lists see the id
    // twice while each side's strip sees it once.
    const target = await mountApp({
      kind: "leaf",
      id: PANE_A,
      tabs: [fileTab("dup", "README.md"), fileTab("dup-sibling", "notes.md")],
      activeTabId: "dup-sibling",
      bTabs: [fileTab("dup", "README.md")],
      bActiveTabId: "dup",
    });

    expect(drawn(paneEl(target, PANE_A))).toEqual({
      strip: ["README.md", "notes.md"],
      bodies: 2,
      failed: false,
    });
    expect(drawn(paneEl(target, PANE_B))).toEqual({ strip: ["other.md"], bodies: 1, failed: false });
  });

  test("keeps its strip and its bodies when the id is twice on one side", async () => {
    const target = await mountApp({
      kind: "leaf",
      id: PANE_A,
      tabs: [
        fileTab("dup", "README.md"),
        fileTab("dup", "README.md"),
        fileTab("dup-sibling", "notes.md"),
      ],
      activeTabId: "dup-sibling",
    });

    expect(drawn(paneEl(target, PANE_A))).toEqual({
      strip: ["README.md", "notes.md"],
      bodies: 2,
      failed: false,
    });
    expect(drawn(paneEl(target, PANE_B))).toEqual({ strip: ["other.md"], bodies: 1, failed: false });
  });

  test("keeps its strip following the layout after a one-side duplicate", async () => {
    // The strip's each raised the duplicate outside every boundary, so what
    // it drew before the throw is no proof it still renders: a tab opened
    // afterwards has to reach it.
    const target = await mountApp({
      kind: "leaf",
      id: PANE_A,
      tabs: [fileTab("dup", "README.md"), fileTab("dup", "README.md")],
      activeTabId: "dup",
    });

    (layout.nodes[PANE_A] as LeafNode).tabs.push(fileTab("dup-late", "notes.md"));
    await tick();
    await tick();

    expect(drawn(paneEl(target, PANE_A)).strip).toEqual(["README.md", "notes.md"]);
  });
});
