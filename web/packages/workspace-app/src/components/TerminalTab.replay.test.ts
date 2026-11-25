// @vitest-environment jsdom
//
// A replay the socket cut short, on the real widget and vendored core: what
// the next attach's replay keeps of the screen and its history, and the
// keyboard protocol the reset before it puts back.

import type { Terminal } from "@chan/ghostty-web-ng";
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
import { WS_RECONNECT_BACKOFF_MAX_MS } from "../api/transport";
import { ghosttyAlternateScreen, ghosttyMode, mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { attach, installTerminalDom, output, receive, resetTerminals, seatTerminals, terminalTab, TerminalSocket } from "../__tests__/terminalTab";

installTerminalDom();
const SESSION = "replay-session";
const ALT = "\x1b[?1049h\x1b[2J\x1b[H";
const MODES = "\x1b[?1h\x1b[?2004h";
const READY = { type: "ready", cols: 80, rows: 24 };
// More rows than the screen holds, so part of the history is scrollback.
const HISTORY = Array.from({ length: 30 }, (_, i) => `older ${i + 1}\r\n`).join("") + "prompt";

/// The normal screen's rows, its history first. The core reads the screen
/// that is showing, so this reads only while the normal screen is.
function lines(term: Terminal): string[] {
  expect(ghosttyAlternateScreen(term), "the normal screen is showing").toBe(false);
  const buffer = term.buffer.normal;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
}

async function cut() {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const first = TerminalSocket.all.at(-1)!;
  await attach(first, { id: SESSION, generation: 3, seq: HISTORY.length, replay_bytes: HISTORY.length });
  await output(first, HISTORY);
  await receive(first, READY);
  first.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
  const second = TerminalSocket.all.at(-1)!;
  await attach(second, { id: SESSION, generation: 3, seq: 80, replay_bytes: 10 });
  await output(second, " partial");
  second.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
  expect(TerminalSocket.all, "a redial after each close").toHaveLength(3);
  return { tab: tab!, term, socket: TerminalSocket.all.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetTerminals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("a cut replay on the real parser", () => {
  test("an empty replay keeps normal scrollback through the alternate-screen prelude", async () => {
    const { socket, term } = await cut();
    const before = lines(term);
    expect(before).toContain("older 1");
    expect(term.getScrollbackLength(), "part of the history is scrollback").toBeGreaterThan(0);
    await attach(socket, { id: SESSION, generation: 3, seq: 80, replay_bytes: 0 });
    await output(socket, ALT);
    await output(socket, MODES);
    await receive(socket, READY);
    expect(ghosttyAlternateScreen(term)).toBe(true);
    // The program leaves the alternate screen, which shows the normal one
    // as it stood.
    await output(socket, "\x1b[?1049l");
    expect(lines(term), "empty replay preserves every normal-buffer line").toEqual(before);
  });

  test("an absent replay count keeps history while an older server repeats its ring", async () => {
    const { socket, term } = await cut();
    const before = lines(term);
    await attach(socket, { id: SESSION, generation: 3, seq: 80 });
    await output(socket, "\r\nretained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    expect(lines(term).slice(0, before.length - 1), "older server preserves history").toEqual(before.slice(0, -1));
  });

  test("a nonempty replay resets only when its first byte arrives", async () => {
    const { socket, term } = await cut();
    const before = lines(term);
    await attach(socket, { id: SESSION, generation: 3, seq: 80, replay_bytes: 13 });
    expect(lines(term), "session metadata alone preserves the screen").toEqual(before);
    await output(socket, "retained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    expect(lines(term).filter(Boolean), "only the retained ring remains").toEqual(["retained ring"]);
    expect(ghosttyMode(term, 1), "the modes after the ring survive the reset").toBe(true);
    expect(ghosttyMode(term, 2004), "the modes after the ring survive the reset").toBe(true);
  });

  test("a reset keeps the missed-byte notice above the retained ring", async () => {
    const { socket, term } = await cut();
    await attach(socket, { id: SESSION, generation: 3, seq: 4109, replay_bytes: 13, missed_bytes: 4096 });
    await output(socket, "retained ring");
    await output(socket, MODES);
    await receive(socket, READY);
    expect(lines(term).filter(Boolean), "missed-byte notice survives the replay reset").toEqual([
      "terminal replay missed 4096 bytes",
      "retained ring",
    ]);
  });

  test("the reset parser restores negotiated keyboard modes before replay bytes", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    await mountGhosttyTerminal(TerminalTab, tab!);
    const protocol = tab!.keyboardProtocol!;
    const initial = JSON.parse(JSON.stringify(protocol));
    const first = TerminalSocket.all.at(-1)!;
    await attach(first, { id: SESSION, generation: 3, seq: 0, replay_bytes: 0 });
    await receive(first, READY);
    // Protocol negotiation predates the ring that a redial can replay.
    await output(first, "\x1b[>4;2m\x1b[>5u");
    const before = JSON.parse(JSON.stringify(protocol));
    expect(before, "the program negotiated its keyboard modes").not.toEqual(initial);
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    const second = TerminalSocket.all.at(-1)!;
    await attach(second, { id: SESSION, generation: 3, seq: 80, replay_bytes: 20 });
    await output(second, "\x1b[>1u partial");
    expect(JSON.parse(JSON.stringify(protocol)), "the cut replay pushed a mode").not.toEqual(before);
    second.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    const third = TerminalSocket.all.at(-1)!;
    await attach(third, { id: SESSION, generation: 3, seq: 80, replay_bytes: 13 });
    await output(third, "retained ring");
    await output(third, MODES);
    await receive(third, READY);
    expect(tab!.keyboardProtocol, "handlers retain their state object").toBe(protocol);
    expect(JSON.parse(JSON.stringify(protocol)), "negotiated modes survive parsing RIS").toEqual(before);
  });
});
