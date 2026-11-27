// @vitest-environment jsdom
//
// A redial of the live session on the alternate screen, through the real
// widget and vendored core, over a stand-in socket that answers as the
// server does: the redial echoes the view's cursor and generation, and its
// replay continues the view's screen as a live recovery does, the raw delta
// and, when bytes were lost, the recovery suffix for the program's screen.
// The core keeps the view's alternate screen while the program is on it, or
// leaves it when the program did, with none of the modes the program turned
// off while the socket was down. A socket that ends inside such a replay
// leaves the view part way through it, and the redial after it resumes from
// there.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  pressInGhostty,
} from "../__tests__/ghosttyTab";
import {
  installTerminalDom,
  openTerminalMenu,
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
/// What a dial that resumes no view gets while its program is on the
/// alternate screen, ahead of the modes it has on.
const ALT_SCREEN_ATTACH_PRELUDE = "\x1b[?1049h\x1b[2J\x1b[H";
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

/// A session frame of the live session; `screen` is the replay's start
/// screen, which the server names when the attach reconciles a loss.
function session(seq: number, missed: number, replay: number, screen?: "normal" | "alternate") {
  return {
    type: "session",
    id: SESSION,
    seq,
    generation: GENERATION,
    missed_bytes: missed,
    replay_bytes: replay,
    ack_window: ACK_WINDOW,
    bytes_since_focus: 0,
    ...(screen === undefined ? {} : { replay_screen: screen }),
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
async function redialed(socket: TerminalSocket, cursor = ATTACHED_AT + SHOWN.length) {
  const next = await closedAndRedialed(socket);
  expect(dialed(next), "the redial echoes the view's cursor and generation").toEqual({
    session: SESSION, since: String(cursor), generation: String(GENERATION), ack: "1",
  });
  next.onopen?.();
  return next;
}

async function closedAndRedialed(socket: TerminalSocket) {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  return TerminalSocket.all.at(-1)!;
}

function dialed(socket: TerminalSocket) {
  const dial = new URL(socket.url, "http://localhost").searchParams;
  return { session: dial.get("session"), since: dial.get("since"), generation: dial.get("generation"), ack: dial.get("ack") };
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
    await receive(next, session(end, lost, ring.length, "alternate"));
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
    await receive(next, session(end, lost, ring.length, "normal"));
    await output(next, ring);
    await output(next, LOST_PLAIN_SUFFIX);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(
      { alternate: ghosttyAlternateScreen(term), mode1000: ghosttyMode(term, 1000), tracking: ghosttyMouseTracking(term) },
      "no alternate screen and no mouse tracking from the dead program",
    ).toEqual({ alternate: false, mode1000: false, tracking: false });
    const normal = term.buffer.normal;
    const rows = Array.from({ length: normal.length }, (_, i) => normal.getLine(i)?.translateToString(true) ?? "");
    expect(rows.filter((row) => row === "$ shell"), "every ring line on the normal screen").toHaveLength(64);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the suffix is not a stream byte").toEqual({
      type: "ack", generation: GENERATION, seq: end,
    });
  });
});

/// The cursor a redial of the alternate-screen fixture echoes.
const VIEW_AT = ATTACHED_AT + SHOWN.length;
/// A program redrawing one row of its alternate screen, a window's quarter.
const REDRAWN = "\x1b[12;1Hredrawn ".repeat(ACK_WINDOW / 64);
const MOUSE_OFF = "\x1b[?1000l";
const AFTER_RESET = "\x1b[13;1Hafter the reset";

/// What a program wrote after the view's cursor `at`, and what the server
/// holds of it: its ring starts at `ringStart`, past `at` once bytes were
/// lost. The program ends with every tracked mode off, on its alternate
/// screen or not, the screen it had at the ring's start too.
type Program = { at: number; written: string; ringStart: number; alternate: boolean };
type Answer = { frame: ReturnType<typeof session>; replay: string; after: string };

/// What the server sends the dial `socket` made (`get_or_create_for_ws`,
/// `attach_resuming_with_progress` and `send_attach_prelude`), the rule the
/// tab's session frame reads again to know whether a replay continues its
/// view, so the two change together: a non-zero
/// cursor the live generation proves gets the stream from that cursor, from
/// the ring's start when the ring has moved past it with the recovery suffix
/// after and the replay's start screen in the session frame; any other dial
/// gets the whole ring on the normal screen, or no replay and the attach
/// prelude on the alternate one, and no mode, since none is on.
function served(socket: TerminalSocket, program: Program): Answer {
  expect(program.ringStart, "fixture: the stand-in's ring starts at or past the view").toBeGreaterThanOrEqual(program.at);
  const { since, generation } = dialed(socket);
  const end = program.at + program.written.length;
  const from = (position: number) => program.written.slice(position - program.at);
  const cursor = Number(since);
  if (generation === String(GENERATION) && cursor > 0) {
    const start = Math.max(cursor, program.ringStart);
    const missed = Math.max(0, program.ringStart - cursor);
    const suffix = missed === 0 ? "" : program.alternate ? LOST_ALT_SUFFIX : LOST_PLAIN_SUFFIX;
    const screen = missed === 0 ? undefined : program.alternate ? "alternate" : "normal";
    return { frame: session(end, missed, end - start, screen), replay: from(start), after: suffix };
  }
  if (program.alternate) return { frame: session(end, 0, 0), replay: "", after: ALT_SCREEN_ATTACH_PRELUDE };
  const ring = from(program.ringStart);
  return { frame: session(end, program.ringStart, ring.length), replay: ring, after: "" };
}

