// @vitest-environment jsdom
//
// Session boundaries and mouse input through the real widget and vendored
// core. The socket records the PTY wire; the software canvas serves jsdom.

import type { Terminal } from "@chan/ghostty-web-ng";
import { tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  ...(await import("../__tests__/ghosttyTab")).ghosttyCompatStubs(),
}));

import TerminalTab from "./TerminalTab.svelte";
import {
  attachGhostty, compileGhosttyCore, ghosttyAlternateScreen, ghosttyCellMetrics,
  ghosttyLineText, ghosttyMode, ghosttyMouseTracking, installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import { GhosttyViewportController } from "../terminal/ghosttyViewport";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { TERMINAL_INPUT_PROBE_MS } from "./terminalConnectionHealth.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { engineClick, modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { FRESH_SHELL_ALT_EXIT, FRESH_SHELL_RESET_MODES } from "../terminal/freshShellReset";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetClearsMode,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";

const SESSION = "sess-ghostty";
// The mounted cases below stay a literal list so a dropped mode goes red at
// its own case; the drift test forces it to grow with the reset list.
const GHOSTTY_CASES = [1, 9, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004, 1049];
const mounted = new Set<Record<string, unknown>>();
const cleanups: Array<() => void> = [];

installTerminalDom();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  vi.useFakeTimers();
  installSoftwareCanvas();
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
});

afterEach(async () => {
  for (const component of mounted) await unmount(component);
  mounted.clear();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  resetTerminals();
  ghostty.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openGhostty(tab: TerminalTabState, ready = true) {
  const opened = mountGhostty(TerminalTab, tab);
  mounted.add(opened.component);
  const attached = await attachGhostty(ghostty, opened, { sessionId: SESSION, ready });
  return { component: opened.component, ...attached };
}

async function reconnect(socket: TerminalSocket, id: string, replayBytes = 0) {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  await attach(next, { id, replay_bytes: replayBytes });
  return next;
}

function shiftEnter(host: HTMLElement): void {
  host.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, shiftKey: true, bubbles: true, cancelable: true,
    }),
  );
}

function inputFrames(socket: TerminalSocket) {
  return sentFrames(socket).filter((frame) => frame.type === "input" || frame.type === "broadcast-input");
}

