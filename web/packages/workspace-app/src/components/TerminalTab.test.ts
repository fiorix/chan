// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

// Static top-level import avoids per-test dynamic import timeouts under
// the full parallel suite (contended Svelte transform/import across
// workers). The vi.mock calls are hoisted above all imports, so this
// static import still sees the mocked xterm modules.
import TerminalTab from "./TerminalTab.svelte";
import TerminalTabTestHarness from "./TerminalTabTestHarness.svelte";
import terminalSource from "./TerminalTab.svelte?raw";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";

const fitMock = vi.hoisted(() => ({
  calls: 0,
  failure: null as Error | null,
  size: null as { cols: number; rows: number } | null,
}));
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

    loadAddon(addon: {
      testFitAddon?: boolean;
      activate?: (terminal: unknown) => void;
    }) {
      if (addon.testFitAddon) addon.activate?.(this);
    }
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
    testFitAddon = true;
    terminal: { cols: number; rows: number } | null = null;

    activate(terminal: { cols: number; rows: number }) {
      this.terminal = terminal;
    }

    fit() {
      fitMock.calls += 1;
      if (fitMock.failure) throw fitMock.failure;
      if (fitMock.size && this.terminal) {
        this.terminal.cols = fitMock.size.cols;
        this.terminal.rows = fitMock.size.rows;
      }
    }
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
const immediateAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as any;
globalThis.requestAnimationFrame = immediateAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  terminalFocuses.splice(0);
  document.body.innerHTML = "";
  closeTabMenu();
  fitMock.calls = 0;
  fitMock.failure = null;
  fitMock.size = null;
  globalThis.requestAnimationFrame = immediateAnimationFrame;
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

async function renderTerminal(
  tab: TerminalTabState,
  focused: boolean,
  side: "a" | "b" = "a",
) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", side, active: true, focused },
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

describe("TerminalTab initial fit", () => {
  test("dials with the measured grid before deferred resize callbacks", async () => {
    fitMock.size = { cols: 132, rows: 41 };
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(fitMock.calls).toBe(1);
    expect(sockets).toHaveLength(1);
    const query = new URL(sockets[0].url, "http://chan.test").searchParams;
    expect(query.get("cols")).toBe("132");
    expect(query.get("rows")).toBe("41");
  });

  test("still dials when the initial fit cannot measure the host", async () => {
    fitMock.failure = new Error("host is not measurable");
    globalThis.requestAnimationFrame = vi.fn(() => 1) as any;

    await renderTerminal(terminalTab(), true);

    expect(fitMock.calls).toBe(1);
    expect(sockets).toHaveLength(1);
    const query = new URL(sockets[0].url, "http://chan.test").searchParams;
    expect(query.get("cols")).toBe("80");
    expect(query.get("rows")).toBe("24");
  });
});

