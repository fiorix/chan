// @vitest-environment jsdom
//
// The PTY socket's liveness kit: the app-level heartbeat (client
// {"type":"ping"} -> server {"type":"pong"}, the watcher vocabulary), the
// read-deadline that force-closes a half-open zombie, and the capped-backoff
// redial through the existing session/since/generation reattach. The kit
// shares the watcher's constants from transport.ts (source-pinned below so
// the two cannot drift); the live 300s gateway-cut proof rides the host
// smoke + the gateway rig.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import {
  setSocketFactory,
  WS_CONNECT_DEADLINE_MS,
  WS_PING_MS,
  WS_READ_DEADLINE_MS,
  WS_RECONNECT_BACKOFF_MIN_MS,
  WS_RECONNECT_BACKOFF_MAX_MS,
} from "../api/transport";
import { acquireDocSession, resetDocSyncForTests } from "../state/docSync.svelte";
import { acquireSceneSession, resetSceneSyncForTests } from "../state/sceneSync.svelte";
import { ui } from "../state/store.svelte";
import { WAKE_PROBE_MS } from "../wakeGap";
import {
  bumpTabFocusPulse,
  type FileTab,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import {
  installTerminalDom,
  mountTerminal,
  resetTerminals,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

installTerminalDom();

beforeEach(() => {
  vi.useFakeTimers();
  // Dials stay CONNECTING until a test opens or fails them, and each
  // terminal's focus lands on a real textarea, as xterm's does.
  TerminalSocket.connecting = true;
  xterm.textareaFocus = true;
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
});

/// Lines the component wrote INTO the terminal: the surface the version-skew
/// guard must keep ping-error spam out of.
function writtenLines(): string[] {
  return xterm.terminals.flatMap((term) => term.written);
}

/// Focus calls on every terminal the tests made.
function xtermFocusCalls(): number {
  return xterm.terminals.reduce((n, term) => n + term.focusCount, 0);
}

function pings(socket: TerminalSocket): number {
  return socket.sent.filter((s) => s === JSON.stringify({ type: "ping" })).length;
}

function terminalTab(partial: Partial<TerminalTabState> = {}): TerminalTabState {
  return {
    kind: "terminal",
    id: "term-hb-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

function lastSocket(): TerminalSocket {
  const socket = TerminalSocket.all.at(-1);
  if (!socket) throw new Error("expected terminal websocket");
  return socket;
}

async function attach(socket: TerminalSocket, id = "sess-1"): Promise<void> {
  socket.open();
  await socket.onmessage?.({
    data: JSON.stringify({
      type: "session",
      id,
      seq: 0,
      generation: 1,
      missed_bytes: 0,
      bytes_since_focus: 0,
    }),
  });
}

async function pong(socket: TerminalSocket): Promise<void> {
  await socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
}

describe("terminal heartbeat", () => {
  test("pings every WS_PING_MS while the socket is open", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = lastSocket();
    await attach(socket);

    expect(pings(socket)).toBe(0);
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(pings(socket)).toBe(1);
    await pong(socket);
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(pings(socket)).toBe(2);
    await pong(socket);
    // Frames kept arriving, so the read-deadline never tripped: one socket.
    expect(TerminalSocket.all).toHaveLength(1);
    expect(socket.readyState).toBe(TerminalSocket.OPEN);
  });

  test("a silent socket trips the read-deadline and redials the SAME session", async () => {
    const tab = terminalTab();
    await mountTerminal(TerminalTab, tab, { focused: false });
    const socket = lastSocket();
    await attach(socket, "sess-keep");

    // No inbound frames at all: pings go out unanswered and the deadline
    // force-closes the zombie.
    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    expect(socket.readyState).toBe(3);
    expect(TerminalSocket.all).toHaveLength(1);

    // The redial fires after the first backoff step and reattaches by id.
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    expect(TerminalSocket.all).toHaveLength(2);
    expect(lastSocket().url).toContain("session=sess-keep");
    expect(tab.terminalSessionId).toBe("sess-keep");

    // A successful reattach resumes the heartbeat on the new socket.
    await attach(lastSocket(), "sess-keep");
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(pings(lastSocket())).toBe(1);
  });

  test("exactly one redial is in flight after a deadline trip", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    await attach(lastSocket());

    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    // Within the redial's own connect-deadline window there is exactly one
    // dial; past it the hung attempt is force-closed into the next backoff
    // step (the heal keeps healing, one dial at a time).
    await vi.advanceTimersByTimeAsync(WS_CONNECT_DEADLINE_MS - 1);
    expect(TerminalSocket.all).toHaveLength(2);
  });

  test("a dial stuck in CONNECTING trips the connect-deadline and redials", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = lastSocket();
    // Never opened: only the connect-deadline covers the hung dial.
    await vi.advanceTimersByTimeAsync(WS_CONNECT_DEADLINE_MS);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    expect(TerminalSocket.all).toHaveLength(2);
  });

  test("redial backoff doubles per failure and caps at the max", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    await attach(lastSocket());

    // Trip the deadline, then fail every dial the moment it is scheduled in.
    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    // Delays consumed: 500 (the trip's redial), then doubling per failed dial.
    const delays = [500, 1000, 2000, 4000, 8000, 8000, 8000];
    for (const delay of delays) {
      const count = TerminalSocket.all.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(TerminalSocket.all.length).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(TerminalSocket.all.length).toBe(count + 1);
      lastSocket().failDial();
    }
  });

  test("a resumable session id survives every transport failure and clears only on an explicit close", async () => {
    const tab = terminalTab({ terminalSessionId: "sess-durable" });
    await mountTerminal(TerminalTab, tab, { focused: false });

    // An offline / sleep window: every dial dies on transport before its
    // `session` frame. The resumable id must survive all of them so the
    // persisted remote session can still be reattached on reconnect.
    lastSocket().failDial();
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
      lastSocket().failDial();
    }
    expect(tab.terminalSessionId).toBe("sess-durable");

    // The server ending the session explicitly is the only thing that clears
    // the id: reattach, then deliver a `closed` frame.
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    await attach(lastSocket(), "sess-durable");
    expect(tab.terminalSessionId).toBe("sess-durable");
    await lastSocket().onmessage?.({
      data: JSON.stringify({ type: "closed", reason: "idle" }),
    });
    expect(tab.terminalSessionId).toBeUndefined();
  });

  test("an old server's unknown-variant ping error is liveness, not terminal spam", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = lastSocket();
    await attach(socket);

    await socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        message: "invalid terminal frame: unknown variant `ping`, expected one of `input`",
      }),
    });
    expect(writtenLines().some((l) => l.includes("invalid terminal frame"))).toBe(false);

    // A real error still writes into the terminal.
    await socket.onmessage?.({
      data: JSON.stringify({ type: "error", message: "pty write failed" }),
    });
    expect(writtenLines().some((l) => l.includes("terminal error: pty write failed"))).toBe(true);
  });
});