describe("a Ghostty tab reconnecting to a session", () => {
  test("an alternate-screen wheel arrow arms no input ping and owes no note", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { host, socket, term } = await openGhostty(tab!);
    await output(socket, "\x1b[?1049h");
    expect(ghosttyAlternateScreen(term)).toBe(true);
    await receive(socket, { type: "pong" });
    const beforePings = sentFrames(socket).filter((frame) => frame.type === "ping").length;
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    expect(ghosttyCellMetrics(term).height).toBeGreaterThan(0);
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1, deltaMode: 1 }));
    expect(inputFrames(socket)).toContainEqual({ type: "input", data: "\x1b[A" });
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS + 1_000);
    expect(sentFrames(socket).filter((frame) => frame.type === "ping")).toHaveLength(beforePings);
    socket.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!, { id: SESSION });
    await tick();
    expect(document.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });
  test.each([
    ["replacement", "sess-fresh", "\n"],
    ["resume", SESSION, "\x1b[27;2;13~"],
  ] as const)("%s uses the session's keyboard protocol", async (_name, id, expected) => {
    const [tab] = seatTerminals([terminalTab()]);
    const { host, socket, term } = await openGhostty(tab!);
    await output(socket, "\x1b[>4;2m");
    socket.sent.splice(0);
    shiftEnter(host);
    expect(inputFrames(socket)).toEqual([{ type: "input", data: "\x1b[27;2;13~" }]);

    const next = await reconnect(socket, id);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    next.sent.splice(0);
    shiftEnter(host);
    expect(inputFrames(next)).toEqual([{ type: "input", data: expected }]);
    expect(ghostty.terminals).toEqual([term]);
  });

  // The server's tracked set the core records, plus the alternate-screen
  // exit the reset keeps: each mode set by the dead program, kept on a
  // same-id resume and cleared for a fresh shell. Mode 1001 has its own
  // case below: the core keeps no highlight-tracking state, so that case
  // reads the reset's bytes written to ghostty instead.
  test.each(GHOSTTY_CASES)(
    "preserves DEC %i on resume and clears it for a fresh shell",
    async (mode) => {
      const [tab] = seatTerminals([terminalTab()]);
      const { socket, term } = await openGhostty(tab!);
      await output(socket, `\x1b[?${mode}h`);
      expect(ghosttyMode(term, mode), "the program enabled the mode in the core").toBe(true);
      if (mode === 1049) expect(ghosttyAlternateScreen(term)).toBe(true);

      const resumed = await reconnect(socket, SESSION);
      await receive(resumed, { type: "ready", cols: 80, rows: 24 });
      expect(ghosttyMode(term, mode), "the same program still owns its mode").toBe(true);
      if (mode === 1049) expect(ghosttyAlternateScreen(term)).toBe(true);

      const replaced = await reconnect(resumed, "sess-fresh");
      await receive(replaced, { type: "ready", cols: 80, rows: 24 });
      expect(ghosttyMode(term, mode), "the fresh shell inherits no dead program's mode").toBe(false);
      if (mode === 1049) expect(ghosttyAlternateScreen(term)).toBe(false);
      expect(ghostty.terminals).toEqual([term]);
    },
  );

  test("a fresh shell's first output sets 2004 and mode 1 after the reset", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await output(socket, "\x1b[?2004h\x1b[?1h");
    expect(ghosttyMode(term, 2004), "the dead program set bracketed paste").toBe(true);
    expect(ghosttyMode(term, 1), "the dead program set application cursor keys").toBe(true);

    const replaced = await reconnect(socket, "sess-fresh");
    await output(replaced, "\x1b[?2004h\x1b[?1h");
    await receive(replaced, { type: "ready", cols: 80, rows: 24 });
    expect(ghosttyMode(term, 2004), "the fresh shell's bracketed paste survives the reset").toBe(true);
    expect(ghosttyMode(term, 1), "the fresh shell's cursor keys survive the reset").toBe(true);
    expect(ghostty.terminals).toEqual([term]);
  });

  test("clears DEC 1001 for a fresh shell (reads the reset bytes written to ghostty: the core records no highlight-tracking state)", async () => {
    const spy = vi.spyOn(GhosttyViewportController.prototype, "write");
    try {
      const [tab] = seatTerminals([terminalTab()]);
      const { socket, term } = await openGhostty(tab!);
      await output(socket, "\x1b[?1001h");
      // The first attach adopts a session the tab never held, so it writes
      // the reset too; the resume and replacement cases read from here.
      spy.mockClear();
      const written = () =>
        spy.mock.calls.map(([data]) => (typeof data === "string" ? data : new TextDecoder().decode(data))).join("");

      const resumed = await reconnect(socket, SESSION);
      await receive(resumed, { type: "ready", cols: 80, rows: 24 });
      expect(resetClearsMode(written(), 1001), "a same-id resume writes no reset").toBe(false);

      const replaced = await reconnect(resumed, "sess-fresh");
      await receive(replaced, { type: "ready", cols: 80, rows: 24 });
      expect(resetClearsMode(written(), 1001), "the fresh shell's reset clears highlight tracking").toBe(true);
      expect(ghostty.terminals).toEqual([term]);
    } finally {
      spy.mockRestore();
    }
  });

  test("ties the mounted case list to the reset list", () => {
    // The cases above stay literal so a dropped mode goes red at its own
    // case; this ties that literal list to the reset list. Ghostty's core
    // keeps no highlight-tracking state, so 1001 has the byte-reading case
    // above instead, and the alternate-screen exit rides alongside.
    expect(new Set(GHOSTTY_CASES)).toEqual(
      new Set([...FRESH_SHELL_RESET_MODES.filter((mode) => mode !== 1001), FRESH_SHELL_ALT_EXIT]),
    );
  });
});

