// @vitest-environment jsdom
//
// The renderer keyboard contract: each chord the terminal claims produces
// exactly one action, from whichever owner sees it first, whether the renderer
// has focus or not.
//
// The renderer mock mirrors xterm.js: it listens on its helper textarea, calls
// the custom key handler, and on a `false` return skips only its own encoding,
// without preventing the default or stopping propagation. When the handler
// does not claim the key, the mock encodes the ONE chord this file asserts on,
// Ctrl+D, as the EOF byte and hands it to the data callback the way xterm
// would. It is not a general xterm encoder and does not pretend to be.
//
// The Ctrl+D-on-an-exited-terminal half of the single-dispatch rule has its
// own file; this one covers the chords around it.
//
// Terminal find is deliberately absent: which surface owns Mod+F in a focused
// terminal is an open owner ruling, and an assertion either way would decide
// it here.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import { currentOS } from "../state/shortcuts";
import {
  layout,
  type FileTab,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";

const mounted: Array<Record<string, any>> = [];
const sockets: TestWebSocket[] = [];
const SELECTION = "selected terminal text";

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestWebSocket {
  static OPEN = 1;

  readyState = TestWebSocket.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    textarea: HTMLTextAreaElement | null = null;
    customKeyEventHandler: ((e: KeyboardEvent) => boolean) | null = null;
    dataHandler: ((data: string) => void) | null = null;

    loadAddon(addon: {
      testFitAddon?: boolean;
      activate?: (terminal: unknown) => void;
    }) {
      if (addon.testFitAddon) addon.activate?.(this);
    }

    open(host: HTMLElement) {
      const element = document.createElement("div");
      element.className = "xterm";
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      element.append(textarea);
      host.append(element);
      this.textarea = textarea;
      textarea.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (this.customKeyEventHandler?.(event) === false) return;
          // Upstream would run its own encoder here. The control-byte family
          // is modelled, which is what this file asserts on: Ctrl and a letter
          // is that letter's control code whether or not Shift is down, the
          // way xterm encodes it, and Ctrl+[ is Escape. Shift matters here:
          // it is what makes a chord the renderer should NOT have visible as
          // a byte the shell received.
          if (event.ctrlKey && !event.metaKey && !event.altKey) {
            if (/^Key[A-Z]$/.test(event.code)) {
              this.dataHandler?.(String.fromCharCode(event.code.charCodeAt(3) - 64));
            } else if (event.code === "BracketLeft") {
              this.dataHandler?.("\x1b");
            }
          }
        },
        true,
      );
    }

    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) {
      this.customKeyEventHandler = handler;
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
    }

    getSelection() {
      return SELECTION;
    }

    onResize() {}
    write() {}
    writeln() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    focus() {}
    blur() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    testFitAddon = true;
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {}
    findPrevious() {}
  },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.WebSocket = TestWebSocket as any;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    load: vi.fn(async () => [{}]),
    ready: Promise.resolve(),
  },
});

const writeText = vi.fn(async () => {});
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

const PANE_ID = "chord-contract-pane";

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  document.body.innerHTML = "";
  writeText.mockClear();
});

function terminalTab(): TerminalTabState {
  return {
    kind: "terminal",
    id: "term-chords",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
  };
}

function neighbourTab(): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "file-neighbour",
    path: "notes/neighbour.md",
    content: "saved",
    saved: "saved",
    savedMtime: 1,
    mode: "wysiwyg",
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

function resetLayout(): LeafNode {
  const tabs = [terminalTab(), neighbourTab()];
  const node: LeafNode = {
    kind: "leaf",
    id: PANE_ID,
    tabs,
    activeTabId: tabs[0]!.id,
  };
  layout.nodes = { [PANE_ID]: node };
  layout.rootId = PANE_ID;
  layout.activePaneId = PANE_ID;
  return layout.nodes[PANE_ID] as LeafNode;
}

function paneTabIds(): string[] {
  return (layout.nodes[PANE_ID] as LeafNode).tabs.map((t) => t.id);
}