/// Send `answer` on `socket`: the session frame, the replay in frames of a
/// quarter window, what follows the replay, and `ready`. With `cutAfter` the
/// socket stops once that many replay bytes are out, inside its replay.
async function deliver(socket: TerminalSocket, answer: Answer, cutAfter?: number) {
  await receive(socket, answer.frame);
  const sent = cutAfter ?? answer.replay.length;
  for (let at = 0; at < sent; at += ACK_WINDOW / 4) {
    await output(socket, answer.replay.slice(at, Math.min(sent, at + ACK_WINDOW / 4)));
  }
  if (cutAfter !== undefined) return;
  if (answer.after) await output(socket, answer.after);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
}

/// The socket ends inside its replay, and the tab dials again.
async function redialedAfterCut(socket: TerminalSocket) {
  const next = await closedAndRedialed(socket);
  next.onopen?.();
  return next;
}

function screen(term: Parameters<typeof ghosttyMode>[0]) {
  return {
    alternate: ghosttyAlternateScreen(term),
    mode1000: ghosttyMode(term, 1000),
    tracking: ghosttyMouseTracking(term),
  };
}

/// A tab on the normal screen whose shell turned bracketed paste on.
async function viewOnTheNormalScreen() {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, session(ATTACHED_AT, 0, 0));
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, "\x1b[?2004h$ ");
  expect(ghosttyAlternateScreen(term), "fixture: the normal screen").toBe(false);
  expect(ghosttyMode(term, 2004), "fixture: the shell's bracketed paste").toBe(true);
  return { tab: tab!, term, socket, cursor: ATTACHED_AT + "\x1b[?2004h$ ".length };
}

/// Open the tab menu and return the status row's `.session-note` labels.
async function sessionNotes(tab: ReturnType<typeof terminalTab>) {
  await openTerminalMenu(tab);
  const row = document.body.querySelector(".terminal-status-row");
  expect(row, "fixture: the tab menu's status row rendered").not.toBeNull();
  return [...row!.querySelectorAll(".session-note")].map((el) => (el.textContent ?? "").trim());
}

