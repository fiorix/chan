import { readFileSync } from "node:fs";
import { Ghostty, Terminal, type GhosttyTerminal } from "ghostty-web";
import { describe, expect, test } from "vitest";
import type { TerminalPreferences } from "../api/types";
import { ghosttyKitFrom, terminalBackendFromPrefs, type TerminalBackend } from "./backend";

describe("terminalBackendFromPrefs", () => {
  test("absent field (older server) means xterm.js", () => {
    expect(terminalBackendFromPrefs(undefined)).toBe("xterm");
    expect(terminalBackendFromPrefs({} as never)).toBe("xterm");
  });

  test("explicit false means xterm.js", () => {
    expect(terminalBackendFromPrefs({ ghostty: false } as never)).toBe("xterm");
  });

  test("true selects the ghostty backend", () => {
    expect(terminalBackendFromPrefs({ ghostty: true } as never)).toBe("ghostty");
  });
});

describe("the backend of a terminal by its window and its masking", () => {
  // A control terminal whose masking starts on is xterm, the one backend
  // that masks; every other cell is the configured backend.
  test.each([
    [true, undefined, true, "xterm"],
    [true, undefined, false, "xterm"],
    [true, true, true, "xterm"],
    [true, true, false, "xterm"],
    [true, false, true, "ghostty"],
    [true, false, false, "xterm"],
    [false, undefined, true, "ghostty"],
    [false, undefined, false, "xterm"],
    [false, true, true, "ghostty"],
    [false, true, false, "xterm"],
    [false, false, true, "ghostty"],
    [false, false, false, "xterm"],
  ] as const)(
    "control window %s, secret_masking %s, ghostty %s: %s",
    (terminalControl, secretMasking, ghostty, backend) => {
      const prefs = {
        ghostty,
        ...(secretMasking === undefined ? {} : { secret_masking: secretMasking }),
      } as TerminalPreferences;
      expect(terminalBackendFromPrefs(prefs, { terminalControl })).toBe<TerminalBackend>(backend);
    },
  );
});

describe("ghostty kit instances", () => {
  /// The pinned build's wasm, read where the web workspace hoists it
  /// (relative to the package directory vitest runs in).
  async function pinnedModule(): Promise<WebAssembly.Module> {
    return WebAssembly.compile(readFileSync("../../node_modules/ghostty-web/ghostty-vt.wasm"));
  }

  /// Cells on screen holding the disposed terminal's marker byte.
  function staleCells(term: GhosttyTerminal): number {
    term.update();
    const { cols, rows } = term.getDimensions();
    const cells = term.getViewport();
    let stale = 0;
    for (let i = 0; i < cols * rows; i++) {
      if (cells[i].codepoint === MARKER.codePointAt(0)) stale++;
    }
    return stale;
  }

  const MARKER = "§";

  /// A closed terminal with a screenful of history, then a new terminal on
  /// `next` at ghostty-web's default 80x24 resized to the real grid -- the
  /// order TerminalTab takes (open, then the first fit).
  function disposeThenSpawn(prev: Ghostty, next: Ghostty): GhosttyTerminal {
    const closed = prev.createTerminal(100, 30, { scrollbackLimit: 10000 });
    let out = "";
    for (let i = 0; i < 500; i++) out += `${MARKER.repeat(90)}\r\n`;
    closed.write(out);
    closed.free();
    const fresh = next.createTerminal(80, 24, {});
    fresh.resize(100, 30);
    return fresh;
  }

  test("the pinned build hands a freed terminal's cells to the next one on a shared instance", async () => {
    // The defect the per-terminal instance exists for, measured against the
    // pinned wasm. When this fails because nothing leaks, upstream zeroes its
    // pages (coder/ghostty-web#142) and terminals could share an instance.
    const shared = new Ghostty(await WebAssembly.instantiate(await pinnedModule(), { env: { log: () => {} } }));
    expect(staleCells(disposeThenSpawn(shared, shared))).toBeGreaterThan(0);
  });

  test("a terminal on its own instance starts blank after a resize", async () => {
    const kit = ghosttyKitFrom(await pinnedModule(), { Ghostty, Terminal });
    const first = await kit.instantiate();
    const second = await kit.instantiate();
    expect(second).not.toBe(first);
    expect(staleCells(disposeThenSpawn(first, second))).toBe(0);
  });

  test("each instance owns its memory", async () => {
    const kit = ghosttyKitFrom(await pinnedModule(), { Ghostty, Terminal });
    const memories = await Promise.all(
      [kit.instantiate(), kit.instantiate()].map(async (pending) => {
        const ghostty = (await pending) as unknown as { memory: WebAssembly.Memory };
        return ghostty.memory;
      }),
    );
    expect(memories[0]).toBeInstanceOf(WebAssembly.Memory);
    expect(memories[0]).not.toBe(memories[1]);
  });
});
