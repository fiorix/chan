// The frame reader: what changed since the last frame, from the core's own
// dirty iteration, and any row's cells read into a view.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI, CELL_BITS, GhosttyVt, LAYOUT, VtCells, VtFlag, type VtCell, type VtTerminal } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const D = ABI.GhosttyRenderStateDirty;

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

type Exports = Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };

async function core() {
  const instance = await WebAssembly.instantiate(vendored, {});
  return { vt: new GhosttyVt(instance), exports: instance.exports as unknown as Exports };
}

type Internals = { handle: number; wasm: { fn: Record<string, (...args: unknown[]) => unknown> } };

/// Counts the binding's calls into the core, by export.
function counting(t: VtTerminal) {
  const fn = (t as unknown as Internals).wasm.fn;
  const counts: Record<string, number> = {};
  for (const [name, f] of Object.entries(fn)) {
    fn[name] = (...args: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return f(...args);
    };
  }
  return {
    counts,
    total: () => Object.values(counts).reduce((a, b) => a + b, 0),
    reset: () => {
      for (const key of Object.keys(counts)) delete counts[key];
    },
  };
}

function dirtyRows(t: VtTerminal): number[] {
  return Array.from({ length: t.rows }, (_, y) => y).filter((y) => t.isRowDirty(y));
}