describe("a redial after a socket ended inside a replay that continued the view", () => {
  test("resumes from the byte the view parsed, inside a sequence, so the rest drops the mode", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    const program = { at: VIEW_AT, written: REDRAWN + MOUSE_OFF + AFTER_RESET, ringStart: VIEW_AT, alternate: true };
    // The socket ends part way through the mouse reset.
    const cut = REDRAWN.length + "\x1b[?10".length;
    await deliver(second, served(second, program), cut);
    expect(ghosttyMode(term, 1000), "fixture: the reset was not parsed").toBe(true);
    const third = await redialedAfterCut(second);
    await deliver(third, served(third, program));
    expect(screen(term), "the program's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
    expect(ghosttyLineText(term, 0), "no attach prelude cleared the screen the view kept").toContain(KEPT);
    expect(ghosttyLineText(term, 12), "the rest of the replay drew on it").toContain("after the reset");
    expect(dialed(third), "the redial echoes the position the view parsed and the generation").toEqual({
      session: SESSION, since: String(VIEW_AT + cut), generation: String(GENERATION), ack: "1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: VIEW_AT + program.written.length });
  });

  test("whose rest the ring dropped gets the recovery suffix", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    const written = REDRAWN + MOUSE_OFF + AFTER_RESET;
    const cut = REDRAWN.length / 2;
    await deliver(second, served(second, { at: VIEW_AT, written, ringStart: VIEW_AT, alternate: true }), cut);
    // While the tab redials, the ring moves past the mouse reset.
    const program = { at: VIEW_AT, written, ringStart: VIEW_AT + REDRAWN.length + MOUSE_OFF.length, alternate: true };
    const third = await redialedAfterCut(second);
    const answer = served(third, program);
    await deliver(third, answer);
    expect(screen(term), "the program's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
    expect(ghosttyLineText(term, 0), "no attach prelude cleared the screen the view kept").toContain(KEPT);
    expect(ghosttyLineText(term, 12), "the ring drew on it").toContain("after the reset");
    expect(dialed(third), "the redial echoes the position the view parsed and the generation").toEqual({
      session: SESSION, since: String(VIEW_AT + cut), generation: String(GENERATION), ack: "1",
    });
    expect(answer.frame.missed_bytes, "fixture: the bytes after the cut were lost").toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: VIEW_AT + written.length });
  });

  test("that missed bytes and ended before its suffix asks for them again, so the suffix comes", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    // The ring moved past the mouse reset while the socket was down.
    const ring = REDRAWN + "\x1b[13;1Hring end";
    const program = { at: VIEW_AT, written: MOUSE_OFF + ring, ringStart: VIEW_AT + MOUSE_OFF.length, alternate: true };
    const lossy = served(second, program);
    expect(lossy.frame.missed_bytes, "fixture: the reset was lost").toBe(MOUSE_OFF.length);
    await deliver(second, lossy, REDRAWN.length / 2);
    expect(ghosttyMode(term, 1000), "fixture: the suffix was not parsed").toBe(true);
    const third = await redialedAfterCut(second);
    await deliver(third, served(third, program));
    expect(screen(term), "the program's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
    expect(ghosttyLineText(term, 0), "no attach prelude cleared the screen the view kept").toContain(KEPT);
    expect(ghosttyLineText(term, 12), "the ring drew on it").toContain("ring end");
    expect(dialed(third), "the redial echoes the cursor the lost bytes start at").toEqual({
      session: SESSION, since: String(VIEW_AT), generation: String(GENERATION), ack: "1",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: VIEW_AT + program.written.length });
  });

  test("that missed bytes writes no line and no notice of them twice on the normal screen", async () => {
    const { tab, term, socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    const pasteOff = "\x1b[?2004l";
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\r\n`).join("");
    const program = { at: cursor, written: pasteOff + lines, ringStart: cursor + pasteOff.length, alternate: false };
    await deliver(second, served(second, program), lines.indexOf("line 21"));
    expect(ghosttyMode(term, 2004), "fixture: the suffix was not parsed").toBe(true);
    const third = await redialedAfterCut(second);
    await deliver(third, served(third, program));
    const buffer = term.buffer.normal;
    const rows = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
    const counts = Array.from({ length: 40 }, (_, i) => rows.filter((row) => row === `line ${i + 1}`).length);
    expect(counts, "every ring line once").toEqual(Array(40).fill(1));
    expect(rows.filter((row) => row.includes("terminal replay missed")), "one notice of the loss").toHaveLength(1);
    expect(ghosttyMode(term, 2004), "no bracketed paste whose reset was lost").toBe(false);
    expect(dialed(third).since, "the redial echoes the cursor the lost bytes start at").toBe(String(cursor));
    expect(await sessionNotes(tab), "the status note stays hidden when nothing new was missed").toEqual([]);
  });

  test("that missed bytes and is cut again among the bytes the view parsed keeps its position and the loss", async () => {
    const { term, socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    const pasteOff = "\x1b[?2004l";
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\r\n`).join("");
    const program = { at: cursor, written: pasteOff + lines, ringStart: cursor + pasteOff.length, alternate: false };
    await deliver(second, served(second, program), lines.indexOf("line 21"));
    const third = await redialedAfterCut(second);
    // This replay repeats the lines the view parsed, and its socket ends
    // among them.
    await deliver(third, served(third, program), lines.indexOf("line 11"));
    const fourth = await redialedAfterCut(third);
    await deliver(fourth, served(fourth, program));
    const buffer = term.buffer.normal;
    const rows = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
    const counts = Array.from({ length: 40 }, (_, i) => rows.filter((row) => row === `line ${i + 1}`).length);
    expect(counts, "every ring line once").toEqual(Array(40).fill(1));
    expect(rows.filter((row) => row.includes("terminal replay missed")), "one notice of the loss").toHaveLength(1);
    expect(ghosttyMode(term, 2004), "no bracketed paste whose reset was lost").toBe(false);
    expect(dialed(fourth).since, "the redial still echoes the cursor the lost bytes start at").toBe(String(cursor));
  });

  test("that missed bytes and is cut inside a sequence, then re-asked after the ring moved past the view, notices the new gap", async () => {
    const { tab, term, socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    const pasteOff = "\x1b[?2004l";
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\x1b[1m!\x1b[0m\r\n`).join("");
    const program = { at: cursor, written: pasteOff + lines, ringStart: cursor + pasteOff.length, alternate: false };
    // The socket ends inside line 21's bold sequence.
    const cut = lines.indexOf("line 21") + "line 21\x1b[".length;
    await deliver(second, served(second, program), cut);
    const third = await redialedAfterCut(second);
    expect(dialed(third).since, "the redial echoes the cursor the lost bytes start at").toBe(String(cursor));
    // While the tab redials, the ring moves past line 30.
    const moved = { ...program, ringStart: program.ringStart + lines.indexOf("line 31") };
    await deliver(third, served(third, moved));
    const buffer = term.buffer.normal;
    const rows = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
    const counts = Array.from({ length: 40 }, (_, i) => rows.filter((row) => row === `line ${i + 1}!`).length);
    expect(Math.max(...counts), "no line twice").toBeLessThanOrEqual(1);
    expect(counts.slice(30), "lines 31 to 40 whole, once, none run into the sequence the cut split").toEqual(Array(10).fill(1));
    expect(rows.filter((row) => row.includes("terminal replay missed")), "a notice for each gap, of the bytes it lost").toEqual([
      `terminal replay missed ${pasteOff.length} bytes`,
      `terminal replay missed ${lines.indexOf("line 31") - cut} bytes`,
    ]);
    expect(ghosttyMode(term, 2004), "no bracketed paste whose reset was lost").toBe(false);
    expect(await sessionNotes(tab), "the status note counts only the new gap").toEqual([
      `missed ${lines.indexOf("line 31") - cut} bytes`,
    ]);
  });

  test.each([
    { offset: -1, notices: 1, line21: 1 },
    { offset: 0, notices: 1, line21: 1 },
    { offset: 1, notices: 2, line21: 0 },
  ])(
    "that missed bytes, re-asked with the ring at the parsed position $offset, skips only repeated bytes and counts only a new gap",
    async ({ offset, notices, line21 }) => {
      const { tab, term, socket, cursor } = await viewOnTheNormalScreen();
      const second = await redialed(socket, cursor);
      const pasteOff = "\x1b[?2004l";
      const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\r\n`).join("");
      const program = { at: cursor, written: pasteOff + lines, ringStart: cursor + pasteOff.length, alternate: false };
      // The view parses "line 2" of line 21; its next byte is "1".
      const cut = lines.indexOf("line 21") + "line 2".length;
      const parsed = program.ringStart + cut;
      await deliver(second, served(second, program), cut);
      const third = await redialedAfterCut(second);
      expect(dialed(third).since, "the redial echoes the cursor the lost bytes start at").toBe(String(cursor));
      const moved = { ...program, ringStart: parsed + offset };
      const answer = served(third, moved);
      expect(answer.frame.missed_bytes, "fixture: the server counts from the echoed cursor").toBe(parsed + offset - cursor);
      await deliver(third, answer);
      const buffer = term.buffer.normal;
      const rows = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
      expect(
        rows.filter((row) => row.includes("terminal replay missed")),
        "one notice unless the ring passed the parsed byte",
      ).toEqual(
        notices === 1
          ? [`terminal replay missed ${pasteOff.length} bytes`]
          : [`terminal replay missed ${pasteOff.length} bytes`, `terminal replay missed ${offset} bytes`],
      );
      const counts = Array.from({ length: 40 }, (_, i) => rows.filter((row) => row === `line ${i + 1}`).length);
      const expected = Array(40).fill(1);
      expected[20] = line21;
      // With line 21's last byte lost, the "line 2" the view parsed of it is
      // a second "line 2" row.
      if (line21 === 0) expected[1] = 2;
      expect(counts, "every line once, line 21 whole unless its last byte was lost").toEqual(expected);
      expect(ghosttyMode(term, 2004), "no bracketed paste whose reset was lost").toBe(false);
      expect(await sessionNotes(tab), "the status note follows only the new gap").toEqual(
        notices === 1 ? [] : [`missed ${offset} bytes`],
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: cursor + program.written.length });
    },
  );

  test("that missed bytes and ended after its suffix resumes from the replay's end", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    const ring = REDRAWN + "\x1b[13;1Hring end";
    const program = { at: VIEW_AT, written: MOUSE_OFF + ring, ringStart: VIEW_AT + MOUSE_OFF.length, alternate: true };
    const lossy = served(second, program);
    // Every replay byte and the suffix arrive; the socket ends before `ready`.
    await deliver(second, lossy, ring.length);
    await output(second, lossy.after);
    expect(ghosttyMode(term, 1000), "fixture: the suffix was parsed").toBe(false);
    const third = await redialedAfterCut(second);
    expect(dialed(third).since, "the redial echoes the replay's end, since the loss is answered").toBe(
      String(VIEW_AT + program.written.length),
    );
    await deliver(third, served(third, program));
    expect(screen(term), "the program's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
    expect(ghosttyLineText(term, 0), "no attach prelude cleared the screen the view kept").toContain(KEPT);
  });

  test("of a recovery on the live socket resumes from the byte the view parsed", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const program = { at: VIEW_AT, written: REDRAWN + MOUSE_OFF + AFTER_RESET, ringStart: VIEW_AT, alternate: true };
    // The server recovers the socket's stream: a session frame of the same
    // session and generation, and the raw delta from the socket's cursor.
    const recovery = {
      frame: session(VIEW_AT + program.written.length, 0, program.written.length), replay: program.written, after: "",
    };
    const cut = REDRAWN.length + "\x1b[?10".length;
    await deliver(socket, recovery, cut);
    expect(ghosttyMode(term, 1000), "fixture: the reset was not parsed").toBe(true);
    const next = await redialedAfterCut(socket);
    await deliver(next, served(next, program));
    expect(screen(term), "the program's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
    expect(ghosttyLineText(term, 0), "no attach prelude cleared the screen the view kept").toContain(KEPT);
    expect(ghosttyLineText(term, 12), "the rest of the delta drew on it").toContain("after the reset");
    expect(dialed(next).since, "the redial echoes the position the view parsed").toBe(String(VIEW_AT + cut));
  });
});

describe("a redial whose answer does not continue the view", () => {
  /// Twenty rows of a program the view never saw.
  const NEW_ROWS = Array.from({ length: 20 }, (_, i) => `new ${i + 1}\r\n`).join("");

  function normalRows(term: Parameters<typeof ghosttyMode>[0]) {
    const buffer = term.buffer.normal;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
  }

  function newRowsShown(term: Parameters<typeof ghosttyMode>[0]) {
    const rows = normalRows(term);
    return Array.from({ length: 20 }, (_, i) => rows.filter((row) => row === `new ${i + 1}`).length);
  }

  test("across a restart writes the new generation's whole replay", async () => {
    const { term, socket, cursor } = await viewOnTheNormalScreen();
    const next = await redialed(socket, cursor);
    // The session restarted while the socket was down: the reset ahead of
    // the new life's session frame, then its whole ring.
    await output(next, "\x1bc");
    await receive(next, { ...session(NEW_ROWS.length, 0, NEW_ROWS.length), generation: GENERATION + 1 });
    await output(next, NEW_ROWS);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(newRowsShown(term), "every row of the new life once").toEqual(Array(20).fill(1));
  });

  test("across a restart, after a cut replay that continued the view, keeps none of the old life's keyboard protocol", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const initial = JSON.parse(JSON.stringify(tab!.keyboardProtocol));
    const first = TerminalSocket.all.at(-1)!;
    first.onopen?.();
    await receive(first, session(ATTACHED_AT, 0, 0));
    await receive(first, { type: "ready", cols: 80, rows: 24 });
    // The program asks for modifyOtherKeys and kitty keyboard flags.
    const negotiated = "\x1b[>4;2m\x1b[>5u";
    await output(first, negotiated);
    expect(JSON.parse(JSON.stringify(tab!.keyboardProtocol)), "fixture: the program's keyboard protocol").not.toEqual(initial);
    const second = await redialed(first, ATTACHED_AT + negotiated.length);
    const delta = "more output, cut part way";
    await receive(second, session(ATTACHED_AT + negotiated.length + delta.length, 0, delta.length));
    await output(second, delta.slice(0, 10));
    const third = await redialedAfterCut(second);
    expect(dialed(third), "fixture: the redial resumes from the cut").toMatchObject({
      since: String(ATTACHED_AT + negotiated.length + 10), generation: String(GENERATION),
    });
    // The session restarted in place while the tab redialed: the reset
    // ahead of the new life's session frame, its prompt, then ready.
    await output(third, "\x1bc");
    await receive(third, { ...session(2, 0, 2), generation: GENERATION + 1 });
    await output(third, "$ ");
    await receive(third, { type: "ready", cols: 80, rows: 24 });
    expect(JSON.parse(JSON.stringify(tab!.keyboardProtocol)), "the new life's keyboard protocol").toEqual(initial);
    pressInGhostty(term, { key: "Enter", code: "Enter", shiftKey: true });
    expect(sentFrames(third).filter((frame) => frame.type === "input").map((frame) => frame.data), "no modifyOtherKeys Enter")
      .not.toContain("\x1b[27;2;13~");
  });

  test("answered by another session writes that session's whole replay", async () => {
    const { term, socket, cursor } = await viewOnTheNormalScreen();
    const next = await redialed(socket, cursor);
    await receive(next, { ...session(NEW_ROWS.length, 0, NEW_ROWS.length), id: "sess-replacement" });
    await output(next, NEW_ROWS);
    await receive(next, { type: "ready", cols: 80, rows: 24 });
    expect(newRowsShown(term), "every row of the new session once").toEqual(Array(20).fill(1));
  });

  test.each([
    { name: "drops a mode the program turned off", reasserted: "", mode1000: false },
    { name: "keeps a mode the program still has on", reasserted: "\x1b[?1000h", mode1000: true },
  ])("of a fresh view, cut after its alternate-screen reassert, $name before the redial", async ({ reasserted, mode1000 }) => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    first.onopen?.();
    expect(dialed(first), "fixture: a fresh dial").toMatchObject({ since: "0", generation: null });
    await receive(first, session(500, 0, 0));
    await output(first, ALT_SCREEN_ATTACH_PRELUDE + "\x1b[?1000h");
    expect(ghosttyMode(term, 1000), "fixture: the reassert turned mouse tracking on").toBe(true);
    // The socket ends after the reassert, before `ready`, and the tab dials
    // again while the program decides its mouse tracking.
    const second = await redialedAfterCut(first);
    expect(dialed(second), "the redial is fresh").toMatchObject({ since: "0", generation: null });
    await receive(second, session(520, 0, 0));
    await output(second, ALT_SCREEN_ATTACH_PRELUDE + reasserted);
    await receive(second, { type: "ready", cols: 80, rows: 24 });
    expect(screen(term), "the program's alternate screen with its mouse tracking").toEqual({
      alternate: true, mode1000, tracking: mode1000,
    });
  });

  test("across a restart, cut after the new life's alternate-screen reassert, drops a mode it turned off before the redial", async () => {
    const { term, socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    await output(second, "\x1bc");
    await receive(second, { ...session(300, 0, 0), generation: GENERATION + 1 });
    await output(second, ALT_SCREEN_ATTACH_PRELUDE + "\x1b[?1000h");
    expect(ghosttyMode(term, 1000), "fixture: the new life's mouse tracking").toBe(true);
    const third = await redialedAfterCut(second);
    expect(dialed(third), "the redial is fresh").toMatchObject({ since: "0", generation: null });
    await receive(third, { ...session(320, 0, 0), generation: GENERATION + 1 });
    await output(third, ALT_SCREEN_ATTACH_PRELUDE);
    await receive(third, { type: "ready", cols: 80, rows: 24 });
    expect(screen(term), "the new life's alternate screen with no mouse tracking").toEqual({
      alternate: true, mode1000: false, tracking: false,
    });
  });

  test("from cursor 0 is cut before its prelude and dials again for the whole screen", async () => {
    // The view attached before its program wrote anything.
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    socket.onopen?.();
    await receive(socket, session(0, 0, 0));
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    const second = await redialed(socket, 0);
    // The program entered its alternate screen while the socket was down.
    const program = { at: 0, written: "\x1b[?1049h\x1b[1;1Hdrawn", ringStart: 0, alternate: true };
    await deliver(second, served(second, program), 0);
    const third = await redialedAfterCut(second);
    await deliver(third, served(third, program));
    expect(ghosttyAlternateScreen(term), "the attach prelude put the view on the program's screen").toBe(true);
    expect(dialed(third), "the redial asks for the whole screen").toEqual({
      session: SESSION, since: "0", generation: null, ack: "1",
    });
  });

  test("a fresh answer that reached ready clears the cut, so a clean close redials from the cursor", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const first = TerminalSocket.all.at(-1)!;
    first.onopen?.();
    expect(dialed(first), "fixture: a fresh dial").toMatchObject({ since: "0", generation: null });
    await receive(first, session(500, 0, 0));
    await output(first, ALT_SCREEN_ATTACH_PRELUDE + "\x1b[?1000h");
    // Cut inside the fresh answer: the next dial is fresh too.
    const second = await redialedAfterCut(first);
    expect(dialed(second), "fixture: the redial after the cut is fresh").toMatchObject({ since: "0", generation: null });
    await receive(second, session(520, 0, 0));
    await output(second, ALT_SCREEN_ATTACH_PRELUDE + "\x1b[?1000h");
    await receive(second, { type: "ready", cols: 80, rows: 24 });
    const live = `\x1b[1;1H${KEPT}`;
    await output(second, live);
    expect(ghosttyAlternateScreen(term)).toBe(true);
    // A clean close after ready: the view shows the stream to 520 + live.
    const third = await closedAndRedialed(second);
    expect(dialed(third), "the redial echoes the cursor and the generation").toEqual({
      session: SESSION, since: String(520 + live.length), generation: String(GENERATION), ack: "1",
    });
    third.onopen?.();
    await receive(third, session(520 + live.length, 0, 0));
    await receive(third, { type: "ready", cols: 80, rows: 24 });
    expect(ghosttyLineText(term, 0), "the continuing answer keeps the screen").toContain(KEPT);
    expect(ghosttyMode(term, 1000), "the continuing answer keeps the program's mouse tracking").toBe(true);
  });
});

