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

import { mount, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "../App.svelte";
import { api } from "../api/client";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import "../state/commands/install";
import { EXTENSION_KEYDOWN_MESSAGE } from "../state/extensionBridge";
import { refreshExtensions } from "../state/extensions.svelte";
import { assignOverride, hydrateOverrides } from "../state/keymapOverrides.svelte";
import { paneModalGuard } from "../state/paneModalGuard.svelte";
import { settingsPanel } from "../state/store.svelte";
import {
  cancelPaneMode,
  layout,
  paneMode,
  type FileTab,
  type LeafNode,
} from "../state/tabs.svelte";
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
  return harnessFileTab({ id, path, content: path, saved: path, mode: "source" });
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
    settingsPanel.open = false;
    if (paneMode.active) cancelPaneMode();
    hydrateOverrides(null);
    paneModalGuard.openCount = 0;
    vi.restoreAllMocks();
  }
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

describe("a chord relayed from a focused extension frame", () => {
  /// Mount the app with an echo extension in the catalog and its tab active
  /// in the pane, and return the tab's frame.
  async function mountWithExtension(): Promise<HTMLIFrameElement> {
    vi.spyOn(api, "extensions").mockResolvedValue([
      { id: "echo", name: "Echo", entry_path: `/_chan/extensions/echo/${"a".repeat(64)}/` },
    ]);
    await mountApp();
    await refreshExtensions();
    const pane = layout.nodes[PANE_ID] as LeafNode;
    pane.tabs.push({ kind: "extension", id: "echo-tab", title: "Echo", extensionId: "echo" });
    pane.activeTabId = "echo-tab";
    await settle();
    const frame = document.querySelector<HTMLIFrameElement>(".extension-tab iframe");
    // Without a frame every relay below would be dropped for its source,
    // and the negative cases would pass for the wrong reason.
    expect(frame?.contentWindow).toBeTruthy();
    return frame!;
  }

  /// Post one relay message as the given window and return how many keydowns
  /// Chan recreated on its document in response.
  function relay(source: MessageEventSource | null, fields: Record<string, unknown>): number {
    let recreated = 0;
    const count = () => (recreated += 1);
    document.addEventListener("keydown", count, true);
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: {
          type: EXTENSION_KEYDOWN_MESSAGE,
          key: "",
          code: "",
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          repeat: false,
          isComposing: false,
          altGraph: false,
          ...fields,
        },
      }),
    );
    document.removeEventListener("keydown", count, true);
    return recreated;
  }

  function terminalCount(): number {
    return Object.values(layout.nodes)
      .filter((node): node is LeafNode => node.kind === "leaf")
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.kind === "terminal").length;
  }

  const COLEMAK_T = { key: "T", code: "KeyF", ctrlKey: true, shiftKey: true };

  test("Colemak Ctrl+Shift+T opens exactly one terminal", async () => {
    const frame = await mountWithExtension();
    expect(relay(frame.contentWindow, COLEMAK_T)).toBe(1);
    await settle();
    expect(terminalCount()).toBe(1);
  });

  test("the G on KeyT is not advertised, so nothing is recreated", async () => {
    const frame = await mountWithExtension();
    expect(relay(frame.contentWindow, { ...COLEMAK_T, key: "G", code: "KeyT" })).toBe(0);
    await settle();
    expect(terminalCount()).toBe(0);
  });

  test("a relay from any other window is ignored", async () => {
    await mountWithExtension();
    expect(relay(window, COLEMAK_T)).toBe(0);
    await settle();
    expect(terminalCount()).toBe(0);
  });

  test("a v1 relay is ignored", async () => {
    const frame = await mountWithExtension();
    expect(relay(frame.contentWindow, { ...COLEMAK_T, type: "chan:extension-keydown:v1" })).toBe(0);
    await settle();
    expect(terminalCount()).toBe(0);
  });
});