describe("mouse events encoded by the Ghostty input handler", () => {
  test.each([false, true])("sends a wide press and release to the PTY and group, SGR %s", async (sgr) => {
    const [tab, member] = seatTerminals([
      terminalTab({ broadcastEnabled: true }),
      terminalTab({ id: "term-2", broadcastEnabled: true }),
    ]);
    const received: Array<[string, boolean | undefined]> = [];
    cleanups.push(registerTerminalInputSink(member!.id, (data, binary) => received.push([data, binary])));
    const { host, socket, term } = await openGhostty(tab!);
    term.resize(220, 24);
    await output(socket, `\x1b[?1000h\x1b[?1006${sgr ? "h" : "l"}`);
    expect(ghosttyMouseTracking(term)).toBe(true);
    socket.sent.splice(0);
    const { width, height } = ghosttyCellMetrics(term);
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    modelPointerCapture(canvas);
    for (const type of ["pointerdown", "pointerup"] as const) {
      mousePointer(canvas, type, { clientX: 150.5 * width, clientY: 3.5 * height });
    }
    const reports = sgr
      ? ["\x1b[<0;151;4M", "\x1b[<0;151;4m"]
      : [0, 3].map((button) => `\x1b[M${String.fromCharCode(button + 32, 151 + 32, 4 + 32)}`);
    expect(inputFrames(socket)).toEqual(
      reports.flatMap((data) => [
        { type: "input", data, ...(!sgr && { binary: true }) },
        { type: "broadcast-input", data, ...(!sgr && { binary: true }) },
      ]),
    );
    expect(received).toEqual(reports.map((data) => [data, !sgr]));
  });

  test("on the Linux desktop a middle click pastes PRIMARY once and reports nothing; the other buttons still report", async () => {
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => (cmd === "read_primary_selection" ? "from PRIMARY" : undefined));
    const desktop = window as unknown as { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
    desktop.__TAURI_INTERNALS__ = { invoke };
    cleanups.push(() => delete desktop.__TAURI_INTERNALS__);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    const [tab] = seatTerminals([terminalTab()]);
    const { host, socket, term } = await openGhostty(tab!);
    await output(socket, "\x1b[?1000h\x1b[?1006h");
    expect(ghosttyMouseTracking(term)).toBe(true);
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    modelPointerCapture(canvas);
    const { width, height } = ghosttyCellMetrics(term);
    const at = { clientX: 2.5 * width, clientY: 1.5 * height };
    socket.sent.splice(0);
    invoke.mockClear();

    const middle = engineClick(canvas, 1, at);
    await vi.waitFor(() => expect(inputFrames(socket)).toEqual([{ type: "input", data: "from PRIMARY" }]));
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(middle.down.defaultPrevented, "the widget leaves a cancelled press to the embedder").toBe(true);
    expect(middle.click.defaultPrevented, "the webview does not paste it too").toBe(true);

    socket.sent.splice(0);
    for (const button of [0, 2] as const) {
      expect(engineClick(canvas, button, at).down.defaultPrevented, `button ${button} stays the widget's`).toBe(false);
    }
    expect(inputFrames(socket).map((frame) => frame.data)).toEqual([
      "\x1b[<0;3;2M", "\x1b[<0;3;2m", "\x1b[<2;3;2M", "\x1b[<2;3;2m",
    ]);
  });
});

