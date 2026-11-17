// @vitest-environment jsdom
//
// Session boundaries and mouse input through the real widget and vendored
// core. The socket records the PTY wire; the software canvas serves jsdom.

import type { Terminal } from "@chan/ghostty-web-ng";
import { unmount } from "svelte";
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
import { terminalPreferences } from "../__tests__/standalone";
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
    for (const type of ["mousedown", "mouseup"]) {
      host.dispatchEvent(
        new MouseEvent(type, {
          button: 0, clientX: 150.5 * width, clientY: 3.5 * height, bubbles: true, cancelable: true,
        }),
      );
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
