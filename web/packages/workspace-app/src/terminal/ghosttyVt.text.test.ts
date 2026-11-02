import { readFileSync } from "node:fs";
import type { GhosttyCell } from "ghostty-web";
import { beforeAll, describe, expect, test } from "vitest";
import { SCREEN_STREAMS, TEXT_STREAMS } from "../__tests__/ghosttyStreams";
import { GhosttyVt, ghosttyScrollbackText, VtTerminal } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

async function terminal(cols: number, rows: number, scrollbackLimit = 1000): Promise<VtTerminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  return vt.createTerminal(cols, rows, { scrollbackLimit }) as unknown as VtTerminal;
}

function write(t: VtTerminal, input: string): void {
  for (let i = 0; i < input.length; i += 65536) t.write(input.slice(i, i + 65536));
}

/// What a row shows, read cell by cell: a blank cell is a space, a wide
/// character's spacer is nothing, a cluster is its whole text, and trailing
/// spaces go.
function shownRow(cells: GhosttyCell[] | null, cluster: (x: number) => string): string {
  let text = "";
  (cells ?? []).forEach((cell, x) => {
    if (cell.width === 0) return;
    if (cell.codepoint === 0) text += " ";
    else text += cell.grapheme_len > 0 ? cluster(x) : String.fromCodePoint(cell.codepoint);
  });
  return text.replace(/ +$/, "");
}

/// The text a terminal shows, history first, rows on separate lines,
/// trailing blank rows dropped.
function shownText(t: VtTerminal): string {
  const rows: string[] = [];
  for (let y = 0; y < t.getScrollbackLength(); y++) {
    rows.push(shownRow(t.getScrollbackLine(y), (x) => t.getScrollbackGraphemeString(y, x)));
  }
  for (let y = 0; y < t.rows; y++) {
    rows.push(shownRow(t.getLine(y), (x) => t.getGraphemeString(y, x)));
  }
  return rows.join("\n").replace(/\n+$/, "");
}

describe("the terminal's text in one core call", () => {
  test.each(Object.entries({ ...SCREEN_STREAMS, ...TEXT_STREAMS }))(
    "%s reads as its rows show, on screen and in history",
    async (_name, input) => {
      const t = await terminal(80, 5);
      write(t, input);
      expect(t.plainText()).toBe(shownText(t));
      write(t, "\r\n".repeat(5));
      expect(t.getScrollbackLength()).toBeGreaterThan(0);
      expect(t.plainText()).toBe(shownText(t));
    },
  );

  test("accents, emoji, wide characters and erased cells read as shown", async () => {
    const t = await terminal(40, 4);
    write(t, "é ñ\r\n日本語 x\r\na\u{1F44D}\u{1F3FD}b\r\nabc\x1b[5Cd");
    expect(t.plainText()).toBe("é ñ\n日本語 x\na\u{1F44D}\u{1F3FD}b\nabc     d");
  });

  test("a row's trailing spaces go and other trailing whitespace stays", async () => {
    const t = await terminal(40, 4);
    write(t, "spaces   \r\nno-break\u00a0\r\nideographic\u3000");
    expect(t.plainText()).toBe("spaces\nno-break\u00a0\nideographic\u3000");
  });

  test("the alternate screen reads its own rows and no history", async () => {
    const t = await terminal(40, 4);
    write(t, Array.from({ length: 10 }, (_, i) => `primary ${i}`).join("\r\n"));
    expect(t.getScrollbackLength()).toBeGreaterThan(0);
    write(t, "\x1b[?1049h\x1b[2J\x1b[Halt one\r\nalt two");
    expect(t.plainText()).toBe("alt one\nalt two");
  });

  test("an empty terminal reads as no text", async () => {
    const t = await terminal(40, 4);
    expect(t.plainText()).toBe("");
  });
});

