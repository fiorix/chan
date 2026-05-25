// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";

const mounted: Array<Record<string, any>> = [];
const sockets: TestWebSocket[] = [];
const terminalFocuses: string[] = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestWebSocket {
  static OPEN = 1;

  readyState = TestWebSocket.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
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

    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    focus() {
      terminalFocuses.push("focus");
    }
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

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  terminalFocuses.splice(0);
  document.body.innerHTML = "";
  closeTabMenu();
});

function terminalTab(partial: Partial<TerminalTabState> = {}): TerminalTabState {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

async function renderTerminal(tab: TerminalTabState, focused: boolean) {
  const target = document.createElement("div");
  document.body.append(target);
  const { default: TerminalTab } = await import("./TerminalTab.svelte");
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", active: true, focused },
  });
  mounted.push(component);
  await tick();
  await tick();
  return { component, target };
}

function openSocket(): TestWebSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error("expected terminal websocket");
  socket.onopen?.();
  return socket;
}

describe("TerminalTab activity frames", () => {
  test(
    "marks an active tab in an unfocused pane when activity arrives",
    async () => {
      const tab = terminalTab();
      await renderTerminal(tab, false);

      const socket = openSocket();
      socket.onmessage?.({
        data: JSON.stringify({
          type: "session",
          id: "term-session",
          seq: 0,
          missed_bytes: 0,
          bytes_since_focus: 0,
        }),
      });
      socket.onmessage?.({
        data: JSON.stringify({ type: "activity", bytes_since_focus: 12 }),
      });

      expect(tab.terminalActivity).toBe(true);
      expect(socket.sent).toContain(JSON.stringify({ type: "focus", focused: false }));
      expect(terminalFocuses).toHaveLength(0);
    },
  );

  test(
    "clears activity and sends focus true when the pane is focused",
    async () => {
      const tab = terminalTab({ terminalActivity: true });
      await renderTerminal(tab, true);

      const socket = openSocket();

      expect(tab.terminalActivity).toBeUndefined();
      expect(socket.sent).toContain(JSON.stringify({ type: "focus", focused: true }));
      expect(terminalFocuses.length).toBeGreaterThan(0);
    },
  );
});

describe("TerminalTab menu", () => {
  test(
    "kebab menu renders the From-$CWD spawn band including New Terminal",
    async () => {
      // `fullstack-a-67d`: addendum-a's Terminal spec re-introduces
      // a "From $CWD" section containing New File / New Terminal /
      // New File Browser / New Graph. Earlier `-a-32` had pruned
      // "New Terminal" from this menu when the empty-pane carousel
      // owned the spawn surface; the addendum brings it back as a
      // CWD-rooted affordance.
      const tab = terminalTab({ terminalSessionId: "term-session-1" });
      const { target } = await renderTerminal(tab, true);

      openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
      await tick();
      await tick();

      const labels = Array.from(document.body.querySelectorAll(".mbtn-label")).map(
        (el) => (el.textContent || "").trim(),
      );
      // Sanity check: the menu actually rendered.
      expect(labels.length).toBeGreaterThan(0);
      // From-$CWD band — full set.
      expect(labels).toContain("New File");
      expect(labels).toContain("New Terminal");
      expect(labels).toContain("New File Browser");
      expect(labels).toContain("New Graph");
      // Restart is the canonical destructive neighbour; addendum
      // moves it up next to MCP env.
      expect(labels).toContain("Restart");
    },
  );
});