describe("wake recycle", () => {
  // A sleep freezes JS timers while the wall clock advances; the wake-gap
  // detector notices on its first post-wake probe tick. setSystemTime jumps
  // the mocked wall clock without firing timers, so one probe-length advance
  // lands the tick that sees the jump.
  async function wake(): Promise<void> {
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MS);
  }

  test("a control tab opens no second socket across a wake recycle", async () => {
    // The control terminal is a single-shot local runner owned by the desktop
    // exit watcher: a wake redial would mint a fresh session server-side and
    // re-run the devserver connect script into the viewport.
    ui.terminalControl = true;
    try {
      await mountTerminal(TerminalTab, terminalTab(), { focused: false });
      const socket = lastSocket();
      await attach(socket, "sess-ctl");
      expect(TerminalSocket.all).toHaveLength(1);

      await wake();

      expect(TerminalSocket.all).toHaveLength(1);
      expect(socket.readyState).toBe(TerminalSocket.OPEN);
    } finally {
      ui.terminalControl = false;
    }
  });

  test("an ordinary tab still redials with its prior session id after a wake", async () => {
    const tab = terminalTab();
    await mountTerminal(TerminalTab, tab, { focused: false });
    const socket = lastSocket();
    await attach(socket, "sess-wake");
    expect(TerminalSocket.all).toHaveLength(1);

    await wake();

    // The recycle forces a reconnect through the normal resume path: a
    // second dial carrying the same session id, replaying missed bytes.
    expect(TerminalSocket.all).toHaveLength(2);
    expect(lastSocket().url).toContain("session=sess-wake");
    expect(tab.terminalSessionId).toBe("sess-wake");
  });
});

