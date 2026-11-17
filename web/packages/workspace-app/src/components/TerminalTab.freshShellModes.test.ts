// @vitest-environment jsdom
//
// The fresh-shell reset on the xterm backend. The stand-in xterm records no
// private-mode state, so these cases read the reset's bytes written to it,
// while the ghostty arm in `TerminalTab.ghosttySession.test.ts` reads the
// real core. The last case ties the reset's list to the server's tracked set.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { FRESH_SHELL_RESET_MODES, freshShellResetSequence } from "../terminal/freshShellReset";
import { clearTerminalSnapshot, writeTerminalSnapshot } from "../terminal/snapshotCache";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetClearsMode,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-xterm";
const FRESH = "sess-fresh";
// The mounted cases below stay a literal list so a dropped mode goes red at
// its own case; the drift test forces it to grow with the reset list.
const XTERM_CASES = [1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetTerminals();
});

async function reconnect(socket: TerminalSocket, id: string) {
  const before = TerminalSocket.all.length;
  socket.close();
  await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
  expect(TerminalSocket.all).toHaveLength(before + 1);
  const next = TerminalSocket.all.at(-1)!;
  await attach(next, { id });
  return next;
}

describe("a fresh shell after a dead full-screen program on xterm", () => {
  // The server's whole tracked set: each mode set by the dead program, kept
  // on a same-id resume and cleared for a fresh shell.
  test.each(XTERM_CASES)(
    "clears DEC %i for a fresh shell and keeps it on resume (reads the reset bytes written to xterm)",
    async (mode) => {
      const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
      const { term } = await mountTerminal(TerminalTab, tab!);
      const socket = TerminalSocket.all.at(-1)!;
      await attach(socket, { id: SESSION });
      await receive(socket, { type: "ready", cols: 80, rows: 24 });
      term.written.splice(0);
      await output(socket, `\x1b[?${mode}h`);

      const resumed = await reconnect(socket, SESSION);
      await receive(resumed, { type: "ready", cols: 80, rows: 24 });
      expect(resetClearsMode(term.written.join(""), mode), "a same-id resume writes no reset").toBe(false);

      const replaced = await reconnect(resumed, FRESH);
      await receive(replaced, { type: "ready", cols: 80, rows: 24 });
      expect(resetClearsMode(term.written.join(""), mode), "the fresh shell's reset clears the dead program's mode").toBe(true);
    },
  );

  test("writes the reset before the fresh shell's first output", async () => {
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: SESSION });
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    term.written.splice(0);
    await output(socket, "\x1b[?2004h\x1b[?1h");

    const replaced = await reconnect(socket, FRESH);
    await output(replaced, "first-prompt\x1b[?2004h\x1b[?1h");
    await receive(replaced, { type: "ready", cols: 80, rows: 24 });
    // The reset is the exact tracked-mode sequence.
    const written = term.written.join("");
    const resetAt = written.indexOf(freshShellResetSequence());
    expect(resetAt, "the fresh shell's reset is written").toBeGreaterThanOrEqual(0);
    expect(written.indexOf("first-prompt"), "the fresh shell's first output follows the reset").toBeGreaterThan(resetAt);
  });

  test("drops a cached snapshot of the dead session for a fresh shell", async () => {
    // A reload with a snapshot cached under the old session id: the server
    // has since minted a fresh shell, whose frame confirms the cached
    // generation with nothing missed. The snapshot is another session's
    // screen and modes and must not paint after the reset.
    writeTerminalSnapshot(SESSION, {
      ansi: "SNAPSHOT SCREEN\x1b[?2004h\x1b[?1h",
      generation: 7,
      lastSeq: 42,
      cols: 80,
      rows: 24,
      updatedAt: 1,
    });
    try {
      const [tab] = seatTerminals([terminalTab({ terminalSessionId: SESSION })]);
      const { term } = await mountTerminal(TerminalTab, tab!);
      const socket = TerminalSocket.all.at(-1)!;
      const dialed = new URL(socket.url, "http://chan.test").searchParams;
      expect(dialed.get("since"), "the dial resumes from the cached snapshot").toBe("42");
      expect(dialed.get("generation"), "the dial resumes from the cached snapshot").toBe("7");
      await attach(socket, { id: FRESH, generation: 7, seq: 0, missed_bytes: 0 });
      await receive(socket, { type: "ready", cols: 80, rows: 24 });

      const written = term.written.join("");
      const resetAt = written.indexOf(freshShellResetSequence());
      expect(resetAt, "the fresh shell's reset is written").toBeGreaterThanOrEqual(0);
      expect(written, "a fresh id drops the dead session's cached snapshot").not.toContain("SNAPSHOT SCREEN");
      expect(
        written.slice(resetAt),
        "no mode-set follows the reset before ready",
      ).not.toMatch(/\x1b\[\?[0-9;]+h/);
    } finally {
      clearTerminalSnapshot(SESSION);
    }
  });
});

describe("the fresh-shell reset list", () => {
  test("matches the server's tracked set", () => {
    // Contract: a mode the server tracks is a mode the reset clears. The
    // output scanner and the restore import filter on the const (`terminal_sessions.rs`,
    // `scan_private_modes` caller and restore filter); the attach prelude writes
    // the stored set unfiltered (`private_mode_prelude`).
    // Relative to the package directory vitest runs from, as the other
    // source-reading tests do (`App.coverWindowChords.test.ts`).
    const rust = readFileSync("../../../crates/chan-library/src/terminal_sessions.rs", "utf8");
    const block = rust.match(/TRACKED_PRIVATE_MODES: &\[u16\] = &\[([\s\S]*?)\];/)?.[1];
    expect(block, "TRACKED_PRIVATE_MODES found").toBeDefined();
    const consts = new Map<string, number>();
    for (const m of rust.matchAll(/const (\w+): u16 = (\d+);/g)) consts.set(m[1]!, Number(m[2]));
    const unparsed: string[] = [];
    const server = block!.split("\n").flatMap((line) => {
      if (/^\s*(?:\/\/|$)/.test(line)) return [];
      const code = line.replace(/\s*\/\/.*$/, "");
      const n = code.match(/^\s*(\d+),$/);
      if (n) return [Number(n[1])];
      const id = code.match(/^\s*(\w+),$/);
      if (id && consts.has(id[1]!)) return [consts.get(id[1]!)!];
      unparsed.push(line.trim());
      return [];
    });
    expect(unparsed, "every line of the block parsed to a mode").toEqual([]);
    expect(new Set(XTERM_CASES)).toEqual(new Set(FRESH_SHELL_RESET_MODES));
    // The sorted comparison runs before the count so a drift names its mode.
    expect([...FRESH_SHELL_RESET_MODES].sort((a, b) => a - b)).toEqual([...server].sort((a, b) => a - b));
    expect(server.length, "the server tracks twelve modes").toBe(12);
    // xterm.js stores 32 parameters (`@xterm/xterm` `Params.ts`); 16 stays the
    // bound as the conservative one for the vendored ghostty core, whose cap
    // no source in the tree states. Past a core's cap the tail would drop
    // silently while this tie stays green.
    expect(FRESH_SHELL_RESET_MODES.length).toBeLessThanOrEqual(16);
  });
});