describe("TerminalTab activity frames", () => {
  test("attaches with side and reports placement on the live socket", async () => {
    const tab = terminalTab();
    await renderTerminal(tab, true, "b");

    const socket = openSocket();
    await tick();

    expect(socket.url).toContain("pane_id=pane-1&side=b&tab_id=term-1");
    expect(socket.sent).toContain(
      JSON.stringify({
        type: "placement",
        pane_id: "pane-1",
        side: "b",
        tab_id: "term-1",
      }),
    );
  });

  test("moves pane and side over the existing PTY socket", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TerminalTabTestHarness, {
      target,
      props: { tab: terminalTab() },
    });
    mounted.push(component);
    await tick();
    await tick();
    const socket = openSocket();
    await tick();
    const connectionCount = sockets.length;

    component.move("pane-2", "b");
    await tick();
    await tick();

    expect(sockets).toHaveLength(connectionCount);
    expect(socket.sent).toContain(
      JSON.stringify({
        type: "placement",
        pane_id: "pane-2",
        side: "b",
        tab_id: "term-1",
      }),
    );
  });

  test(
    "marks an active tab in an unfocused pane when activity arrives",
    async () => {
      const tab = terminalTab();
      await renderTerminal(tab, false);

      const socket = openSocket();
      await socket.onmessage?.({
        data: JSON.stringify({
          type: "session",
          id: "term-session",
          seq: 0,
          missed_bytes: 0,
          bytes_since_focus: 0,
        }),
      });
      await socket.onmessage?.({
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
    "kebab menu keeps broadcast controls and Close only at the foot",
    async () => {
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
      expect(labels).toContain("Close");
      for (const label of [
        "New File",
        "New Terminal",
        "New File Browser",
        "New Graph",
        "Restart",
        "Start New Session",
        "Copy path to $CWD",
        "Settings",
        "Reopen Closed Tab",
      ]) {
        expect(labels).not.toContain(label);
      }
    },
  );

  test("the terminal menu has NO Team Work toggle (the bubble is gone)", async () => {
    const tab = terminalTab({ terminalSessionId: "term-session-1" });
    await renderTerminal(tab, true);

    openTabMenu(tab.id, { left: 0, top: 0, right: 0, bottom: 0 });
    await tick();
    await tick();

    const labels = Array.from(document.body.querySelectorAll(".mbtn-label")).map(
      (el) => (el.textContent || "").trim(),
    );
    // The Team Work bubble composer was removed entirely; Team Work is the
    // Cmd+P dialog now, so no terminal carries a Show/Hide Team Work toggle.
    expect(labels).not.toContain("Show Team Work");
    expect(labels).not.toContain("Hide Team Work");
  });
});

describe("TerminalTab Team Work revamp (source contract)", () => {
  // The Team Work prompt and bubble overlay were rewritten. These pin
  // the load-bearing structural changes at the source level (the prompt
  // component is not mounted in the runtime tests above).

  test("App chords use the central terminal-escape registry", () => {
    // Code-based families such as Alt+Shift+[/] live in shortcuts.ts beside
    // every other App chord; TerminalTab owns no parallel shortcut list.
    expect(terminalSource).toMatch(
      /if \(shouldEscapeTerminal\(e\)\) return false;/,
    );
    expect(terminalSource).not.toMatch(
      /e\.code === "BracketLeft" \|\| e\.code === "BracketRight"/,
    );
  });

  test("the Team Work bubble composer is fully removed", () => {
    // The Team Work bubble is deleted entirely. No <TeamWork> mount, no
    // submitTeamWork/teamWorkUsesAgentSubmit helpers, no tab.teamWork, no raw
    // AGENT_SUBMIT_CHORD path. Per-terminal text input is the Rich Prompt.
    expect(terminalSource).not.toMatch(/<TeamWork\b/);
    expect(terminalSource).not.toMatch(/submitTeamWork/);
    expect(terminalSource).not.toMatch(/teamWorkUsesAgentSubmit/);
    expect(terminalSource).not.toMatch(/tab\.teamWork/);
    expect(terminalSource).not.toMatch(/AGENT_SUBMIT_CHORD/);
  });

  test("mounts a PER-TERMINAL survey overlay, keyed by tab.id", () => {
    // Surveys are per-terminal, not window-wide. Each visible
    // terminal mounts its own <BubbleOverlay tabId={tab.id} />, anchored over
    // it; the App-root mount (tabId null) is the window-wide fallback.
    expect(terminalSource).toMatch(
      /import BubbleOverlay from "\.\/BubbleOverlay\.svelte"/,
    );
    expect(terminalSource).toMatch(
      /\{#if active\}[\s\S]{1,80}<BubbleOverlay tabId=\{tab\.id\} \/>/,
    );
  });

  test("the deleted watcher + team-work-workspace plumbing is gone", () => {
    expect(terminalSource).not.toMatch(/refreshWatcherEvents/);
    expect(terminalSource).not.toMatch(/ensureTeamWorkWorkspace/);
    expect(terminalSource).not.toMatch(/persistTeamWorkSubmission/);
    expect(terminalSource).not.toMatch(/readWatcherEvents/);
    expect(terminalSource).not.toMatch(/watcherPollTimer/);
  });

  test("terminal links route clicks through openExternalUrl (LINKS)", () => {
    // WebLinksAddon gets a custom handler instead of its default
    // window.open(_blank), which is inert / opens in-app under the
    // chan-desktop Tauri webview. openExternalUrl gives a real browser
    // tab on web and the OS default browser on desktop.
    expect(terminalSource).toMatch(
      /new WebLinksAddon\(\(_event, uri\) => \{[\s\S]*?void openExternalUrl\(uri\);/,
    );
    expect(terminalSource).toMatch(
      /import \{ openExternalUrl \} from "\.\.\/editor\/external_links";/,
    );
  });
});