describe("a mouse filter holding an unfinished control sequence", () => {
  beforeEach(() => {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true, mouse_capture: false }));
  });

  test("drops the partial tail when a cut replay resumes with an empty ring", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { socket, term } = await openGhostty(tab!, false);
    await output(socket, "old\x1b[?100");
    expect(ghosttyLineText(term, 0)).toBe("old");

    const next = await reconnect(socket, SESSION);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    await output(next, "0hNEW");
    expect(ghosttyLineText(term, 0)).toBe("old0hNEW");
    expect(ghosttyMouseTracking(term)).toBe(false);
  });

  test("drops the partial tail when the same tab mounts a new widget", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const first = await openGhostty(tab!);
    await output(first.socket, "old\x1b[?100");
    await unmount(first.component);
    mounted.delete(first.component);

    const second = await openGhostty(tab!);
    await output(second.socket, "0hNEW");
    expect(second.term).not.toBe(first.term);
    expect(ghosttyLineText(second.term, 0)).toBe("0hNEW");
    expect(ghosttyMouseTracking(second.term)).toBe(false);
  });
});

describe("the lossy recovery suffix on the Ghostty core", () => {
  test("the normal-screen head leaves the cursor where the replay ended", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await output(socket, "\x1b[24;40H");
    await output(socket, "Q");
    await output(socket, "\x18\x1b7\x1b[?1049;1047;47l");
    await output(socket, "Z");
    expect(ghosttyLineText(term, 0), "the head writes nothing on row 1").toBe("");
    expect(ghosttyLineText(term, 23), "the byte after the head lands at the replay cursor").toBe("QZ");
  });

  test("the alternate-screen head leaves the terminal on the alternate screen", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    expect(ghosttyAlternateScreen(term), "the tab starts on the normal screen").toBe(false);
    await output(socket, "\x18\x1b[?1047h");
    expect(ghosttyAlternateScreen(term), "the alt head switches to the alternate screen").toBe(true);
  });

  // The core honors ?47h (this case stays green on it); the product keeps
  // ?1047h, the switch the guest suite exercises on both backends.
  test("the old ?47h head leaves the terminal on the alternate screen", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    expect(ghosttyAlternateScreen(term), "the tab starts on the normal screen").toBe(false);
    await output(socket, "\x18\x1b[?47h");
    expect(ghosttyAlternateScreen(term), "the core honors ?47h").toBe(true);
  });
});

describe("acknowledging parsed output on Ghostty", () => {
  function acks(socket: TerminalSocket) {
    return sentFrames(socket).filter((frame) => frame.type === "ack");
  }

  test("a server that advertises no window hears no acknowledgement", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket } = await openGhostty(tab!);
    expect(new URL(socket.url, "http://localhost").searchParams.get("ack")).toBe("1");
    await output(socket, "A".repeat(4096));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(socket)).toEqual([]);
  });

  test("the position counts raw replay and live bytes, not the preludes", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket } = await openGhostty(tab!);
    await receive(socket, {
      type: "session", id: SESSION, seq: 100, generation: 3, missed_bytes: 0, replay_bytes: 10, ack_window: 80,
    });
    await output(socket, "0123456789");
    expect(acks(socket), "a tenth of the window reports at once").toEqual([
      { type: "ack", generation: 3, seq: 100 },
    ]);
    // A mode reassert after the replay is not a stream byte.
    await output(socket, "\x1b[?2004h");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(socket), "the prelude moves nothing").toHaveLength(1);
    await output(socket, "abc");
    expect(acks(socket), "a short tail waits for its timer").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(socket).at(-1)).toEqual({ type: "ack", generation: 3, seq: 103 });
  });

  test("acknowledgements keep flowing while a wake's probe holds the user's input", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await receive(socket, {
      type: "session", id: SESSION, seq: 0, generation: 1, missed_bytes: 0, replay_bytes: 0, ack_window: 8,
    });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(2_100);
    term.input("x", true);
    expect(sentFrames(socket).filter((frame) => frame.type === "input"), "the key waits").toEqual([]);
    await output(socket, "ABCDEFGH");
    expect(acks(socket).at(-1)).toEqual({ type: "ack", generation: 1, seq: 8 });
    expect(sentFrames(socket).filter((frame) => frame.type === "input"), "the key still waits").toEqual([]);
  });

  test("after a reported loss the position is the server's and a redial repeats nothing", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await receive(socket, {
      type: "session", id: SESSION, seq: 50, generation: 1, missed_bytes: 0, replay_bytes: 0, ack_window: 8,
    });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "HEADHEAD");
    await receive(socket, {
      type: "session", id: SESSION, seq: 500, generation: 1, missed_bytes: 400, replay_bytes: 8, ack_window: 8,
    });
    await output(socket, "TAILTAIL");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(acks(socket).at(-1), "the replay ends at the frame's seq").toEqual({
      type: "ack", generation: 1, seq: 500,
    });
    const redialed = await reconnect(socket, SESSION);
    expect(new URL(redialed.url, "http://localhost").searchParams.get("since")).toBe("500");
    const body = Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "").join("\n");
    expect(body.split("TAILTAIL").length - 1, "no byte repeats after the redial").toBe(1);
    expect(body).toContain("terminal replay missed 400 bytes");
  });
});

