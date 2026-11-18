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
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { terminalPreferences } from "../__tests__/standalone";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";

const SESSION = "sess-ghostty";
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

  test.each([1000, 1002, 1003, 1004, 1006, 1015, 1049])(
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