function text(cells: VtCells): string {
  let out = "";
  for (let x = 0; x < cells.length; x++) {
    const cell = cells.at(x)!;
    if (cell.width === 0) continue;
    out += cell.cluster ?? (cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ");
  }
  return out.trimEnd();
}

/// Screen row `y` of the terminal behind `handle` as the core resolves it,
/// through a render state of the test's own and the core's per-cell reads:
/// the raw cell, the style, the foreground and background the core
/// resolves, and the cluster. A new render state copies the whole screen
/// on its first update, whatever the terminal's dirty state.
function coreRow(ex: Exports, handle: number, y: number): VtCell[] {
  const view = () => new DataView(ex.memory.buffer);
  const make = (construct: (slot: number) => number) => {
    const slot = ex.ghostty_wasm_alloc_opaque();
    expect(construct(slot)).toBe(ABI.GhosttyResult.SUCCESS);
    const handleOut = ex.ghostty_wasm_take_opaque(slot);
    ex.ghostty_wasm_free_opaque(slot);
    return handleOut;
  };
  const state = make((slot) => ex.ghostty_render_state_new(0, slot));
  const rows = make((slot) => ex.ghostty_render_state_row_iterator_new(0, slot));
  const cells = make((slot) => ex.ghostty_render_state_row_cells_new(0, slot));
  const out = ex.ghostty_wasm_alloc(1024);
  try {
    expect(ex.ghostty_render_state_update(state, handle)).toBe(ABI.GhosttyResult.SUCCESS);
    const C = LAYOUT.GhosttyRenderStateColors;
    view().setUint32(out, C.size, true);
    ex.ghostty_render_state_get(state, ABI.GhosttyRenderStateData.COLORS, out);
    const rgb = (at: number) => (view().getUint8(at) << 16) | (view().getUint8(at + 1) << 8) | view().getUint8(at + 2);
    const fg = rgb(out + C.fields.foreground);
    const bg = rgb(out + C.fields.background);
    view().setUint32(out, rows, true);
    ex.ghostty_render_state_get(state, ABI.GhosttyRenderStateData.ROW_ITERATOR, out);
    for (let r = 0; r <= y; r++) expect(ex.ghostty_render_state_row_iterator_next(rows)).toBe(1);
    view().setUint32(out, cells, true);
    ex.ghostty_render_state_row_get(rows, ABI.GhosttyRenderStateRowData.CELLS, out);
    const K = ABI.GhosttyRenderStateRowCellsData;
    const T = ABI.GhosttyCellContentTag;
    const W = ABI.GhosttyCellWide;
    const row: VtCell[] = [];
    while (ex.ghostty_render_state_row_cells_next(cells)) {
      ex.ghostty_render_state_row_cells_get(cells, K.RAW, out);
      const raw = view().getBigUint64(out, true);
      const field = ([lsb, width]: readonly [number, number]) => Number((raw >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n));
      const tag = field(CELL_BITS.content_tag);
      const wide = field(CELL_BITS.wide);
      const cell: VtCell = {
        codepoint: tag === T.CODEPOINT || tag === T.CODEPOINT_GRAPHEME ? field(CELL_BITS.content) & 0x1fffff : 0,
        cluster: null,
        width: wide === W.WIDE ? 2 : wide === W.NARROW ? 1 : 0,
        flags: 0,
        fg,
        bg,
        hyperlink: field(CELL_BITS.hyperlink),
      };
      if (field(CELL_BITS.style_id) !== 0) {
        ex.ghostty_render_state_row_cells_get(cells, K.STYLE, out);
        cell.flags = view().getUint16(out + LAYOUT.GhosttyStyle.fields.flags, true);
      }
      if (ex.ghostty_render_state_row_cells_get(cells, K.FG_COLOR, out) === ABI.GhosttyResult.SUCCESS) cell.fg = rgb(out);
      if (ex.ghostty_render_state_row_cells_get(cells, K.BG_COLOR, out) === ABI.GhosttyResult.SUCCESS) cell.bg = rgb(out);
      if (tag === T.CODEPOINT_GRAPHEME) {
        const B = LAYOUT.GhosttyCodepointBuffer.fields;
        view().setUint32(out + B.ptr, out + 64, true);
        view().setUint32(out + B.cap, 200, true);
        view().setUint32(out + B.len, 0, true);
        expect(ex.ghostty_render_state_row_cells_get(cells, K.GRAPHEMES_BUF, out)).toBe(ABI.GhosttyResult.SUCCESS);
        const len = view().getUint32(out + B.len, true);
        const cps = Array.from({ length: len }, (_, i) => view().getUint32(out + 64 + i * 4, true));
        if (cps.length > 1) cell.cluster = String.fromCodePoint(...cps);
      }
      row.push(cell);
    }
    return row;
  } finally {
    ex.ghostty_wasm_free(out, 1024);
    ex.ghostty_render_state_row_cells_free(cells);
    ex.ghostty_render_state_row_iterator_free(rows);
    ex.ghostty_render_state_free(state);
  }
}

function cellsOf(view: VtCells): VtCell[] {
  return Array.from({ length: view.length }, (_, x) => ({ ...view.at(x)! }));
}

/// Screens whose every cell the reader must read as the core resolves it.
const SCREENS: Record<string, string> = {
  "plain lines": "hello\r\nworld\r\n$ ",
  "the 256 colours as foreground and background": Array.from(
    { length: 8 },
    (_, r) => Array.from({ length: 32 }, (_, c) => `\x1b[38;5;${r * 32 + c};48;5;${255 - r * 32 - c}m${String.fromCharCode(65 + (c % 26))}`).join("") + "\x1b[0m",
  ).join("\r\n"),
  "RGB, inverse and every attribute":
    "\x1b[38;2;10;20;30;48;2;200;100;50mrgb\x1b[0m \x1b[1mb\x1b[22;3mi\x1b[23;4mu\x1b[24;9ms\x1b[29;7mr\x1b[27;8mh\x1b[28;5mk\x1b[25;2mf\x1b[22;53mo\x1b[0m" +
    "\r\n\x1b[4:2mU2\x1b[4:3mU3\x1b[4:4mU4\x1b[4:5mU5\x1b[0m \x1b[7;31;44mx\x1b[0m \x1b[38;2;0;0;0;48;2;0;0;0mblack\x1b[0m \x1b[30;40mpalette black\x1b[0m",
  "backgrounds erased in a colour": "\x1b[44m\x1b[K\x1b[0m\r\n\x1b[48;2;1;2;3m\x1b[10X\x1b[0m\r\n\x1b[48;5;200m\x1b[5X\x1b[0mtext",
  "wide characters, spacers and clusters": `日本語 ｗｉｄｅ é ñ \u{1f468}‍\u{1f469}‍\u{1f467} ❤️\r\n${"x".repeat(79)}漢`,
  "a cluster beyond the scratch": "e" + "́".repeat(40) + "x",
  "hyperlinks": "\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain \x1b]8;;https://example.com/b\x1b\\other\x1b]8;;\x1b\\",
  "more styles in a row than a read keeps": Array.from({ length: 80 }, (_, i) => `\x1b[38;5;${i + 20};48;2;${i};${2 * i};${3 * i}m${String.fromCharCode(97 + (i % 26))}`).join("") + "\x1b[0m",
  "the alternate screen": "main\x1b[?1049h\x1b[2J\x1b[H\x1b[33malt\x1b[0m screen\x1b[3;3H\x1b[42mtext",
};

describe("the frame reader's rows", () => {
  test.each(Object.entries(SCREENS))("every cell of %s reads as the core resolves it", async (_name, bytes) => {
    const { vt, exports } = await core();
    const t = vt.createTerminal(80, 12, { fgColor: 0xd0d0d0, bgColor: 0x101010, palette: [0x010203, 0, 0xaa0000] });
    t.write(bytes);
    const view = new VtCells();
    for (let y = 0; y < t.rows; y++) {
      expect(t.readRow(y, view), `row ${y}`).toBe(true);
      expect(cellsOf(view), `row ${y}`).toEqual(coreRow(exports, (t as unknown as Internals).handle, y));
    }
  });

  test("every cell reads as the core resolves it after the program sets colours", async () => {
    const { vt, exports } = await core();
    const t = vt.createTerminal(40, 4, { fgColor: 0xd0d0d0, bgColor: 0x101010 });
    t.write("\x1b[31mred\x1b[0m \x1b[42mgreen\x1b[0m default\r\n\x1b[38;5;1mone\x1b[0m");
    const view = new VtCells();
    expect(t.readRow(0, view)).toBe(true);
    t.write("\x1b]4;1;rgb:00/ff/00\x07\x1b]4;2;rgb:12/34/56\x07\x1b]10;rgb:ff/ff/00\x07\x1b]11;rgb:20/20/40\x07");
    t.setColors({ fgColor: 0x202020, bgColor: 0xfafafa, palette: [0, 0x0000aa] });
    for (let y = 0; y < t.rows; y++) {
      expect(t.readRow(y, view)).toBe(true);
      expect(cellsOf(view), `row ${y}`).toEqual(coreRow(exports, (t as unknown as Internals).handle, y));
    }
  });

  test("a row's style ids name its own page's styles", async () => {
    // The core keeps rows in pages, each with styles of its own, so a style
    // id names a style of the page its row is on. Lines that take two styles
    // in one order fill a page until the cursor's row is the next page's
    // first; a line written there takes them in the other order, so the same
    // ids name the other styles than in the rows above it on the screen.
    const { vt, exports } = await core();
    const t = vt.createTerminal(80, 24, { scrollbackLimit: 100_000 });
    const handle = (t as unknown as Internals).handle;
    const buf = exports.ghostty_wasm_alloc(64);
    const P = LAYOUT.GhosttyPoint.fields;
    const C = LAYOUT.GhosttyPointCoordinate.fields;
    /// The page node and the style id of the first cell of screen row `y`.
    const ref = (y: number) => {
      const view = new DataView(exports.memory.buffer);
      view.setInt32(buf + P.tag, ABI.GhosttyPointTag.ACTIVE, true);
      view.setUint16(buf + P.value + C.x, 0, true);
      view.setUint32(buf + P.value + C.y, y, true);
      expect(exports.ghostty_terminal_grid_ref(handle, buf, buf + 32)).toBe(ABI.GhosttyResult.SUCCESS);
      expect(exports.ghostty_grid_ref_cell(buf + 32, buf + 48)).toBe(ABI.GhosttyResult.SUCCESS);
      const after = new DataView(exports.memory.buffer);
      const raw = after.getBigUint64(buf + 48, true);
      const [lsb, width] = CELL_BITS.style_id;
      return {
        node: after.getUint32(buf + 32 + LAYOUT.GhosttyGridRef.fields.node, true),
        styleId: Number((raw >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n)),
      };
    };
    t.write("\x1b[24;1H");
    const first = ref(23).node;
    for (let i = 0; ref(23).node === first; i++) {
      expect(i, "a new page within 100,000 lines").toBeLessThan(100_000);
      t.write(`\x1b[1;31mA${i}\x1b[0m \x1b[3;32mB\x1b[0m\r\n`);
    }
    t.write("\x1b[3;32mB\x1b[0m \x1b[1;31mA\x1b[0m");
    const top = ref(0);
    const bottom = ref(23);
    expect(bottom.node, "the screen's last row is on another page").not.toBe(top.node);
    expect(bottom.styleId, "the same id on both pages").toBe(top.styleId);
    const view = new VtCells();
    const flags: number[] = [];
    for (let y = 0; y < t.rows; y++) {
      expect(t.readRow(y, view)).toBe(true);
      flags.push(view.at(0)!.flags);
      expect(cellsOf(view), `row ${y}`).toEqual(coreRow(exports, handle, y));
    }
    expect(flags[0], "bold on the first page").toBe(VtFlag.BOLD);
    expect(flags[23], "italic on the second").toBe(VtFlag.ITALIC);
  });

  test("a row reads the same from the history as it read on the screen", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(80, 12, { palette: [0, 0xaa0000] });
    const lines = Object.values(SCREENS).slice(0, 6).join("\r\n");
    t.write(lines);
    const view = new VtCells();
    const onScreen: VtCell[][] = [];
    for (let y = 0; y < t.rows; y++) {
      expect(t.readRow(y, view)).toBe(true);
      onScreen.push(cellsOf(view));
    }
    // The lines fill the screen, so the cursor is on its last row and a
    // screenful of line feeds pushes every row into the history in order.
    const before = t.getScrollbackLength();
    t.write("\r\n".repeat(t.rows));
    expect(t.getScrollbackLength() - before).toBe(t.rows);
    for (let y = 0; y < t.rows; y++) {
      expect(t.readHistoryRow(before + y, view), `history ${before + y}`).toBe(true);
      expect([view.history, view.row]).toEqual([true, before + y]);
      expect(cellsOf(view), `screen row ${y} in the history`).toEqual(onScreen[y]);
    }
  });

  test("a view keeps its row until it reads another, and two views keep two", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 4);
    t.write("first\r\nsecond\r\nthird");
    const a = new VtCells();
    const b = new VtCells();
    expect(t.readRow(0, a)).toBe(true);
    expect(t.readRow(2, b)).toBe(true);
    expect([text(a), a.history, a.row]).toEqual(["first", false, 0]);
    expect([text(b), b.history, b.row]).toEqual(["third", false, 2]);
    expect(t.readRow(1, a)).toBe(true);
    expect(text(a)).toBe("second");
    expect(a.at(-1)).toBeUndefined();
    expect(a.at(20)).toBeUndefined();
  });

  test("rows outside the screen, the history or a live terminal read false", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 4);
    t.write("a\r\nb\r\nc\r\nd\r\ne");
    const view = new VtCells();
    expect(t.readRow(-1, view)).toBe(false);
    expect(t.readRow(4, view)).toBe(false);
    expect(t.readHistoryRow(-1, view)).toBe(false);
    expect(t.readHistoryRow(t.getScrollbackLength(), view)).toBe(false);
    expect(t.readHistoryRow(0, view)).toBe(true);
    expect(text(view)).toBe("a");
    t.free();
    expect(t.readRow(0, view)).toBe(false);
    expect(t.readHistoryRow(0, view)).toBe(false);
  });

  test("a wide character takes two columns and a spacer, at the end of a row a spacer head", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(10, 3);
    t.write("a漢b\r\n" + "x".repeat(9) + "字");
    const view = new VtCells();
    expect(t.readRow(0, view)).toBe(true);
    expect([0, 1, 2, 3].map((x) => [view.at(x)!.codepoint, view.at(x)!.width])).toEqual([
      [0x61, 1],
      [0x6f22, 2],
      [0, 0],
      [0x62, 1],
    ]);
    expect(t.readRow(1, view)).toBe(true);
    expect(view.at(9)!.width, "the head of a character that wrapped").toBe(0);
    expect(t.readRow(2, view)).toBe(true);
    expect([view.at(0)!.codepoint, view.at(0)!.width]).toEqual([0x5b57, 2]);
  });

  test("style flags are the core's own bits", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 2);
    t.write("\x1b[1ma\x1b[0;3mb\x1b[0;2mc\x1b[0;5md\x1b[0;7me\x1b[0;8mf\x1b[0;9mg\x1b[0;53mh\x1b[0;4:3mi\x1b[0m");
    const view = new VtCells();
    expect(t.readRow(0, view)).toBe(true);
    const flags = Array.from({ length: 9 }, (_, x) => view.at(x)!.flags);
    expect(flags).toEqual([
      VtFlag.BOLD,
      VtFlag.ITALIC,
      VtFlag.FAINT,
      VtFlag.BLINK,
      VtFlag.INVERSE,
      VtFlag.INVISIBLE,
      VtFlag.STRIKETHROUGH,
      VtFlag.OVERLINE,
      3 << 8,
    ]);
    expect(flags[8] & VtFlag.UNDERLINE).not.toBe(0);
  });
});