describe("same-socket stream recovery on Ghostty", () => {
  function dialSince(socket: TerminalSocket): string | null {
    return new URL(socket.url, "http://localhost").searchParams.get("since");
  }

  function missedLines(term: Terminal): string[] {
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      const text = ghosttyLineText(term, row) ?? "";
      if (text.includes("terminal replay missed")) lines.push(text.trim());
    }
    return lines;
  }

  test("cursor equals the frame seq, replay applies once, one missed line", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await output(socket, "A".repeat(90));

    await receive(socket, {
      type: "session", id: SESSION, seq: 100, generation: 1, missed_bytes: 5, replay_bytes: 10,
    });
    await output(socket, "0123456789");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(missedLines(term)).toEqual(["terminal replay missed 5 bytes"]);

    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the redial resumes from the server's endpoint").toBe("100");
    await receive(redialed, { type: "ready", cols: 80, rows: 24 });
    await output(redialed, "NEW");
    const body = Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "").join("\n");
    expect(body.split("0123456789").length - 1, "no byte repeats after the redial").toBe(1);
    expect(missedLines(term), "no second missed line without a new loss").toEqual(["terminal replay missed 5 bytes"]);
  });

  test("zero loss stays silent and the cursor still equals the frame seq", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);

    await receive(socket, {
      type: "session", id: SESSION, seq: 40, generation: 1, missed_bytes: 0, replay_bytes: 0,
    });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(missedLines(term), "zero loss prints nothing").toEqual([]);

    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the redial still resumes from the server's endpoint").toBe("40");
  });

  test("an old server's lag error line prints and leaves the cursor alone", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket, term } = await openGhostty(tab!);
    await output(socket, "A".repeat(20));

    await receive(socket, { type: "error", message: "terminal output lagged; reconnect to replay retained scrollback" });
    const body = Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row) ?? "").join("\n");
    expect(body, "the old lag line keeps today's shape").toContain(
      "terminal error: terminal output lagged; reconnect to replay retained scrollback",
    );

    const redialed = await reconnect(socket, SESSION);
    expect(dialSince(redialed), "the error moves no cursor").toBe("20");
  });

  test("a replayed device query stays local during same-socket recovery", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket } = await openGhostty(tab!);
    socket.sent.splice(0);

    await receive(socket, {
      type: "session", id: SESSION, seq: 100, generation: 1, missed_bytes: 5, replay_bytes: 4,
    });
    await output(socket, "\x1b[6n");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(inputFrames(socket), "a replayed query is answered nowhere").toEqual([]);
  });

  test("a restart on the live socket answers the new shell's query", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { socket } = await openGhostty(tab!);
    await output(socket, "\x1bc");
    socket.sent.splice(0);

    await receive(socket, {
      type: "session", id: SESSION, seq: 4, generation: 2, missed_bytes: 0, replay_bytes: 4,
    });
    await output(socket, "\x1b[6n");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(inputFrames(socket).map((frame) => frame.data).join(""), "the terminal never parsed this shell's output").toMatch(/\x1b\[\d+;\d+R/);
  });
});
