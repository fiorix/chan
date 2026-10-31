import { readFileSync } from "node:fs";
import { Terminal, type Ghostty, type GhosttyTerminal } from "ghostty-web";
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

describe("the backend of a terminal and its masking", () => {
  // Masking exists on both backends, so the masking preference never
  // moves a terminal off the configured backend.
  test.each([
    [undefined, true, "ghostty"],
    [true, true, "ghostty"],
    [false, true, "ghostty"],
    [undefined, false, "xterm"],
    [true, false, "xterm"],
    [false, false, "xterm"],
  ] as const)("secret_masking %s, ghostty %s: %s", (secretMasking, ghostty, backend) => {
    const prefs = {
      ghostty,
      ...(secretMasking === undefined ? {} : { secret_masking: secretMasking }),
    } as TerminalPreferences;
    expect(terminalBackendFromPrefs(prefs)).toBe<TerminalBackend>(backend);
  });
});

describe("ghostty kit instances", () => {
  /// The vendored release wasm (relative to the package directory vitest
  /// runs in).
  async function vendoredModule(): Promise<WebAssembly.Module> {
    return WebAssembly.compile(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
  }

  /// Cells on screen holding the disposed terminal's marker byte.
  function staleCells(term: GhosttyTerminal): number {
    term.update();
    const { rows } = term.getDimensions();
    let stale = 0;
    for (let y = 0; y < rows; y++) {
      for (const cell of term.getLine(y) ?? []) {
        if (cell.codepoint === MARKER.codePointAt(0)) stale++;
      }
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

  test("a terminal starts blank after a freed one on the same instance", async () => {
    const kit = ghosttyKitFrom(await vendoredModule(), { Terminal });
    const shared = await kit.instantiate();
    expect(staleCells(disposeThenSpawn(shared, shared))).toBe(0);
  });

  test("a terminal on its own instance starts blank after a resize", async () => {
    const kit = ghosttyKitFrom(await vendoredModule(), { Terminal });
    const first = await kit.instantiate();
    const second = await kit.instantiate();
    expect(second).not.toBe(first);
    expect(staleCells(disposeThenSpawn(first, second))).toBe(0);
  });

  test("each instance owns its memory", async () => {
    const kit = ghosttyKitFrom(await vendoredModule(), { Terminal });
    const memories = await Promise.all(
      [kit.instantiate(), kit.instantiate()].map(async (pending) => {
        const ghostty = (await pending) as unknown as { wasm: { memory: WebAssembly.Memory } };
        return ghostty.wasm.memory;
      }),
    );
    expect(memories[0]).toBeInstanceOf(WebAssembly.Memory);
    expect(memories[0]).not.toBe(memories[1]);
  });
});
