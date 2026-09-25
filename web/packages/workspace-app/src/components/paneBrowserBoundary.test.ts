// @vitest-environment jsdom
//
// The browser tab body is contained by its own boundary like every other
// kind. It is the one body that renders from the active-tab chain rather than
// a keep-alive each, and it is the body that reaches the keyed lists this
// item comes from, so a throw there taking the pane would take every terminal
// socket and editor view in it.

import { mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

/// The body that throws. FileBrowserSurface is the browser tab's whole body.
vi.mock("./FileBrowserSurface.svelte", () => ({
  default: function ThrowingFileBrowserSurface() {
    throw new Error("file browser render blew up");
  },
}));

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import "../state/commands/install";
import {
  layout,
  type BrowserTab,
  type FileTab,
  type LeafNode,
  type Tab,
} from "../state/tabs.svelte";
import { ui } from "../state/store.svelte";

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

const PANE = "browser-boundary-pane";
const mounted: Array<Record<string, unknown>> = [];

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ],
  };
}

function fileTab(id: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id,
    path: "README.md",
    content: "hello",
    saved: "hello",
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

function browserTab(id: string): BrowserTab {
  return { kind: "browser", id, title: "Files", inspectorOpen: false };
}

async function mountApp(): Promise<HTMLElement> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }) as Record<string, unknown>);
  await tick();
  await tick();
  const tabs: Tab[] = [browserTab("browser-throws"), fileTab("browser-sibling")];
  layout.nodes = {
    [PANE]: { kind: "leaf", id: PANE, tabs, activeTabId: "browser-throws" } satisfies LeafNode,
  };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  await tick();
  await tick();
  return target;
}

let timers: TimerTrack | null = null;

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

describe("a browser tab whose render throws", () => {
  test("is contained in its own tab, and its sibling's body survives", async () => {
    const target = await mountApp();
    const pane = target.querySelector<HTMLElement>(`[data-pane-id="${PANE}"]`);
    expect(pane, "the pane is rendered").not.toBeNull();

    // The containment claim first, because it is the one that matters: the
    // sibling file tab is mounted by the keep-alive each whatever is active,
    // and a pane-wide failure takes its editor view with the browser.
    expect(
      pane!.querySelector(".editor-tab"),
      "the sibling keeps its editor view",
    ).not.toBeNull();

    const failed = pane!.querySelector(".pane-failed");
    expect(failed, "the failure is shown where the body was").not.toBeNull();
    expect(failed?.textContent, "it names what failed").toContain(
      "file browser render blew up",
    );
    expect(failed?.textContent, "and the unit that failed").toContain(
      "This tab could not be drawn",
    );
    expect(
      [...pane!.querySelectorAll(".tabs .tab")],
      "and the strip still holds both tabs",
    ).toHaveLength(2);
  });
});
