// @vitest-environment jsdom
//
// Ctrl+D on an exited terminal must close exactly that tab. The renderer
// mocks are the point of this file: every other TerminalTab mount test stubs
// `attachCustomKeyEventHandler` to a no-op, so the custom key handler never
// runs and the second dispatch through the component root is invisible.
//
// Both mocks mirror their upstream renderer's keydown path exactly:
//
//   xterm.js (CoreBrowserTerminal._keyDown) listens on its helper textarea,
//   calls the custom handler, and on a `false` return only skips its own
//   encoding -- it neither preventDefaults nor stops propagation.
//
//   ghostty-web (handleKeyDown) listens on the container it was opened in,
//   calls the custom handler, and on a truthy return preventDefaults and
//   returns -- it does not stop propagation either.
//
// In both cases the keystroke keeps bubbling to the `.terminal-tab` root,
// whose `onkeydown` runs the same close a second time.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import {
  layout,
  type FileTab,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import {
  fileTab,
  resetLayout as harnessResetLayout,
  terminalTab as harnessTerminalTab,
} from "../__tests__/tabs";

const mounted: Array<Record<string, any>> = [];
const sockets: TestWebSocket[] = [];

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

// `ghostty` flips both the backend the component picks and which renderer
// mock receives the keystroke; the ghostty kit loader is mocked below.
const rendererPrefs = vi.hoisted(() => ({ ghostty: false }));

vi.mock("@xterm/xterm", () => ({
  // Upstream's helper textarea, its capture-phase keydown listener and its
  // custom-handler contract, which is what the stubbed mocks elsewhere drop.
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    textarea: HTMLTextAreaElement | null = null;
    customKeyEventHandler: ((e: KeyboardEvent) => boolean) | null = null;

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
          // A `false` return means "xterm skips its own encoding", nothing
          // more: upstream returns from _keyDown without touching the event.
          this.customKeyEventHandler?.(event);
        },
        true,
      );
    }

    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) {
      this.customKeyEventHandler = handler;
    }

    onData() {}
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

vi.mock("../terminal/backend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../terminal/backend")>();
  // ghostty-web's container-level keydown listener and its inverted
  // custom-handler contract (truthy = handled). No renderer: the component
  // warns and keeps its own metrics, which is the documented fallback.
  class GhosttyTerminal {
    cols = 80;
    rows = 24;
    renderer = null;
    buffer = { active: { length: 0 }, alternate: {} };
    customKeyEventHandler: ((e: KeyboardEvent) => boolean) | null = null;

    open(container: HTMLElement) {
      container.addEventListener("keydown", (event: KeyboardEvent) => {
        if (this.customKeyEventHandler?.(event)) {
          event.preventDefault();
        }
      });
    }

    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) {
      this.customKeyEventHandler = handler;
    }

    attachCustomWheelEventHandler() {}
    hasMouseTracking() {
      return false;
    }
    getViewportY() {
      return 0;
    }
    getScrollbackLength() {
      return 0;
    }
    scrollToLine() {}
    onData() {}
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
  }
  return {
    ...actual,
    terminalBackendFromPrefs: () => (rendererPrefs.ghostty ? "ghostty" : "xterm"),
    loadGhosttyKit: async () => ({
      ghostty: {} as never,
      Terminal: GhosttyTerminal as never,
    }),
  };
});

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

const PANE_ID = "ctrl-d-double-close-pane";

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  document.body.innerHTML = "";
  rendererPrefs.ghostty = false;
});

function terminalTab(): TerminalTabState {
  return harnessTerminalTab({ id: "term-exited" });
}

function neighbourTab(): FileTab {
  return fileTab({ id: "file-neighbour", path: "notes/neighbour.md" });
}

function resetLayout(tabs: Array<FileTab | TerminalTabState>): LeafNode {
  return harnessResetLayout(tabs, { id: PANE_ID });
}

/// Mount the pane's terminal tab and drive it to `status === "exited"`, the
/// only state in which Ctrl+D is the close-this-tab chord.
async function mountExitedTerminal(pane: LeafNode) {
  const tab = pane.tabs.find((t) => t.kind === "terminal") as TerminalTabState;
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: PANE_ID, side: "a", active: true, focused: true },
  });
  mounted.push(component);
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
  await socket.onmessage?.({ data: JSON.stringify({ type: "exit", code: 0 }) });
  await tick();
  return { target };
}

function ctrlD(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "d",
    code: "KeyD",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

/// Let the close pipeline settle: closeTabAsync awaits the confirm helper and
/// the terminal close sink before it splices, so the removal lands a few
/// microtasks after the keystroke.
async function settleCloses(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

describe("Ctrl+D on an exited terminal", () => {
  test("xterm: closes its own tab and leaves the neighbour", async () => {
    const pane = resetLayout([terminalTab(), neighbourTab()]);
    await mountExitedTerminal(pane);

    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(textarea).not.toBeNull();
    textarea!.dispatchEvent(ctrlD());
    await settleCloses();

    expect((layout.nodes[PANE_ID] as LeafNode).tabs.map((t) => t.id)).toEqual([
      "file-neighbour",
    ]);
  });

  // Control: with only one owner in the dispatch path the close runs once
  // today, which is what makes the two failures above a double dispatch
  // rather than a broken mount or a broken close.
  test("the component root alone closes exactly one tab", async () => {
    const pane = resetLayout([terminalTab(), neighbourTab()]);
    await mountExitedTerminal(pane);

    const root = document.body.querySelector<HTMLElement>(".terminal-tab");
    expect(root).not.toBeNull();
    root!.dispatchEvent(ctrlD());
    await settleCloses();

    expect((layout.nodes[PANE_ID] as LeafNode).tabs.map((t) => t.id)).toEqual([
      "file-neighbour",
    ]);
  });

  test("ghostty: closes its own tab and leaves the neighbour", async () => {
    rendererPrefs.ghostty = true;
    const pane = resetLayout([terminalTab(), neighbourTab()]);
    await mountExitedTerminal(pane);

    const host = document.body.querySelector<HTMLElement>(".terminal-host");
    expect(host).not.toBeNull();
    host!.dispatchEvent(ctrlD());
    await settleCloses();

    expect((layout.nodes[PANE_ID] as LeafNode).tabs.map((t) => t.id)).toEqual([
      "file-neighbour",
    ]);
  });
});
