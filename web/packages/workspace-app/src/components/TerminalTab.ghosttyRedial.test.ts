// @vitest-environment jsdom
//
// A redial of the live session on the alternate screen, through the real
// widget and vendored core, over a stand-in socket that answers as the
// server does: the redial echoes the view's cursor and generation, and its
// replay continues the view's screen as a live recovery does, the raw delta
// and, when bytes were lost, the alternate-screen recovery suffix. The core
// ends on the program's alternate screen with none of the modes the program
// turned off while the socket was down.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import {
  ghosttyAlternateScreen,
  ghosttyLineText,
  ghosttyMode,
  ghosttyMouseTracking,
  mountGhosttyTerminal,
} from "../__tests__/ghosttyTab";
import {
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-redial";
const GENERATION = 4;
const ACK_WINDOW = 4096;
/// Where the view's first replay ends.
const ATTACHED_AT = 100;
const SHOWN = "\x1b[?1049h\x1b[?1000h";
/// The suffix the server sends after a replay that lost bytes while its
/// program is on the alternate screen: CAN, the switch that keeps the
/// screen's contents, and every tracked input mode the program has off.
const LOST_ALT_SUFFIX =
  "\x18\x1b[?1047h\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l" +
  "\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetTerminals();
});

function session(seq: number, missed: number, replay: number) {
  return {
    type: "session",
    id: SESSION,
    seq,
    generation: GENERATION,
    missed_bytes: missed,
    replay_bytes: replay,
    ack_window: ACK_WINDOW,
    bytes_since_focus: 0,
  };
}

/// A tab whose program put it on the alternate screen with mouse tracking.
async function viewOnTheAlternateScreen() {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, session(ATTACHED_AT, 0, 0));
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, SHOWN);
  expect(ghosttyAlternateScreen(term), "fixture: the program's alternate screen").toBe(true);
  expect(ghosttyMode(term, 1000), "fixture: the program's mouse tracking").toBe(true);
  return { term, socket };
}

/// The socket ends with no exit before it, as a stall close or a network
/// drop leaves it, and the tab redials after its backoff.
async function redialed(socket: TerminalSocket) {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  const dial = new URL(next.url, "http://localhost").searchParams;
  expect(
    [dial.get("session"), dial.get("since"), dial.get("generation"), dial.get("ack")],
    "the redial echoes the view's cursor and generation",
  ).toEqual([SESSION, String(ATTACHED_AT + SHOWN.length), String(GENERATION), "1"]);
  next.onopen?.();
  return next;
}

function acks(socket: TerminalSocket) {
  return sentFrames(socket).filter((frame) => frame.type === "ack");
}

describe("a redial of the live session on the alternate screen", () => {
  test("a lossless delta continues the screen and drops the mode its program turned off", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    // A delta larger than the window: what the program drew while the
    // socket was down, in place of the empty replay an attach gets.
    const delta = "\x1b[?1000l" + "z".repeat(2 * ACK_WINDOW) + "\x1b[1;1Hdrawn while away";
    const cursor = ATTACHED_AT + SHOWN.length;
    await receive(next, session(cursor + delta.length, 0, delta.length));
    for (let at = 0; at < delta.length; at += 1024) await output(next, delta.slice(at, at + 1024));
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(ghosttyAlternateScreen(term), "the view stays on the program's alternate screen").toBe(true);
    expect(ghosttyMode(term, 1000), "no mouse tracking the program turned off").toBe(false);
    expect(ghosttyMouseTracking(term)).toBe(false);
    expect(ghosttyLineText(term, 0), "the delta drew over the screen the view kept").toContain("drawn while away");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the delta's bytes are the stream's").toEqual({
      type: "ack", generation: GENERATION, seq: cursor + delta.length,
    });
  });

  test("a lossy replay and its suffix drop the mode whose reset was lost", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    const lost = "\x1b[?1000l".length;
    const ring = "y".repeat(ACK_WINDOW);
    const end = ATTACHED_AT + SHOWN.length + lost + ring.length;
    await receive(next, session(end, lost, ring.length));
    await output(next, ring);
    await output(next, LOST_ALT_SUFFIX);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(ghosttyAlternateScreen(term), "the view stays on the program's alternate screen").toBe(true);
    expect(ghosttyMode(term, 1000), "no mouse tracking whose reset was lost").toBe(false);
    expect(ghosttyMouseTracking(term)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the suffix is not a stream byte").toEqual({
      type: "ack", generation: GENERATION, seq: end,
    });
  });
});