describe("the frame reader's dirty rows", () => {
  test("a write lists only the rows it touched and the cursor's", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 6);
    t.write("a\r\nb\r\nc");
    expect(t.beginFrame()).toBe(D.FULL);
    t.endFrame();
    expect(t.beginFrame()).toBe(D.FALSE);
    t.write("\x1b[4;1Hx");
    expect(t.beginFrame()).toBe(D.PARTIAL);
    // Row 2 held the cursor before the move, so it is listed too.
    expect(dirtyRows(t)).toEqual([2, 3]);
    t.endFrame();
    expect(dirtyRows(t)).toEqual([]);
    expect(t.beginFrame()).toBe(D.FALSE);
  });

  test("the rows changed by writes between two frames add up", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 8);
    t.write("top");
    t.beginFrame();
    t.endFrame();
    t.write("\x1b[3;1Hthree");
    expect(t.beginFrame()).toBe(D.PARTIAL);
    t.write("\x1b[6;1Hsix");
    const view = new VtCells();
    expect(t.readRow(5, view)).toBe(true);
    expect(text(view)).toBe("six");
    expect(t.beginFrame()).toBe(D.PARTIAL);
    expect(dirtyRows(t)).toEqual([0, 2, 5]);
    t.endFrame();
    expect(dirtyRows(t)).toEqual([]);
  });

  test.each([
    ["a resize", (t: VtTerminal) => t.resize(24, 6)],
    ["a switch to the alternate screen", (t: VtTerminal) => t.write("\x1b[?1049h")],
    [
      "a switch back to the primary screen",
      (t: VtTerminal) => {
        t.write("\x1b[?1049h\x1b[2Jalt");
        t.beginFrame();
        t.endFrame();
        t.write("\x1b[?1049l");
      },
    ],
    ["new colours", (t: VtTerminal) => t.setColors({ fgColor: 0x123456 })],
    ["a palette entry set by the program", (t: VtTerminal) => t.write("\x1b]4;1;rgb:00/ff/00\x07")],
    ["a default colour set by the program", (t: VtTerminal) => t.write("\x1b]11;rgb:20/20/40\x07")],
    ["output that scrolls", (t: VtTerminal) => t.write("\x1b[8;1H\r\nmore")],
    ["a full reset", (t: VtTerminal) => t.write("\x1bc")],
  ] as const)("%s marks every row", async (_name, change) => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 8);
    t.write("one\r\ntwo\r\nthree");
    t.beginFrame();
    t.endFrame();
    change(t);
    expect(t.beginFrame()).toBe(D.FULL);
    expect(dirtyRows(t)).toEqual(Array.from({ length: t.rows }, (_, y) => y));
  });

  test("a frame with nothing changed calls nothing in the core", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 6);
    t.write("text");
    const view = new VtCells();
    t.beginFrame();
    t.readRow(0, view);
    t.endFrame();
    const calls = counting(t);
    expect(t.beginFrame()).toBe(D.FALSE);
    dirtyRows(t);
    expect(t.readRow(0, view), "the row the view holds").toBe(true);
    t.endFrame();
    expect(calls.counts).toEqual({});
  });

  test("a frame reads its dirty rows by the core's iteration and cleans the core once", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 24);
    t.write("text");
    t.beginFrame();
    t.endFrame();
    const calls = counting(t);
    t.write("\x1b[10;1Hrow ten");
    calls.reset();
    t.beginFrame();
    expect(dirtyRows(t)).toEqual([0, 9]);
    t.endFrame();
    expect(calls.counts).toEqual({
      ghostty_render_state_update: 1,
      // the dirty state, the colours and the row iterator
      ghostty_render_state_get: 3,
      // the two dirty rows and the end
      ghostty_render_state_row_iterator_next_dirty: 3,
      ghostty_render_state_clean: 1,
    });
  });

  test("rows read top to bottom step the row iterator down once, and a row read again reads nothing", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 10);
    t.write(Array.from({ length: 10 }, (_, i) => `row ${i}`).join("\r\n"));
    t.beginFrame();
    const view = new VtCells();
    const calls = counting(t);
    for (let y = 0; y < 10; y++) expect(t.readRow(y, view)).toBe(true);
    expect(calls.counts.ghostty_render_state_row_iterator_next).toBe(10);
    expect(calls.counts.ghostty_render_state_get, "the iterator filled once").toBe(1);
    expect(calls.counts.ghostty_render_state_row_get_multi, "one call a row for its cells").toBe(10);
    calls.reset();
    expect(t.readRow(9, view)).toBe(true);
    expect(calls.total()).toBe(0);
    // A row above the iterator fills it again from the top.
    expect(t.readRow(2, view)).toBe(true);
    expect(text(view)).toBe("row 2");
    expect(calls.counts.ghostty_render_state_row_iterator_next).toBe(3);
  });

  test("a row an update left as it was reads nothing again, and a row it changed reads again", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 8);
    t.write(Array.from({ length: 6 }, (_, i) => `row ${i}`).join("\r\n"));
    const top = new VtCells();
    const changed = new VtCells();
    expect(t.readRow(0, top)).toBe(true);
    expect(t.readRow(3, changed)).toBe(true);
    t.beginFrame();
    t.endFrame();
    t.write("\x1b[4;1Hrow three");
    const calls = counting(t);
    expect(t.readRow(0, top)).toBe(true);
    expect(calls.counts.ghostty_render_state_row_get_multi, "the unchanged row").toBeUndefined();
    expect(t.readRow(3, changed)).toBe(true);
    expect(calls.counts.ghostty_render_state_row_get_multi, "the changed row").toBe(1);
    expect([text(top), text(changed)]).toEqual(["row 0", "row three"]);
    // New colours change every row.
    t.setColors({ fgColor: 0x123456 });
    calls.reset();
    expect(t.readRow(0, top)).toBe(true);
    expect(calls.counts.ghostty_render_state_row_get_multi).toBe(1);
    expect(top.at(0)!.fg).toBe(0x123456);
  });

  test("a row is read again after a write, and reads what the write left", async () => {
    const { vt } = await core();
    const t = vt.createTerminal(20, 4);
    t.write("before");
    const view = new VtCells();
    expect(t.readRow(0, view)).toBe(true);
    expect(text(view)).toBe("before");
    t.write("\rafter!");
    expect(t.readRow(0, view)).toBe(true);
    expect(text(view)).toBe("after!");
    t.setColors({ fgColor: 0x123456 });
    expect(t.readRow(0, view)).toBe(true);
    expect(view.at(0)!.fg).toBe(0x123456);
  });
});
