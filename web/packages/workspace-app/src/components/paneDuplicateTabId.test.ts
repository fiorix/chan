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

import { mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import "../state/commands/install";
import { ui } from "../state/store.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";
import { fileTab as harnessFileTab } from "../__tests__/tabs";

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
  return harnessFileTab({ id, path, content: path, saved: path, mode: "source" });
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
  try {
    await teardownDemoApp({ mounted, timers });
  } finally {
    timers = null;
    document.body.innerHTML = "";
    ui.authMissing = false;
    ui.disconnectBlocking = false;
    vi.restoreAllMocks();
  }
});

function paneEl(target: HTMLElement, id: string): HTMLElement {
  const el = target.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  expect(el, `pane ${id} is rendered`).not.toBeNull();
  return el!;
}

/// What a pane shows: the tabs in its strip (a file tab's title is its path),
/// how many file bodies it drew, and whether a failure card replaced them.
/// A test's file tab holds its own path as its text, so a body's text says
/// which copy drew it.
function drawn(pane: HTMLElement): { strip: string[]; bodies: number; failed: boolean } {
  return {
    strip: [...pane.querySelectorAll(".tabs .tab")].map((tab) => tab.getAttribute("title") ?? ""),
    bodies: pane.querySelectorAll(".editor-tab").length,
    failed: pane.querySelector(".pane-failed") !== null,
  };
}

/// The warnings the pane gave for a repeated id, one per dropped copy.
function duplicateWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes("lists tab"));
}

describe("a pane whose tab lists repeat an id", () => {
  test("keeps its bodies when the id is on both Hybrid sides", async () => {
    // `allPaneTabs` concatenates both sides, so the body lists see the id
    // twice while each side's strip sees it once.
    const warn = vi.spyOn(console, "warn");
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
    expect(duplicateWarnings(warn)[0]).toBe(
      `[chan] pane ${PANE_A} lists tab dup twice; drawing the first copy`,
    );
  });

  test("keeps its strip and its bodies when the id is twice on one side", async () => {
    const warn = vi.spyOn(console, "warn");
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
    expect(duplicateWarnings(warn)[0]).toBe(
      `[chan] pane ${PANE_A} lists tab dup twice; drawing the first copy`,
    );
  });

  test("draws the first copy when the two differ, and the other stays in the layout", async () => {
    // Nothing is known to produce a repeated id, so the pane masks it rather
    // than repairing the layout: side A's copy draws, and side B's copy,
    // with other content, is neither drawn nor dropped.
    const warn = vi.spyOn(console, "warn");
    const target = await mountApp({
      kind: "leaf",
      id: PANE_A,
      tabs: [fileTab("dup", "README.md"), fileTab("dup-sibling", "notes.md")],
      activeTabId: "dup",
      bTabs: [fileTab("dup", "other.md")],
      bActiveTabId: "dup",
    });

    const bodies = [...paneEl(target, PANE_A).querySelectorAll(".editor-tab")].map(
      (body) => body.textContent ?? "",
    );
    expect({
      drawsFirstCopy: bodies.some((text) => text.includes("README.md")),
      drawsSecondCopy: bodies.some((text) => text.includes("other.md")),
      secondCopyKept: ((layout.nodes[PANE_A] as LeafNode).bTabs?.[0] as FileTab | undefined)?.path,
      warned: duplicateWarnings(warn)[0],
    }).toEqual({
      drawsFirstCopy: true,
      drawsSecondCopy: false,
      secondCopyKept: "other.md",
      warned: `[chan] pane ${PANE_A} lists tab dup twice; drawing the first copy`,
    });
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