describe("the shared reconnect backoff", () => {
  afterEach(() => {
    resetDocSyncForTests();
    resetSceneSyncForTests();
    setSocketFactory(null);
    localStorage.clear();
  });

  function fileTab(path: string, mode: FileTab["mode"], content: string): FileTab {
    return {
      kind: "file",
      fileKind: mode === "canvas" ? "text" : "document",
      id: `sync-${path}`,
      path,
      content,
      saved: content,
      savedMtime: 1,
      savedMtimeNs: "1000000000",
      mode,
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

  /// With every redial failing, the delay before each next dial.
  async function redialDelays(count: number): Promise<number[]> {
    const delays: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const before = TerminalSocket.all.length;
      let waited = 0;
      while (TerminalSocket.all.length === before && waited < WS_RECONNECT_BACKOFF_MAX_MS * 2) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      delays.push(waited);
      lastSocket().failDial();
    }
    return delays;
  }

  const EXPECTED = [500, 1000, 2000, 4000, 8000, 8000];

  test("the terminal socket reads its frames as ArrayBuffers", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    expect(lastSocket().binaryType).toBe("arraybuffer");
  });

  test("a live document session redials from the shared minimum, doubling to the shared maximum", async () => {
    expect([WS_RECONNECT_BACKOFF_MIN_MS, WS_RECONNECT_BACKOFF_MAX_MS]).toEqual([500, 8000]);
    localStorage.setItem("chan.docsync", "1");
    setSocketFactory((url) => new TerminalSocket(url) as unknown as WebSocket);
    acquireDocSession(fileTab("notes/a.md", "source", "hello"));
    const first = lastSocket();
    first.open();
    await first.onmessage?.({
      data: JSON.stringify({ type: "snapshot", path: "notes/a.md", version: 0, doc: "hello", dirty: false, mtime_ns: null, cursors: [] }),
    });
    first.close();

    expect(await redialDelays(EXPECTED.length)).toEqual(EXPECTED);
  });

  test("a live scene session redials on the same schedule", async () => {
    localStorage.setItem("chan.scenesync", "1");
    setSocketFactory((url) => new TerminalSocket(url) as unknown as WebSocket);
    acquireSceneSession(fileTab("boards/b.excalidraw", "canvas", '{"type":"excalidraw","elements":[]}'));
    const first = lastSocket();
    first.open();
    await first.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        path: "boards/b.excalidraw",
        version: 0,
        elements: [],
        appState: {},
        files: {},
        dirty: false,
        mtime_ns: null,
        cursors: [],
      }),
    });
    first.close();

    expect(await redialDelays(EXPECTED.length)).toEqual(EXPECTED);
  });
});

describe("wake input recovery", () => {
  async function wake(): Promise<void> {
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MS);
  }

  test("a wake restores DOM focus to the still-focused terminal", async () => {
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab);
    await attach(lastSocket(), "sess-focus");

    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);

    // WKWebView keeps the page-level `focused` prop true across sleep, but its
    // xterm textarea can lose DOM focus. The wake callback must restore the
    // keyboard owner even though no Svelte focus-state edge fires.
    textarea?.blur();
    expect(document.activeElement).not.toBe(textarea);

    await wake();

    expect(document.activeElement).toBe(textarea);
  });

  test("a wake reissues focus when xterm still appears focused", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab());
    await attach(lastSocket(), "sess-stale-focus");

    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(document.activeElement).toBe(textarea);
    const callsBeforeWake = xtermFocusCalls();

    await wake();

    expect(xtermFocusCalls()).toBe(callsBeforeWake + 1);
    expect(document.activeElement).toBe(textarea);
  });

  test("a wake does not steal focus from another DOM owner", async () => {
    await mountTerminal(TerminalTab, terminalTab());
    await attach(lastSocket(), "sess-external-focus");
    const external = document.createElement("input");
    document.body.append(external);
    external.focus();

    await wake();

    expect(document.activeElement).toBe(external);
  });

  test("a wake does not focus a background terminal", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    await attach(lastSocket(), "sess-background");
    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(xtermFocusCalls()).toBe(0);

    await wake();

    expect(xtermFocusCalls()).toBe(0);
    expect(document.activeElement).not.toBe(textarea);
  });

  test("the tab focus pulse restores the same lost terminal focus", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab());
    await attach(lastSocket(), "sess-tab-focus");

    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(document.activeElement).toBe(textarea);

    textarea?.blur();
    bumpTabFocusPulse();
    await tick();

    expect(document.activeElement).toBe(textarea);
  });

  test("input typed during reconnect backoff is dropped rather than replayed", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = lastSocket();
    await attach(first, "sess-backoff");

    first.close();
    const onData = xterm.terminals.at(-1)?.dataHandlers.at(-1);
    expect(onData).toBeDefined();
    onData?.("x");
    expect(first.sent).not.toContain(
      JSON.stringify({ type: "input", data: "x" }),
    );

    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const second = lastSocket();
    await attach(second, "sess-backoff");
    expect(second.sent).not.toContain(
      JSON.stringify({ type: "input", data: "x" }),
    );
  });
});
