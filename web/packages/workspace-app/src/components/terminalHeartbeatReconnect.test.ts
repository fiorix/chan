// @vitest-environment jsdom
//
// The PTY socket's liveness kit: the app-level heartbeat (client
// {"type":"ping"} -> server {"type":"pong"}, the watcher vocabulary), the
// read-deadline that force-closes a half-open zombie, and the capped-backoff
// redial through the existing session/since/generation reattach. The kit
// shares the watcher's constants from transport.ts (source-pinned below so
// the two cannot drift); the live 300s gateway-cut proof rides the host
// smoke + the gateway rig.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import terminalSource from "./TerminalTab.svelte?raw";
import docSyncSource from "../state/docSync.svelte.ts?raw";
import sceneSyncSource from "../state/sceneSync.svelte.ts?raw";
import {
  WS_CONNECT_DEADLINE_MS,
  WS_PING_MS,
  WS_READ_DEADLINE_MS,
  WS_RECONNECT_BACKOFF_MIN_MS,
  WS_RECONNECT_BACKOFF_MAX_MS,
} from "../api/transport";
import { ui } from "../state/store.svelte";
import { WAKE_PROBE_MS } from "../wakeGap";
import {
  bumpTabFocusPulse,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";

const mounted: Array<Record<string, any>> = [];
const sockets: TestWebSocket[] = [];
const xtermDataHandlers = vi.hoisted(() => [] as Array<(data: string) => void>);
const xtermFocusCalls = vi.hoisted(() => [] as HTMLTextAreaElement[]);

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestWebSocket {
  static OPEN = 1;

  readyState = 0;
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

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  // A dial that fails before ever opening (connection refused).
  failDial() {
    this.readyState = 3;
    this.onclose?.();
  }

  pings(): number {
    return this.sent.filter((s) => s === JSON.stringify({ type: "ping" })).length;
  }
}

// Lines the component writes INTO the terminal (term.writeln): the surface
// the version-skew guard must keep ping-error spam out of.
const writtenLines = vi.hoisted(() => [] as string[]);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    textarea: HTMLTextAreaElement | null = null;

    loadAddon() {}
    open(host: HTMLElement) {
      this.textarea = document.createElement("textarea");
      host.append(this.textarea);
    }
    attachCustomKeyEventHandler() {}
    onData(handler: (data: string) => void) {
      xtermDataHandlers.push(handler);
    }
    onResize() {}
    write() {}
    writeln(line: string) {
      writtenLines.push(line);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    focus() {
      if (!this.textarea) return;
      xtermFocusCalls.push(this.textarea);
      this.textarea.focus();
    }
    blur() {
      this.textarea?.blur();
    }
    dispose() {
      this.textarea?.remove();
      this.textarea = null;
    }
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  sockets.splice(0);
  xtermDataHandlers.splice(0);
  xtermFocusCalls.splice(0);
  writtenLines.splice(0);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

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

async function renderTerminal(tab: TerminalTabState, focused = false) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: "pane-1", active: true, focused },
  });
  mounted.push(component);
  await tick();
  await tick();
  return target;
}

function lastSocket(): TestWebSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error("expected terminal websocket");
  return socket;
}

async function attach(socket: TestWebSocket, id = "sess-1"): Promise<void> {
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

async function pong(socket: TestWebSocket): Promise<void> {
  await socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
}

describe("terminal heartbeat", () => {
  test("pings every WS_PING_MS while the socket is open", async () => {
    await renderTerminal(terminalTab());
    const socket = lastSocket();
    await attach(socket);

    expect(socket.pings()).toBe(0);
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(socket.pings()).toBe(1);
    await pong(socket);
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(socket.pings()).toBe(2);
    await pong(socket);
    // Frames kept arriving, so the read-deadline never tripped: one socket.
    expect(sockets).toHaveLength(1);
    expect(socket.readyState).toBe(TestWebSocket.OPEN);
  });

  test("a silent socket trips the read-deadline and redials the SAME session", async () => {
    const tab = terminalTab();
    await renderTerminal(tab);
    const socket = lastSocket();
    await attach(socket, "sess-keep");

    // No inbound frames at all: pings go out unanswered and the deadline
    // force-closes the zombie.
    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    expect(socket.readyState).toBe(3);
    expect(sockets).toHaveLength(1);

    // The redial fires after the first backoff step and reattaches by id.
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    expect(sockets).toHaveLength(2);
    expect(lastSocket().url).toContain("session=sess-keep");
    expect(tab.terminalSessionId).toBe("sess-keep");

    // A successful reattach resumes the heartbeat on the new socket.
    await attach(lastSocket(), "sess-keep");
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    expect(lastSocket().pings()).toBe(1);
  });

  test("exactly one redial is in flight after a deadline trip", async () => {
    await renderTerminal(terminalTab());
    await attach(lastSocket());

    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    // Within the redial's own connect-deadline window there is exactly one
    // dial; past it the hung attempt is force-closed into the next backoff
    // step (the heal keeps healing, one dial at a time).
    await vi.advanceTimersByTimeAsync(WS_CONNECT_DEADLINE_MS - 1);
    expect(sockets).toHaveLength(2);
  });

  test("a dial stuck in CONNECTING trips the connect-deadline and redials", async () => {
    await renderTerminal(terminalTab());
    const socket = lastSocket();
    // Never opened: only the connect-deadline covers the hung dial.
    await vi.advanceTimersByTimeAsync(WS_CONNECT_DEADLINE_MS);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    expect(sockets).toHaveLength(2);
  });

  test("redial backoff doubles per failure and caps at the max", async () => {
    await renderTerminal(terminalTab());
    await attach(lastSocket());

    // Trip the deadline, then fail every dial the moment it is scheduled in.
    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS);
    // Delays consumed: 500 (the trip's redial), then doubling per failed dial.
    const delays = [500, 1000, 2000, 4000, 8000, 8000, 8000];
    for (const delay of delays) {
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets.length).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets.length).toBe(count + 1);
      lastSocket().failDial();
    }
  });

  test("a resumable session id survives every transport failure and clears only on an explicit close", async () => {
    const tab = terminalTab({ terminalSessionId: "sess-durable" });
    await renderTerminal(tab);

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
    await renderTerminal(terminalTab());
    const socket = lastSocket();
    await attach(socket);

    await socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        message: "invalid terminal frame: unknown variant `ping`, expected one of `input`",
      }),
    });
    expect(writtenLines.some((l) => l.includes("invalid terminal frame"))).toBe(false);

    // A real error still writes into the terminal.
    await socket.onmessage?.({
      data: JSON.stringify({ type: "error", message: "pty write failed" }),
    });
    expect(writtenLines.some((l) => l.includes("terminal error: pty write failed"))).toBe(true);
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
      await renderTerminal(terminalTab());
      const socket = lastSocket();
      await attach(socket, "sess-ctl");
      expect(sockets).toHaveLength(1);

      await wake();

      expect(sockets).toHaveLength(1);
      expect(socket.readyState).toBe(TestWebSocket.OPEN);
    } finally {
      ui.terminalControl = false;
    }
  });

  test("an ordinary tab still redials with its prior session id after a wake", async () => {
    const tab = terminalTab();
    await renderTerminal(tab);
    const socket = lastSocket();
    await attach(socket, "sess-wake");
    expect(sockets).toHaveLength(1);

    await wake();

    // The recycle forces a reconnect through the normal resume path: a
    // second dial carrying the same session id, replaying missed bytes.
    expect(sockets).toHaveLength(2);
    expect(lastSocket().url).toContain("session=sess-wake");
    expect(tab.terminalSessionId).toBe("sess-wake");
  });
});

