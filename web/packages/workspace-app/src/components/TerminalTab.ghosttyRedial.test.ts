// @vitest-environment jsdom
//
// A redial of the live session on the alternate screen, through the real
// widget and vendored core, over a stand-in socket that answers as the
// server does: the redial echoes the view's cursor and generation, and its
// replay continues the view's screen as a live recovery does, the raw delta
// and, when bytes were lost, the recovery suffix for the program's screen.
// The core keeps the view's alternate screen while the program is on it, or
// leaves it when the program did, with none of the modes the program turned
// off while the socket was down.

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
const KEPT = "the screen the view kept";
const SHOWN = `\x1b[?1049h\x1b[?1000h\x1b[1;1H${KEPT}`;
/// The suffix the server sends after a replay that lost bytes while its
/// program is on the alternate screen: CAN, the switch that keeps the
/// screen's contents, and every tracked input mode the program has off.
const LOST_ALT_SUFFIX =
  "\x18\x1b[?1047h\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l" +
  "\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";
/// The suffix after a replay that lost bytes while its program is on the
/// normal screen: CAN, the cursor save, the switch off every alternate
/// screen, and every tracked input mode off.
const LOST_PLAIN_SUFFIX =
  "\x18\x1b7\x1b[?1049;1047;47l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l" +
  "\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";
/// How long the stand-in waits for an acknowledgement before it looks again,
/// and how many times it looks before it gives up on the view.
const CREDIT_STEP_MS = 50;
const CREDIT_LOOKS = 40;

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
  expect(ghosttyLineText(term, 0), "fixture: the program drew on its alternate screen").toContain(KEPT);
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

/// Send `bytes`, which start at stream position `start`, as the server sends
/// a replay: never past the window the view's acknowledgements leave open.
/// Returns how many sends the credit limited.
async function sendWithinCredit(socket: TerminalSocket, start: number, bytes: string) {
  let sent = 0;
  let sends = 0;
  let looks = 0;
  while (sent < bytes.length) {
    const acked = Number(acks(socket).at(-1)?.seq ?? start) - start;
    const credit = ACK_WINDOW - (sent - acked);
    if (credit <= 0) {
      looks += 1;
      expect(looks, "the view acknowledges the replay while it runs").toBeLessThan(CREDIT_LOOKS);
      await vi.advanceTimersByTimeAsync(CREDIT_STEP_MS);
      continue;
    }
    looks = 0;
    const chunk = bytes.slice(sent, sent + credit);
    await output(socket, chunk);
    sent += chunk.length;
    sends += 1;
  }
  return sends;
}

describe("a redial of the live session on the alternate screen", () => {
  test("a lossless delta larger than the window continues the screen and drops the mode its program turned off", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    // A delta larger than the window: what the program drew while the
    // socket was down, in place of the empty replay an attach gets, sent
    // only as the view's acknowledgements open the window.
    const delta = "\x1b[?1000l" + "z".repeat(2 * ACK_WINDOW) + "\x1b[1;1Hdrawn while away";
    const cursor = ATTACHED_AT + SHOWN.length;
    await receive(next, session(cursor + delta.length, 0, delta.length));
    const sends = await sendWithinCredit(next, cursor, delta);
    expect(sends, "fixture: the delta waited for credit past the window").toBeGreaterThan(1);
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

  test("a lossy replay and its suffix continue the screen and drop the mode whose reset was lost", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    const lost = "\x1b[?1000l".length;
    // The program redraws one row of its alternate screen, so the rows the
    // view kept stay in place.
    const ring = "\x1b[12;1Hredrawn ".repeat(Math.floor(ACK_WINDOW / 16));
    const end = ATTACHED_AT + SHOWN.length + lost + ring.length;
    await receive(next, session(end, lost, ring.length));
    await output(next, ring);
    await output(next, LOST_ALT_SUFFIX);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(ghosttyAlternateScreen(term), "the view stays on the program's alternate screen").toBe(true);
    expect(ghosttyMode(term, 1000), "no mouse tracking whose reset was lost").toBe(false);
    expect(ghosttyMouseTracking(term)).toBe(false);
    expect(ghosttyLineText(term, 0), "the replay continued the screen the view kept").toContain(KEPT);
    expect(ghosttyLineText(term, 11), "the replay drew on that screen").toContain("redrawn");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the suffix is not a stream byte").toEqual({
      type: "ack", generation: GENERATION, seq: end,
    });
  });

  test("a lossy replay after its program left the alternate screen takes the view off it", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    // The program left its alternate screen and turned mouse tracking off
    // while the socket was down, and the ring moved past both.
    const lost = "\x1b[?1049l\x1b[?1000l".length;
    const ring = "$ shell\r\n".repeat(64);
    const end = ATTACHED_AT + SHOWN.length + lost + ring.length;
    await receive(next, session(end, lost, ring.length));
    await output(next, ring);
    await output(next, LOST_PLAIN_SUFFIX);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(
      { alternate: ghosttyAlternateScreen(term), mode1000: ghosttyMode(term, 1000), tracking: ghosttyMouseTracking(term) },
      "no alternate screen and no mouse tracking from the dead program",
    ).toEqual({ alternate: false, mode1000: false, tracking: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the suffix is not a stream byte").toEqual({
      type: "ack", generation: GENERATION, seq: end,
    });
  });
});
