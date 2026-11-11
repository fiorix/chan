import { readFileSync } from "node:fs";
import type { GhosttyCell } from "@chan/ghostty-web-ng";
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
/// character's spacer is nothing, and a cluster is its whole text.
function shownRow(cells: GhosttyCell[] | null, cluster: (x: number) => string): string {
  let text = "";
  (cells ?? []).forEach((cell, x) => {
    if (cell.width === 0) return;
    if (cell.codepoint === 0) text += " ";
    else text += cell.grapheme_len > 0 ? cluster(x) : String.fromCodePoint(cell.codepoint);
  });
  return text;
}

type ShownRow = { text: string; continues: boolean };

/// Rows as a copy reads them: a row that continues the row above joins it
/// (the first row read starts a line whatever it continues), each line's
/// trailing spaces go, and so do the trailing blank lines.
function shownLines(rows: ShownRow[]): string {
  const lines: string[] = [];
  for (const { text, continues } of rows) {
    if (continues && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.map((line) => line.replace(/ +$/, "")).join("\n").replace(/\n+$/, "");
}

/// Row `y` of a terminal counted history first, and whether it continues
/// the row above it.
function shownRowAt(t: VtTerminal, y: number, keep: (x: number) => boolean = () => true): ShownRow {
  const len = t.getScrollbackLength();
  const history = y < len;
  const cells = history ? t.getScrollbackLine(y) : t.getLine(y - len);
  const kept = (cells ?? []).map((cell, x) => (keep(x) ? cell : { ...cell, width: 0 }));
  return {
    text: shownRow(kept, (x) => (history ? t.getScrollbackGraphemeString(y, x) : t.getGraphemeString(y - len, x))),
    continues: history ? t.isScrollbackRowWrapped(y) : t.isRowWrapped(y - len),
  };
}

/// The text a terminal shows, history first, as a copy reads it.
function shownText(t: VtTerminal): string {
  const total = t.getScrollbackLength() + t.rows;
  return shownLines(Array.from({ length: total }, (_, y) => shownRowAt(t, y)));
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

describe("a copy joins the rows a program soft-wrapped", () => {
  const COMMAND = "$ git log --oneline --graph --decorate --all -- web/packages";

  test("a command longer than the width reads as one line, on screen and in history", async () => {
    const t = await terminal(24, 6);
    write(t, `${COMMAND}\r\nnext`);
    expect([t.isRowWrapped(1), t.isRowWrapped(2), t.isRowWrapped(3)], "the core wrapped it over three rows").toEqual([true, true, false]);
    expect(t.plainText()).toBe(`${COMMAND}\nnext`);
    expect(t.plainText({ startCol: 0, startRow: 0, endCol: 23, endRow: 2 })).toBe(COMMAND);
    write(t, "\r\n".repeat(6));
    expect(t.getScrollbackLength()).toBe(4);
    expect(t.isScrollbackRowWrapped(1)).toBe(true);
    expect(t.plainText()).toBe(`${COMMAND}\nnext`);
    expect(t.plainText({ startCol: 0, startRow: 0, endCol: 23, endRow: 2 })).toBe(COMMAND);
  });

  test("a hard line break stays one, after a full row as well", async () => {
    const t = await terminal(10, 4);
    write(t, "x".repeat(10) + "\r\ny\r\n" + "z".repeat(10) + "\rw");
    expect(t.isRowWrapped(1)).toBe(false);
    expect(t.plainText()).toBe("x".repeat(10) + "\ny\nw" + "z".repeat(9));
  });

  test("a space where the row wrapped stays, and a line's trailing spaces go", async () => {
    const t = await terminal(10, 4);
    write(t, "echo 1234 67890   \r\ndone   ");
    expect(t.isRowWrapped(1)).toBe(true);
    expect(t.plainText()).toBe("echo 1234 67890\ndone");
  });

  test("a wide character that did not fit the last column reads once, with nothing before it", async () => {
    const t = await terminal(10, 3);
    write(t, "x".repeat(9) + "日本語");
    expect(t.getLine(0)?.[9]?.width, "a spacer holds the last column").toBe(0);
    expect(t.plainText()).toBe("x".repeat(9) + "日本語");
  });

  test("a range that ends where a wide character did not fit takes the character", async () => {
    const t = await terminal(10, 3);
    write(t, "x".repeat(9) + "日本語");
    expect(t.plainText({ startCol: 0, startRow: 0, endCol: 9, endRow: 0 })).toBe("x".repeat(9) + "日");
    expect(t.plainText({ startCol: 0, startRow: 0, endCol: 8, endRow: 0 })).toBe("x".repeat(9));
  });

  test("a range from the middle of a wrapped line reads its rest as one line", async () => {
    const t = await terminal(10, 5);
    write(t, "a".repeat(10) + "b".repeat(10) + "c".repeat(5) + "\r\nz");
    expect(t.plainText()).toBe("a".repeat(10) + "b".repeat(10) + "c".repeat(5) + "\nz");
    expect(t.plainText({ startCol: 5, startRow: 1, endCol: 0, endRow: 3 })).toBe("b".repeat(5) + "c".repeat(5) + "\nz");
  });
});

describe("a range of rows in one core call", () => {
  /// What the rows from (startCol, startRow) to (endCol, endRow) show, both
  /// ends included, rows counted history first, as a copy reads them.
  function shownRange(t: VtTerminal, startCol: number, startRow: number, endCol: number, endRow: number): string {
    // A range that ends on a spacer head, the last column of a row where a
    // wide character did not fit, ends on that character at the start of
    // the next row, as the core's formatter reads it.
    if (endsOnSpacerHead(t, endCol, endRow)) {
      endCol = 0;
      endRow += 1;
    }
    const rows: ShownRow[] = [];
    for (let y = startRow; y <= endRow; y++) {
      const from = y === startRow ? startCol : 0;
      const to = y === endRow ? endCol : t.cols - 1;
      rows.push(shownRowAt(t, y, (x) => x >= from && x <= to));
    }
    return shownLines(rows);
  }

  function endsOnSpacerHead(t: VtTerminal, col: number, row: number): boolean {
    const len = t.getScrollbackLength();
    const cells = (y: number) => (y < len ? t.getScrollbackLine(y) : t.getLine(y - len));
    const here = cells(row);
    const next = row + 1 < len + t.rows ? shownRowAt(t, row + 1) : null;
    return (
      col === t.cols - 1 &&
      here?.[col]?.width === 0 &&
      here?.[col - 1]?.width !== 2 &&
      next?.continues === true &&
      cells(row + 1)?.[0]?.width === 2
    );
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

  test("joins a wrapped command and leaves out what the screen does not draw", async () => {
    const t = await terminal(10, 4);
    write(t, "$ ab\x7fcdefghijkl\r\nnext");
    const term: Source = { wasmTerm: t, buffer: { active: { length: 0, getLine: () => undefined } } };
    expect(ghosttyScrollbackText(term)).toBe("$ abcdefghijkl\nnext");
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

  test("leaves out what the screen does not draw from a buffer read too", () => {
    const rows = ["fir\x7fst", "\u200blast"];
    const term: Source = {
      wasmTerm: undefined,
      buffer: { active: { length: rows.length, getLine: (y) => ({ translateToString: () => rows[y] }) } },
    };
    expect(ghosttyScrollbackText(term)).toBe("first\nlast");
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