/// Mount the pane's terminal. `exited` drives it to the state in which Ctrl+D
/// is the close-this-tab chord rather than EOF.
async function mountTerminal(exited: boolean) {
  const pane = resetLayout();
  const tab = pane.tabs.find((t) => t.kind === "terminal") as TerminalTabState;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TerminalTab, {
      target,
      props: { tab, paneId: PANE_ID, side: "a", active: true, focused: true },
    }),
  );
  await tick();
  await tick();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]!;
  socket.onopen?.();
  await tick();
  await socket.onmessage?.({
    data: JSON.stringify({
      type: "session",
      id: "term-session",
      seq: 0,
      missed_bytes: 0,
      bytes_since_focus: 0,
    }),
  });
  if (exited) {
    await socket.onmessage?.({
      data: JSON.stringify({ type: "exit", code: 0 }),
    });
  }
  await tick();
  return socket;
}

function textarea(): HTMLTextAreaElement {
  const el = document.body.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  expect(el).not.toBeNull();
  return el!;
}

function root(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(".terminal-tab");
  expect(el).not.toBeNull();
  return el!;
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

function inputFrames(socket: TestWebSocket): string[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; data?: string })
    .filter((f) => f.type === "input")
    .map((f) => f.data ?? "");
}

describe("the chord the terminal claims for copy", () => {
  test("the fixture runs on the OS whose copy chord is Ctrl+Shift+C", () => {
    // Off macOS the copy chord is Ctrl+Shift+C, because bare Ctrl+C is the
    // shell's SIGINT. A jsdom user agent reads as linux; if that ever
    // changes, the chord below is the wrong one and this says so.
    expect(currentOS()).toBe("linux");
  });

  test("copies once from the renderer's textarea", async () => {
    await mountTerminal(false);

    textarea().dispatchEvent(
      key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
    );
    await settle();

    expect(writeText.mock.calls).toEqual([[SELECTION]]);
  });

  test("copies once from the component root", async () => {
    await mountTerminal(false);

    root().dispatchEvent(
      key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
    );
    await settle();

    expect(writeText.mock.calls).toEqual([[SELECTION]]);
  });
});

describe("the chord that opens terminal find", () => {
  test("opens find from the renderer's own textarea", async () => {
    // The find bar is the terminal's, and its chord is claimed by the
    // component root. A renderer that consumed the key would leave the root
    // waiting for a keystroke that never bubbles.

    const socket = await mountTerminal(false);
    textarea().dispatchEvent(
      key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }),
    );
    await settle();

    expect(document.body.querySelector(".terminal-find")).not.toBeNull();
    // And the renderer let it out rather than encoding it: a chord that opens
    // find and also types a byte at the shell is the double dispatch this
    // item is about.
    expect(inputFrames(socket)).toEqual([]);
  });

  test("a bare Ctrl+F is the shell's, not find's", async () => {
    const socket = await mountTerminal(false);

    textarea().dispatchEvent(key({ key: "f", code: "KeyF", ctrlKey: true }));
    await settle();

    expect(inputFrames(socket)).toContain("\x06");
    expect(document.body.querySelector(".terminal-find")).toBeNull();
  });

  test("Ctrl+G reaches the shell too", async () => {
    // The second of the three keys the ruling keeps for the shell. Off macOS
    // nothing in the app competes for it; the macOS key bridge is where they
    // were being taken, and that arm is native.
    //
    // Ctrl+[ is the third and is NOT asserted here: it reaches neither the
    // shell nor any handler this fixture can see, and the escape registry is
    // not what takes it (`shouldEscapeTerminal` answers false for it, and
    // `terminalMetaKeyBytes` returns null so the key passes through). Where it
    // goes is unresolved and written up rather than guessed at.
    const socket = await mountTerminal(false);

    textarea().dispatchEvent(key({ key: "g", code: "KeyG", ctrlKey: true }));
    await settle();

    expect(inputFrames(socket)).toContain("\x07");
  });
});

describe("Ctrl+Shift+D", () => {
  test("does not close an exited terminal", async () => {
    await mountTerminal(true);

    textarea().dispatchEvent(
      key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }),
    );
    await settle();

    expect(paneTabIds()).toEqual(["term-chords", "file-neighbour"]);
  });
});

describe("Ctrl+D on a live shell", () => {
  // A guard, green today and required to stay green: the close-tab chord is
  // the alternate on every platform, and the registry entry says in as many
  // words that it must still reach a focused shell as EOF.
  test("reaches the shell as EOF and closes no tab", async () => {
    const socket = await mountTerminal(false);

    textarea().dispatchEvent(key({ key: "d", code: "KeyD", ctrlKey: true }));
    await settle();

    expect(inputFrames(socket)).toContain("\x04");
    expect(paneTabIds()).toEqual(["term-chords", "file-neighbour"]);
  });
});
