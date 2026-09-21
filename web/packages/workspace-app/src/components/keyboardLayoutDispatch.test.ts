// @vitest-environment jsdom
//
// Shortcuts dispatch by the symbol the active layout types, through the real
// App.svelte document listeners. Each case presses a keydown taken from a
// published layout and checks the command's own effect: Settings opening,
// Hybrid Nav entering, a pane splitting, a tab being selected. The paired
// case presses the key sitting at the old physical position and checks that
// nothing happens, so a matcher that still reads `code` fails here.
//
// A Linux browser client (jsdom's own user agent), so `Mod` is Ctrl and the
// web chord set applies.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import "../state/commands/install";
import { assignOverride, hydrateOverrides } from "../state/keymapOverrides.svelte";
import { settingsPanel } from "../state/store.svelte";
import {
  cancelPaneMode,
  layout,
  paneMode,
  type FileTab,
  type LeafNode,
} from "../state/tabs.svelte";

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
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;
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

const PANE_ID = "layout-dispatch-pane";
const mounted: Array<Record<string, any>> = [];

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "one.md", kind: "document", size: 3, mtime: 100, content: "one" },
      { path: "two.md", kind: "document", size: 3, mtime: 100, content: "two" },
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

/// One pane with two clean document tabs, the second one active, so tab
/// selection in either direction is observable.
function seedLayout(): void {
  const tabs = [fileTab("tab-one", "one.md"), fileTab("tab-two", "two.md")];
  layout.nodes = {
    [PANE_ID]: {
      kind: "leaf",
      id: PANE_ID,
      tabs,
      activeTabId: "tab-two",
    } satisfies LeafNode,
  };
  layout.rootId = PANE_ID;
  layout.activePaneId = PANE_ID;
}

async function mountApp(): Promise<void> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }));
  await tick();
  await tick();
  seedLayout();
  await tick();
}

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
  settingsPanel.open = false;
  if (paneMode.active) cancelPaneMode();
  hydrateOverrides(null);
  vi.restoreAllMocks();
});

function press(init: KeyboardEventInit & { altGraph?: boolean }): KeyboardEvent {
  const { altGraph, ...rest } = init;
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    modifierAltGraph: altGraph ?? false,
    ...rest,
  });
  document.dispatchEvent(event);
  return event;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

function paneCount(): number {
  return Object.values(layout.nodes).filter((node) => node.kind === "leaf").length;
}

/// The root split's direction: `row` is split right, `column` split down.
function splitDirection(): string | null {
  const root = layout.nodes[layout.rootId];
  return root?.kind === "split" ? root.direction : null;
}

function activeTabId(): string | null {
  return (layout.nodes[PANE_ID] as LeafNode | undefined)?.activeTabId ?? null;
}

describe("Dvorak punctuation follows the layout", () => {
  test("Ctrl+, typed on KeyW opens Settings", async () => {
    await mountApp();
    press({ key: ",", code: "KeyW", ctrlKey: true });
    await settle();
    expect(settingsPanel.open).toBe(true);
  });

  test("the W on physical Comma does not open Settings", async () => {
    await mountApp();
    press({ key: "w", code: "Comma", ctrlKey: true });
    await settle();
    expect(settingsPanel.open).toBe(false);
  });

  test("Ctrl+. typed on KeyE enters Hybrid Nav", async () => {
    await mountApp();
    press({ key: ".", code: "KeyE", ctrlKey: true });
    await settle();
    expect(paneMode.active).toBe(true);
  });

  test("the V on physical Period does not enter Hybrid Nav", async () => {
    await mountApp();
    press({ key: "v", code: "Period", ctrlKey: true });
    await settle();
    expect(paneMode.active).toBe(false);
  });

  test("Ctrl+Alt+/ typed on BracketLeft splits the pane", async () => {
    await mountApp();
    press({ key: "/", code: "BracketLeft", ctrlKey: true, altKey: true });
    await settle();
    expect(paneCount()).toBe(2);
    expect(splitDirection()).toBe("row");
  });

  test("the Z on physical Slash does not split the pane", async () => {
    await mountApp();
    press({ key: "z", code: "Slash", ctrlKey: true, altKey: true });
    await settle();
    expect(paneCount()).toBe(1);
  });

  test("Alt+Shift+[ typed as { on Minus selects the previous tab", async () => {
    await mountApp();
    press({ key: "{", code: "Minus", altKey: true, shiftKey: true });
    await settle();
    expect(activeTabId()).toBe("tab-one");
  });
});

describe("Shift that only types the symbol", () => {
  test("AZERTY Ctrl+Shift+. on Comma enters Hybrid Nav", async () => {
    await mountApp();
    press({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true });
    await settle();
    expect(paneMode.active).toBe(true);
  });

  test("US Ctrl+Shift+. types > and does not enter Hybrid Nav", async () => {
    await mountApp();
    press({ key: ">", code: "Period", ctrlKey: true, shiftKey: true });
    await settle();
    expect(paneMode.active).toBe(false);
  });

  test("AZERTY Ctrl+Alt+Shift+/ takes the explicit shifted chord and splits down", async () => {
    await mountApp();
    press({ key: "/", code: "Period", ctrlKey: true, altKey: true, shiftKey: true });
    await settle();
    expect(splitDirection()).toBe("column");
  });

  test("with split down reassigned, AZERTY / falls back to split right", async () => {
    await mountApp();
    assignOverride("app.pane.splitDown", "Ctrl+Alt+J", "web");
    press({ key: "/", code: "Period", ctrlKey: true, altKey: true, shiftKey: true });
    await settle();
    expect(splitDirection()).toBe("row");
  });

  test("an override on the exact chord beats the built-in on the consumed one", async () => {
    await mountApp();
    assignOverride("app.settings.open", "Mod+Shift+.", "web");
    press({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true });
    await settle();
    expect(settingsPanel.open).toBe(true);
    expect(paneMode.active).toBe(false);
  });
});

describe("keystrokes that type text are refused", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
  });

  test("control: Ctrl+Alt+1 selects the first tab", async () => {
    await mountApp();
    press({ key: "1", code: "Digit1", ctrlKey: true, altKey: true });
    await settle();
    expect(activeTabId()).toBe("tab-one");
  });

  test("Hungarian AltGr+1 typing ~ on Windows does not select a tab", async () => {
    await mountApp();
    press({ key: "~", code: "Digit1", ctrlKey: true, altKey: true, altGraph: true });
    await settle();
    expect(activeTabId()).toBe("tab-two");
  });

  test("a composing keystroke does not open Settings", async () => {
    await mountApp();
    press({ key: ",", code: "Comma", ctrlKey: true, isComposing: true });
    await settle();
    expect(settingsPanel.open).toBe(false);
  });
});
