// Every tab body in a pane stays mounted across a tab switch: Pane renders
// each kind from an all-pane keyed each-block and flips an `active` prop
// rather than mounting only the active tab. Unmounting would dispose the
// CM6 EditorView, the graph's force layout and the dashboard's carousel,
// which is what the `active` gate and the visibility rules exist to avoid.
//
// The app is mounted for real and the same DOM nodes are compared across
// the switch, because the claim is that an instance SURVIVES: reading the
// each-block out of the source says which shape is written, not which
// instances live.
//
// Graph tabs are absent here and covered by their own suite's negative pin
// instead: GraphPanel paints a real canvas, jsdom has none, and the second
// instance throws before it can be compared.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

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

// The decorative and graph canvases drive a real 2D/WebGL context, which
// jsdom does not provide, and the retry path spins against a synchronous
// requestAnimationFrame. The claim here is about which tab bodies a pane
// mounts, not about what they paint, so the animation runners are stood
// down and their cleanup contract kept.
vi.mock("./canvasAnimation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canvasAnimation")>()),
  runCanvasAnimation: () => () => {},
  runWebglAnimation: () => () => {},
  runWebgl2Animation: () => () => {},
}));


import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import "../state/commands/install";
import {
  layout,
  reorderTab,
  selectTabInPane,
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

const PANE = "keepalive-pane";
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

async function mountWith(tabs: Tab[]): Promise<HTMLElement> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }) as Record<string, unknown>);
  await tick();
  await tick();
  const pane: LeafNode = {
    kind: "leaf",
    id: PANE,
    tabs,
    activeTabId: tabs[0]!.id,
  };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  layout.nodes = { [PANE]: pane };
  await tick();
  await tick();
  return target;
}

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
  ui.authMissing = false;
  ui.disconnectBlocking = false;
  vi.restoreAllMocks();
});

function paneEl(target: HTMLElement): HTMLElement {
  const el = target.querySelector<HTMLElement>(`[data-pane-id="${PANE}"]`);
  expect(el, "the pane is rendered").not.toBeNull();
  return el!;
}

/// Mount two tabs of one kind, switch to the second, then reorder them.
/// Asserts both bodies were present throughout, that the first is the SAME
/// node after the switch, and that the reorder moved the nodes rather than
/// rewriting them, which is what keying by tab id buys. `selector` is the
/// kind's own component root.
async function survivesSwitch(tabs: Tab[], selector: string): Promise<void> {
  const target = await mountWith(tabs);
  const pane = paneEl(target);

  const before = [...pane.querySelectorAll(selector)];
  expect(before, "both bodies mount, not only the active one").toHaveLength(2);
  const first = before[0]!;

  selectTabInPane(PANE, tabs[1]!.id);
  await tick();
  await tick();

  const after = [...pane.querySelectorAll(selector)];
  expect(after, "both are still mounted after the switch").toHaveLength(2);
  expect(after[0], "and the first is the same instance").toBe(first);

  // The other half the source pins held: the each is keyed by tab id, so a
  // reorder MOVES the existing nodes. An unkeyed each would leave the nodes
  // where they are and update their contents in place, which is a remount of
  // everything the keep-alive exists to preserve.
  const second = after[1]!;
  reorderTab(PANE, tabs[0]!.id, 1);
  await tick();
  await tick();

  const reordered = [...pane.querySelectorAll(selector)];
  expect(reordered, "still both").toHaveLength(2);
  expect(reordered[0], "the tab that moved up brought its node").toBe(second);
  expect(reordered[1], "and the one that moved down brought its own").toBe(first);
}

describe("a pane keeps every tab body mounted across a switch", () => {
  test("file tabs", async () => {
    await survivesSwitch(
      [fileTab("keepalive-file-a"), fileTab("keepalive-file-b")],
      ".editor-tab",
    );
  });

  test("dashboard tabs", async () => {
    await survivesSwitch(
      [
        { kind: "dashboard", id: "keepalive-dash-a", title: "Dashboard" },
        { kind: "dashboard", id: "keepalive-dash-b", title: "Dashboard" },
      ],
      ".dashboard",
    );
  });

});
