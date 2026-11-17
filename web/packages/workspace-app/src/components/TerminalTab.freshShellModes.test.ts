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
import { FRESH_SHELL_RESET_MODES } from "../terminal/freshShellReset";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SESSION = "sess-xterm";
const FRESH = "sess-fresh";

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

/// Whether the bytes written to the stand-in xterm clear this DEC private
/// mode: some `CSI ? ... l` sequence names it exactly. A set sequence (`h`)
/// never counts.
function resetClearsMode(written: string, mode: number): boolean {
  return written.split("\x1b[?").slice(1).some((rest) => {
    const end = rest.search(/[^0-9;]/);
    if (end === -1 || rest[end] !== "l") return false;
    return rest.slice(0, end).split(";").includes(String(mode));
  });
}

describe("a fresh shell after a dead full-screen program on xterm", () => {
  // The server's whole tracked set: each mode set by the dead program, kept
  // on a same-id resume and cleared for a fresh shell.
  test.each([1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004])(
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
    // The reset is the only `l`-final private-mode sequence here: the dead
    // program's set and the fresh shell's output are `h`-final.
    const written = term.written.join("");
    const resetMatch = /\x1b\[\?[0-9;]+l/.exec(written);
    expect(resetMatch, "the fresh shell's reset is written").not.toBeNull();
    expect(written.indexOf("first-prompt"), "the fresh shell's first output follows the reset").toBeGreaterThan(resetMatch!.index);
  });
});

describe("the fresh-shell reset list", () => {
  test("matches the server's tracked set", () => {
    // Relative to the package directory vitest runs from, as the other
    // source-reading tests do (`App.coverWindowChords.test.ts`).
    const rust = readFileSync("../../../crates/chan-library/src/terminal_sessions.rs", "utf8");
    const block = rust.match(/TRACKED_PRIVATE_MODES: &\[u16\] = &\[([\s\S]*?)\];/)?.[1];
    expect(block, "TRACKED_PRIVATE_MODES found").toBeDefined();
    const bracketed = Number(rust.match(/BRACKETED_PASTE_MODE: u16 = (\d+);/)?.[1]);
    const server = block!.split("\n").flatMap((line) => {
      const n = line.match(/^\s*(\d+),/);
      if (n) return [Number(n[1])];
      if (/^\s*BRACKETED_PASTE_MODE,/.test(line)) return [bracketed];
      return [];
    });
    expect(server.length, "the server tracks twelve modes").toBe(12);
    expect([...FRESH_SHELL_RESET_MODES].sort((a, b) => a - b)).toEqual([...server].sort((a, b) => a - b));
  });
});