describe("Settings, pane flip and pane navigation keep their guards", () => {
  function pane(id = PANE_ID): LeafNode {
    return layout.nodes[id] as LeafNode;
  }

  /// Three leaves side by side, the middle one active, so the previous and
  /// the next pane are different panes.
  function seedThreePanes(): void {
    const leaf = (id: string): LeafNode => ({
      kind: "leaf",
      id,
      tabs: [fileTab(`tab-${id}`, "two.md")],
      activeTabId: `tab-${id}`,
    });
    layout.nodes = {
      root: { id: "root", kind: "split", direction: "row", a: PANE_ID, b: "rest", ratio: 0.33 },
      rest: { id: "rest", kind: "split", direction: "row", a: "middle", b: "right", ratio: 0.5 },
      [PANE_ID]: pane(),
      middle: leaf("middle"),
      right: leaf("right"),
    };
    layout.rootId = "root";
    layout.activePaneId = "middle";
  }

  test("Ctrl+, opens Settings on Linux and leaves the pane unflipped", async () => {
    await mountApp();
    const side = pane().side;
    const event = press({ key: ",", code: "Comma", ctrlKey: true });
    await settle();
    expect(settingsPanel.open).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(pane().side).toBe(side);
  });

  test.each<[string, KeyboardEventInit]>([
    ["Ctrl+Alt+,", { key: ",", code: "Comma", ctrlKey: true, altKey: true }],
    ["Ctrl+Shift+, (typing <)", { key: "<", code: "Comma", ctrlKey: true, shiftKey: true }],
    ["Meta+,", { key: ",", code: "Comma", metaKey: true }],
  ])("%s does not open Settings on Linux", async (_name, init) => {
    await mountApp();
    press(init);
    await settle();
    expect(settingsPanel.open).toBe(false);
  });

  test("on macOS Cmd+, opens Settings and Ctrl+, does not", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    );
    await mountApp();
    press({ key: ",", code: "Comma", ctrlKey: true });
    await settle();
    expect(settingsPanel.open).toBe(false);
    press({ key: ",", code: "Comma", metaKey: true });
    await settle();
    expect(settingsPanel.open).toBe(true);
  });

  test("a reassigned Settings chord takes Ctrl+, off Settings", async () => {
    await mountApp();
    // Both presses land while the assignment is in memory. Settings opens
    // synchronously in the handler; awaiting would let the config write
    // re-hydrate the override table (applyServerPreferences), and in this
    // harness the re-hydrated table no longer holds the assignment.
    assignOverride("app.settings.open", "Ctrl+Alt+J", "web");
    press({ key: ",", code: "Comma", ctrlKey: true });
    expect(settingsPanel.open).toBe(false);
    press({ key: "j", code: "KeyJ", ctrlKey: true, altKey: true });
    expect(settingsPanel.open).toBe(true);
  });

  test("Ctrl+` flips the active pane", async () => {
    await mountApp();
    const side = pane().side;
    const event = press({ key: "`", code: "Backquote", ctrlKey: true });
    await settle();
    expect(pane().side).not.toBe(side);
    expect(event.defaultPrevented).toBe(true);
  });

  test.each<[string, KeyboardEventInit]>([
    ["Ctrl+Alt+`", { key: "`", code: "Backquote", ctrlKey: true, altKey: true }],
    ["Ctrl+Shift+` (typing ~)", { key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Meta+`", { key: "`", code: "Backquote", ctrlKey: true, metaKey: true }],
  ])("%s does not flip the pane", async (_name, init) => {
    await mountApp();
    const side = pane().side;
    press(init);
    await settle();
    expect(pane().side).toBe(side);
  });

  test("a reassigned flip chord takes Ctrl+` off the flip", async () => {
    await mountApp();
    assignOverride("app.pane.flip", "Ctrl+Alt+J", "web");
    const side = pane().side;
    press({ key: "`", code: "Backquote", ctrlKey: true });
    await settle();
    expect(pane().side).toBe(side);
  });

  test("with a modal over the pane, Ctrl+` is swallowed and flips nothing", async () => {
    await mountApp();
    paneModalGuard.openCount = 1;
    const side = pane().side;
    const event = press({ key: "`", code: "Backquote", ctrlKey: true });
    await settle();
    expect(pane().side).toBe(side);
    expect(event.defaultPrevented).toBe(true);
  });

  test("Alt+[ and Alt+] select the previous and next pane", async () => {
    await mountApp();
    seedThreePanes();
    await settle();
    press({ key: "[", code: "BracketLeft", altKey: true });
    await settle();
    expect(layout.activePaneId).toBe(PANE_ID);
    layout.activePaneId = "middle";
    press({ key: "]", code: "BracketRight", altKey: true });
    await settle();
    expect(layout.activePaneId).toBe("right");
  });

  test("Dvorak Alt+[ on Minus selects the previous pane", async () => {
    await mountApp();
    seedThreePanes();
    await settle();
    press({ key: "[", code: "Minus", altKey: true });
    await settle();
    expect(layout.activePaneId).toBe(PANE_ID);
  });

  test.each<[string, KeyboardEventInit]>([
    [
      "Alt+Shift+[ (tab navigation)",
      { key: "{", code: "BracketLeft", altKey: true, shiftKey: true },
    ],
    ["Ctrl+Alt+[", { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }],
    ["Meta+Alt+[", { key: "[", code: "BracketLeft", metaKey: true, altKey: true }],
  ])("%s leaves the active pane alone", async (_name, init) => {
    await mountApp();
    seedThreePanes();
    await settle();
    press(init);
    await settle();
    expect(layout.activePaneId).toBe("middle");
  });
});