describe("bytes ahead of a dial's session frame", () => {
  /// The socket ends before its session frame, and the tab dials again
  /// after the backoff, doubled since no frame proved the session.
  async function redialedBeforeItsFrame(socket: TerminalSocket) {
    const before = TerminalSocket.all.length;
    socket.close();
    await vi.advanceTimersByTimeAsync(2 * WS_RECONNECT_BACKOFF_MIN_MS);
    expect(TerminalSocket.all).toHaveLength(before + 1);
    const next = TerminalSocket.all.at(-1)!;
    next.onopen?.();
    return next;
  }

  function normalRows(term: Parameters<typeof ghosttyMode>[0]) {
    const buffer = term.buffer.normal;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
  }

  test("are no stream bytes: a redial cut after them echoes the view's cursor, so its replay keeps every ring byte and the suffix", async () => {
    const { term, socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    // Bytes ahead of the session frame, here a normal-screen switch, and the
    // socket ends before the frame.
    const ahead = "\x18\x1b7\x1b[?1049;1047;47l";
    await output(second, ahead);
    const third = await redialedBeforeItsFrame(second);
    expect(dialed(third), "the redial echoes the view's cursor and generation").toEqual({
      session: SESSION, since: String(cursor), generation: String(GENERATION), ack: "1",
    });
    // The shell turned bracketed paste off and printed, and the ring moved
    // past the reset: a loss shorter than the bytes ahead of the frame.
    const pasteOff = "\x1b[?2004l";
    const lines = "012\r\n" + Array.from({ length: 8 }, (_, i) => `line ${i + 1}\r\n`).join("");
    const program = { at: cursor, written: pasteOff + lines, ringStart: cursor + pasteOff.length, alternate: false };
    expect(pasteOff.length, "fixture: the loss is shorter than the bytes ahead").toBeLessThan(ahead.length);
    await deliver(third, served(third, program));
    expect(ghosttyMode(term, 2004), "no bracketed paste whose reset was lost").toBe(false);
    expect(normalRows(term), "the ring's first line").toContain("012");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: cursor + program.written.length });
  });

  test("a stale generation's reset is no stream byte: a redial cut after it echoes the cursor the dial before it echoed", async () => {
    const { socket, cursor } = await viewOnTheNormalScreen();
    const second = await redialed(socket, cursor);
    // The session restarted while the socket was down: its reset comes ahead
    // of the new life's session frame, and the socket ends between the two.
    await output(second, "\x1bc");
    const third = await redialedBeforeItsFrame(second);
    expect(dialed(third), "the redial echoes the same cursor and generation").toEqual({
      session: SESSION, since: String(cursor), generation: String(GENERATION), ack: "1",
    });
  });
});

