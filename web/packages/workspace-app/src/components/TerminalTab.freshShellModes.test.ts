// The fresh-shell reset's list against the server's tracked set. The mounted
// cases of the reset, on the real core, are in
// `TerminalTab.ghosttySession.test.ts`.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { FRESH_SHELL_RESET_MODES } from "../terminal/freshShellReset";

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
    // The sorted comparison runs before the count so a drift names its mode.
    expect([...FRESH_SHELL_RESET_MODES].sort((a, b) => a - b)).toEqual([...server].sort((a, b) => a - b));
    expect(server.length, "the server tracks twelve modes").toBe(12);
    // The reset is one sequence of parameters. No source in the tree states
    // the vendored core's parameter cap, so 16 stays the bound: past a
    // core's cap the tail would drop silently while this tie stays green.
    expect(FRESH_SHELL_RESET_MODES.length).toBeLessThanOrEqual(16);
  });
});