describe("heartbeat source pins", () => {
  test("the kit rides the shared transport constants, no duplicated literals", () => {
    expect(terminalSource).toContain(
      'pingTimer = setInterval(() => send({ type: "ping" }), WS_PING_MS);',
    );
    expect(terminalSource).toMatch(/deadlineTimer = setTimeout\([\s\S]{0,200}WS_READ_DEADLINE_MS\)/);
    expect(terminalSource).toMatch(
      /deadlineTimer = setTimeout\([\s\S]{0,200}WS_CONNECT_DEADLINE_MS\)/,
    );
    expect(terminalSource).toContain('ws.binaryType = "arraybuffer";\n    armConnectDeadline();');
    expect(terminalSource).toContain(
      "reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, WS_RECONNECT_BACKOFF_MAX_MS);",
    );
    expect(terminalSource).toContain("let reconnectBackoffMs = WS_RECONNECT_BACKOFF_MIN_MS;");
    // The single-dial guard: an explicit connect supersedes a scheduled
    // redial before the socket teardown.
    expect(terminalSource).toMatch(
      /async function connect\(\): Promise<void> \{\n    if \(!term\) return;\n    \/\/ Single-dial guard/,
    );
    expect(terminalSource).toContain("cancelReconnect();");
  });

  test("doc-sync and scene-sync backoffs ride the same shared constants", () => {
    for (const source of [docSyncSource, sceneSyncSource]) {
      expect(source).toContain("private backoffMs = WS_RECONNECT_BACKOFF_MIN_MS;");
      expect(source).toContain(
        "this.backoffMs = Math.min(this.backoffMs * 2, WS_RECONNECT_BACKOFF_MAX_MS);",
      );
      // No local literals left to drift.
      expect(source).not.toMatch(/RECONNECT_BASE_MS|RECONNECT_MAX_MS/);
    }
  });
});

describe("wake input recovery", () => {
  async function wake(): Promise<void> {
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MS);
  }

  test("a wake restores DOM focus to the still-focused terminal", async () => {
    const tab = terminalTab();
    const target = await renderTerminal(tab, true);
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
    const target = await renderTerminal(terminalTab(), true);
    await attach(lastSocket(), "sess-stale-focus");

    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(document.activeElement).toBe(textarea);
    const callsBeforeWake = xtermFocusCalls.length;

    await wake();

    expect(xtermFocusCalls.length).toBe(callsBeforeWake + 1);
    expect(document.activeElement).toBe(textarea);
  });

  test("a wake does not steal focus from another DOM owner", async () => {
    await renderTerminal(terminalTab(), true);
    await attach(lastSocket(), "sess-external-focus");
    const external = document.createElement("input");
    document.body.append(external);
    external.focus();

    await wake();

    expect(document.activeElement).toBe(external);
  });

  test("a wake does not focus a background terminal", async () => {
    const target = await renderTerminal(terminalTab());
    await attach(lastSocket(), "sess-background");
    const textarea = target.querySelector<HTMLTextAreaElement>(
      ".terminal-host textarea",
    );
    expect(xtermFocusCalls).toHaveLength(0);

    await wake();

    expect(xtermFocusCalls).toHaveLength(0);
    expect(document.activeElement).not.toBe(textarea);
  });

  test("the tab focus pulse restores the same lost terminal focus", async () => {
    const target = await renderTerminal(terminalTab(), true);
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
    await renderTerminal(terminalTab());
    const first = lastSocket();
    await attach(first, "sess-backoff");

    first.close();
    const onData = xtermDataHandlers.at(-1);
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