describe("a reconciling answer that names its replay's start screen", () => {
  /// What a program printed on the normal screen after it left its
  /// alternate one, the last of it the shell's prompt.
  const TAIL = Array.from({ length: 30 }, (_, i) => `filler ${i + 1}\r\n`).join("") + "probe exited\r\n$ ";
  /// The program's alternate-screen exit and its mouse reset, lost.
  const LOST_EXIT = "\x1b[?1049l\x1b[?1000l";
  const READY = { type: "ready", cols: 80, rows: 24 };

  function rows(buffer: { length: number; getLine(i: number): { translateToString(trim?: boolean): string } | undefined }) {
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
  }

  /// The view after the program's exit and tail, on its normal screen.
  function tailShown(term: Parameters<typeof ghosttyMode>[0]) {
    const normal = rows(term.buffer.normal);
    return {
      ...screen(term),
      exited: normal.includes("probe exited"),
      filler: normal.filter((row) => row.startsWith("filler ")).length,
      notices: normal.filter((row) => row.includes("terminal replay missed")).length,
    };
  }
  const TAIL_SHOWN = { alternate: false, mode1000: false, tracking: false, exited: true, filler: 30, notices: 1 };

  test("a redial past a lost alternate-screen exit shows the retained tail on the normal screen, every dead mode reset", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    const end = VIEW_AT + LOST_EXIT.length + TAIL.length;
    await deliver(next, { frame: session(end, LOST_EXIT.length, TAIL.length, "normal"), replay: TAIL, after: LOST_PLAIN_SUFFIX });
    expect(tailShown(term)).toEqual(TAIL_SHOWN);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(next).at(-1), "the switch is no stream byte").toEqual({ type: "ack", generation: GENERATION, seq: end });
  });

  test("a live socket's recovery past a lost alternate-screen exit shows the retained tail on the normal screen, every dead mode reset", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    // The server recovers the socket's stream in band: a session frame of
    // the same session and generation, the ring and the recovery suffix.
    const end = VIEW_AT + LOST_EXIT.length + TAIL.length;
    await deliver(socket, { frame: session(end, LOST_EXIT.length, TAIL.length, "normal"), replay: TAIL, after: LOST_PLAIN_SUFFIX });
    expect(tailShown(term)).toEqual(TAIL_SHOWN);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(socket).at(-1), "the switch is no stream byte").toEqual({ type: "ack", generation: GENERATION, seq: end });
    // A clean close after it: the redial echoes the stream's end.
    const next = await closedAndRedialed(socket);
    expect(dialed(next).since, "the cursor counts no switch").toBe(String(end));
  });

  test("a recovery whose loss is shorter than the switch moves neither the cursor nor the replay position", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    // The program left its alternate screen: one byte past that exit, the
    // ring's start, is all that was lost of it.
    const lost = "\x1b[?1049l".length;
    const end = VIEW_AT + lost + TAIL.length;
    await deliver(socket, { frame: session(end, lost, TAIL.length, "normal"), replay: TAIL, after: LOST_PLAIN_SUFFIX });
    expect(rows(term.buffer.normal), "the ring's first line").toContain("filler 1");
    const next = await closedAndRedialed(socket);
    expect(dialed(next).since, "the cursor counts no switch").toBe(String(end));
  });

  test.each([
    {
      name: "leaves the alternate screen and later enters another",
      view: viewOnTheAlternateScreen,
      start: "normal" as const,
      // The shell's lines on the normal screen, then a second program's
      // frame on its own alternate screen.
      replay: "between\r\n$ tui2\r\n\x1b[?1049h\x1b[5;1Hframe two",
      after: LOST_ALT_SUFFIX,
      normal: ["between", "$ tui2"],
      alternate: "frame two",
      ends: true,
    },
    {
      name: "enters the alternate screen and later leaves it",
      view: viewOnTheNormalScreen,
      start: "alternate" as const,
      // A program's frame on its alternate screen, its exit, and the shell.
      replay: "\x1b[5;1Hframe one\x1b[?1049l\r\nback\r\n$ ",
      after: LOST_PLAIN_SUFFIX,
      normal: ["back"],
      alternate: null,
      ends: false,
    },
  ])("a redial whose replay $name draws each part on its own screen", async ({ view, start, replay, after, normal, alternate, ends }) => {
    const opened = await view();
    const { term, socket } = opened;
    const cursor = "cursor" in opened && typeof opened.cursor === "number" ? opened.cursor : VIEW_AT;
    const next = await redialed(socket, cursor);
    const lost = 8;
    const end = cursor + lost + replay.length;
    await deliver(next, { frame: session(end, lost, replay.length, start), replay, after });
    expect(ghosttyAlternateScreen(term), "the screen the program ends on").toBe(ends);
    expect(ghosttyMode(term, 1000), "no mouse tracking from the dead program").toBe(false);
    if (alternate) expect(ghosttyLineText(term, 4), "the frame on the alternate screen").toContain(alternate);
    // The normal screen's rows read the screen shown, so a program still on
    // its alternate screen leaves it first.
    if (ends) await output(next, "\x1b[?1049l");
    const normalRows = rows(term.buffer.normal);
    for (const line of normal) expect(normalRows, "the normal screen's part").toContain(line);
    expect(normalRows.some((row) => row.includes("frame")), "no frame on the normal screen").toBe(false);
  });

  test("a re-ask after a cut inside a sequence, past a switch in its replay, writes no switch and no literal text", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    const replay = "between\r\n$ tui2\r\n\x1b[?1049h\x1b[5;1H\x1b[1mframe\x1b[0m two";
    const end = VIEW_AT + LOST_EXIT.length + replay.length;
    const answer = { frame: session(end, LOST_EXIT.length, replay.length, "normal"), replay, after: LOST_ALT_SUFFIX };
    // The socket ends inside the frame's bold sequence, on the alternate
    // screen the replay entered.
    const cut = replay.indexOf("\x1b[1m") + "\x1b[".length;
    await deliver(second, answer, cut);
    expect(ghosttyAlternateScreen(term), "fixture: the view is on the replay's alternate screen").toBe(true);
    const third = await redialedAfterCut(second);
    expect(dialed(third).since, "fixture: a re-ask from the loss").toBe(String(VIEW_AT));
    // The ring has not moved: the replay repeats every byte the view parsed.
    await deliver(third, answer);
    expect(ghosttyAlternateScreen(term), "the program's alternate screen").toBe(true);
    expect(ghosttyLineText(term, 4), "the frame on it").toContain("frame two");
    const alternate = rows(term.buffer.alternate);
    // The program leaves its alternate screen, so the normal screen's rows
    // read that screen.
    await output(third, "\x1b[?1049l");
    const normal = rows(term.buffer.normal);
    expect([...alternate, ...normal].filter((row) => row.includes("1mframe")), "no sequence printed as text").toEqual([]);
    expect(normal.filter((row) => row === "between"), "the normal screen's line once").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acks(third).at(-1)).toEqual({ type: "ack", generation: GENERATION, seq: end + "\x1b[?1049l".length });
  });

  test("an answer after a cut whose replay starts on a reset screen switches after the reset", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const second = await redialed(socket);
    // A replay that continued the view, cut part way.
    await deliver(second, { frame: session(VIEW_AT + REDRAWN.length, 0, REDRAWN.length), replay: REDRAWN, after: "" }, REDRAWN.length / 2);
    const third = await redialedAfterCut(second);
    // An answer in another generation does not continue the view, so its
    // replay goes on a reset screen; the program is on its alternate screen
    // at the replay's first byte.
    const replay = "\x1b[5;1Hrestored frame";
    const frame = { ...session(500, 10, replay.length, "alternate"), generation: GENERATION + 1 };
    await deliver(third, { frame, replay, after: LOST_ALT_SUFFIX });
    expect(ghosttyAlternateScreen(term), "the program's alternate screen").toBe(true);
    expect(ghosttyLineText(term, 4), "the replay drew on it").toContain("restored frame");
  });

  test("an answer that names no start screen draws the replay on the view's own screen, as it always did", async () => {
    const { term, socket } = await viewOnTheAlternateScreen();
    const next = await redialed(socket);
    const end = VIEW_AT + LOST_EXIT.length + TAIL.length;
    await receive(next, session(end, LOST_EXIT.length, TAIL.length));
    await output(next, TAIL);
    expect(ghosttyAlternateScreen(term), "no switch ahead of the replay").toBe(true);
    expect(rows(term.buffer.alternate), "the tail on the alternate screen").toContain("probe exited");
    await output(next, LOST_PLAIN_SUFFIX);
    await receive(next, READY);
    expect(screen(term), "the suffix still leaves it, with no dead mode").toEqual({ alternate: false, mode1000: false, tracking: false });
  });
});
