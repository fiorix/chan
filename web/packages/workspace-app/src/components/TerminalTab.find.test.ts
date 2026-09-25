// @vitest-environment jsdom

// Terminal find (issue #6). Two contracts pinned here:
//
// 1. The xterm Terminal is constructed with `allowProposedApi: true`.
//    xterm gates registerDecoration behind that flag, and the search
//    addon's decorated find throws without it -- the find bar "matches
//    nothing" because runFind dies mid-keystroke.
// 2. The find command family (app.find.open / next / prev) reaches the
//    focused terminal over the chan:command bus. On desktop the key
//    bridge claims Mod+F / Mod+G before the webview sees the keydown
//    and fires these commands; App.svelte serves them for file tabs
//    only, so the terminal must serve itself or the chord is dead on
//    a terminal pane.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";

const mounted: Array<Record<string, any>> = [];
const terminalOptions: Array<Record<string, unknown>> = [];
const findNextCalls: Array<{ query: string; opts: unknown }> = [];
const findPreviousCalls: Array<{ query: string; opts: unknown }> = [];

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

    constructor(options: Record<string, unknown> = {}) {
      terminalOptions.push(options);
    }

    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext(query: string, opts: unknown) {
      findNextCalls.push({ query, opts });
    }
    findPrevious(query: string, opts: unknown) {
      findPreviousCalls.push({ query, opts });
    }
    clearDecorations() {}
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

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  terminalOptions.splice(0);
  findNextCalls.splice(0);
  findPreviousCalls.splice(0);
  document.body.innerHTML = "";
});

async function renderTerminal(tab: TerminalTabState, focused: boolean) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", active: true, focused },
  });
  mounted.push(component);
  await tick();
  await tick();
  return { component, target };
}

function fireCommand(name: string): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } }));
}

function findInput(): HTMLInputElement | null {
  return document.querySelector(".terminal-find input.find");
}

async function openFindWithQuery(query: string): Promise<HTMLInputElement> {
  fireCommand("app.find.open");
  await tick();
  await tick();
  const input = findInput();
  expect(input).not.toBeNull();
  input!.value = query;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  return input!;
}

describe("terminal find construction", () => {
  test("constructs xterm with allowProposedApi so decorated search works", async () => {
    await renderTerminal(terminalTab(), true);

    expect(terminalOptions.length).toBeGreaterThan(0);
    expect(terminalOptions.at(-1)?.allowProposedApi).toBe(true);
  });
});

describe("terminal find command routing", () => {
  test("app.find.open opens the find bar on the focused terminal", async () => {
    await renderTerminal(terminalTab(), true);
    expect(findInput()).toBeNull();

    fireCommand("app.find.open");
    await tick();
    await tick();

    expect(findInput()).not.toBeNull();
  });

  test("an unfocused terminal ignores app.find.open", async () => {
    await renderTerminal(terminalTab(), false);

    fireCommand("app.find.open");
    await tick();
    await tick();

    expect(findInput()).toBeNull();
  });

  test("typing and Enter run a decorated findNext; Shift+Enter reverses", async () => {
    await renderTerminal(terminalTab(), true);
    const input = await openFindWithQuery("needle");

    // The live-typing search already fired; Enter fires the next hop.
    const before = findNextCalls.length;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(findNextCalls.length).toBe(before + 1);
    const last = findNextCalls.at(-1)!;
    expect(last.query).toBe("needle");
    expect((last.opts as { decorations?: unknown })?.decorations).toBeTruthy();

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(findPreviousCalls.at(-1)?.query).toBe("needle");
  });

  test("app.find.next / app.find.prev step an open find bar", async () => {
    await renderTerminal(terminalTab(), true);
    await openFindWithQuery("needle");

    const before = findNextCalls.length;
    fireCommand("app.find.next");
    expect(findNextCalls.length).toBe(before + 1);

    fireCommand("app.find.prev");
    expect(findPreviousCalls.at(-1)?.query).toBe("needle");
  });

  test("app.find.next without an open find bar is inert", async () => {
    await renderTerminal(terminalTab(), true);

    fireCommand("app.find.next");

    expect(findNextCalls).toHaveLength(0);
  });
});