describe("a range of rows in one core call", () => {
  /// What the rows from (startCol, startRow) to (endCol, endRow) show, both
  /// ends included, rows counted history first.
  function shownRange(t: VtTerminal, startCol: number, startRow: number, endCol: number, endRow: number): string {
    const len = t.getScrollbackLength();
    const rows: string[] = [];
    for (let y = startRow; y <= endRow; y++) {
      const history = y < len;
      const cells = history ? t.getScrollbackLine(y) : t.getLine(y - len);
      const from = y === startRow ? startCol : 0;
      const to = y === endRow ? endCol : t.cols - 1;
      const slice = (cells ?? []).map((cell, x) => (x < from || x > to ? { ...cell, width: 0 } : cell));
      rows.push(shownRow(slice, (x) => (history ? t.getScrollbackGraphemeString(y, x) : t.getGraphemeString(y - len, x))));
    }
    return rows.join("\n").replace(/\n+$/, "");
  }

  test.each(Object.entries({ ...SCREEN_STREAMS, ...TEXT_STREAMS }))(
    "%s reads as its rows show, row by row and across history and screen",
    async (_name, input) => {
      const t = await terminal(80, 5);
      write(t, input + "\r\n".repeat(3));
      const total = t.getScrollbackLength() + t.rows;
      for (let y = 0; y < total; y++) {
        expect(t.plainText({ startCol: 0, startRow: y, endCol: 79, endRow: y }), `row ${y}`).toBe(shownRange(t, 0, y, 79, y));
      }
      expect(t.plainText({ startCol: 0, startRow: 0, endCol: 79, endRow: total - 1 })).toBe(t.plainText());
    },
  );

  test("a range starts and ends mid-row, and a wide character reads once", async () => {
    const t = await terminal(20, 3);
    write(t, "hello world\r\n日本語 x\r\nlast line");
    expect(t.plainText({ startCol: 6, startRow: 0, endCol: 3, endRow: 1 })).toBe("world\n日本");
    expect(t.plainText({ startCol: 0, startRow: 1, endCol: 3, endRow: 2 })).toBe("日本語 x\nlast");
  });

  test("a range past the last row reads to the last row", async () => {
    const t = await terminal(20, 3);
    write(t, "a\r\nb\r\nc");
    expect(t.plainText({ startCol: 0, startRow: 1, endCol: 19, endRow: 99 })).toBe("b\nc");
    expect(t.plainText({ startCol: 0, startRow: 50, endCol: 19, endRow: 99 })).toBe("");
    expect(t.plainText({ startCol: 19, startRow: 99, endCol: 0, endRow: 1 })).toBe("b\nc");
  });
});

describe("Copy scrollback's text", () => {
  type Source = Parameters<typeof ghosttyScrollbackText>[0];

  test("reads the binding's terminal in one call and no row of the buffer", async () => {
    const t = await terminal(40, 4);
    write(t, "one\r\ntwo  \r\n\r\nthree\r\n");
    const term: Source = {
      wasmTerm: t,
      buffer: {
        active: {
          length: 4,
          getLine: () => {
            throw new Error("read a buffer row");
          },
        },
      },
    };
    expect(ghosttyScrollbackText(term)).toBe("one\ntwo\n\nthree");
  });

  test("reads the buffer row by row from a terminal the binding does not drive", () => {
    const rows = ["first  ", "", "last", "", ""];
    const term: Source = {
      wasmTerm: undefined,
      buffer: {
        active: {
          length: rows.length,
          getLine: (y) => ({ translateToString: (trim) => (trim ? rows[y].trimEnd() : rows[y]) }),
        },
      },
    };
    expect(ghosttyScrollbackText(term)).toBe("first\n\nlast");
  });
});

describe("the whole-history read's budget", () => {
  // 55,000 rows at 200 columns read in at most 330 ms (6 us a row), a tenth
  // of the row-by-row cell read; measured at about 35 ms in Node.
  test("55,000 rows of history at 200 columns", async () => {
    const cols = 200;
    const rows = 40;
    const lines = 55_000;
    const t = await terminal(cols, rows, 60_000);
    write(t, Array.from({ length: lines + rows }, (_, i) => `${i} `.padEnd(cols - 1, "x")).join("\r\n"));
    expect(t.getScrollbackLength()).toBe(lines);
    let best = Infinity;
    let text: string | null = null;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      text = t.plainText();
      best = Math.min(best, performance.now() - start);
    }
    const split = text?.split("\n") ?? [];
    expect(split.length).toBe(lines + rows);
    expect(split[0]).toBe("0 ".padEnd(cols - 1, "x"));
    expect(split.at(-1)).toBe(`${lines + rows - 1} `.padEnd(cols - 1, "x"));
    expect(best / lines, `${best.toFixed(1)} ms for ${lines} rows`).toBeLessThanOrEqual(0.006);
  });
});
