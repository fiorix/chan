import { readFileSync } from 'node:fs';
import { Terminal } from './terminal';
import { GhosttyVt, ghosttyScrollbackText } from '../vt/ghosttyVt';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const FIXTURES = '../../../scripts/e2e/browser-smoke/fixtures';
const COLS = 80;
const ROWS = 24;

/// Muse Code's own draws of a code block's line at 80 columns, recorded
/// from a real session (provenance in muse-code-block.json): once cut at
/// the last column and continued after a scroll of the rows above, once
/// continued after an absolute cursor move.
const PROVENANCE = JSON.parse(readFileSync(`${FIXTURES}/muse-code-block.json`, "utf8")) as {
  cols: number;
  row_prefix: string;
  expected_command: string;
};
const COMMAND = PROVENANCE.expected_command;
const PREFIX = PROVENANCE.row_prefix;
/// The line's two rows as the screen shows them: the first holds 80 cells.
const FIRST_ROW = (PREFIX + COMMAND).slice(0, COLS);
const SECOND_ROW = (PREFIX + COMMAND).slice(COLS);
const DRAWS = ["muse-code-block-scroll.bin", "muse-code-block-cup.bin"].map((name) => ({
  name,
  bytes: new Uint8Array(readFileSync(`${FIXTURES}/${name}`)),
}));

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
    get: (_, key) => key === 'measureText'
      ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
      : () => undefined,
    set: () => true,
  })) as never);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.replaceChildren();
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Range = { start: { col: number; absoluteRow: number }; end: { col: number; absoluteRow: number } };
type SelectionAPI = {
  setSelection(range: Range): void;
  getSelectionRange(): Range | null;
  getScrollbackText(): string;
};

// The recorded draws use the real widget lifecycle and its public policy.
async function museTerminal(input: string | Uint8Array, runsMuse: boolean) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const muse = { runs: runsMuse };
  const writes: string[] = [];
  const options = {
    ghostty, cols: COLS, rows: ROWS, scrollback: 100, smoothScrollDuration: 0,
    copy: (text: string) => void writes.push(text), joinDrawnWraps: () => muse.runs,
  };
  const term = new Terminal(options) as Terminal & SelectionAPI;
  opened.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  term.write(input);
  const canvas = host.querySelector('canvas')!;
  const captured = new Set<number>();
  Object.assign(canvas, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const cell = term.renderer!.getMetrics();
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, COLS * cell.width, ROWS * cell.height));
  const core = term.wasmTerm!;
  const history = core.getScrollbackLength();
  const at = ([col, row]: [number, number]) => ({ clientX: col * cell.width + 1, clientY: row * cell.height + 1 });
  const click = (detail: number, col: number, row: number) => {
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail, ...at([col, row]) }));
  };
  return {
    term, core, muse, writes, history, click,
    select(from: [number, number], to: [number, number]) {
      term.setSelection({ start: { col: from[0], absoluteRow: history + from[1] }, end: { col: to[0], absoluteRow: history + to[1] } });
    },
    drag(from: [number, number], to: [number, number]) {
      for (const [type, point, button, buttons] of [
        ['pointerdown', from, 0, 1], ['pointermove', to, -1, 1], ['pointerup', to, 0, 0],
      ] as const) {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'mouse', button, buttons, ...at(point),
        }));
      }
    },
  };
}

/// The screen row Muse drew the line's first row on; the second follows.
const LINE_ROW = 12;
/// The command's first and last cells: it starts after the prefix and ends
/// on the second row.
const COMMAND_START: [number, number] = [PREFIX.length, LINE_ROW];
const COMMAND_END: [number, number] = [SECOND_ROW.length - 1, LINE_ROW + 1];

describe.each(DRAWS)("a command Muse drew across two rows ($name)", ({ bytes }) => {
  test("the core marks no soft wrap between the rows, and the first reaches the last column", async () => {
    const { core, history } = await museTerminal(bytes, true);
    expect(core.isRowWrapped(LINE_ROW + 1)).toBe(false);
    const row = (r: number) => core.plainText({ startCol: 0, startRow: history + r, endCol: COLS - 1, endRow: history + r });
    expect([row(LINE_ROW), row(LINE_ROW + 1)]).toEqual([FIRST_ROW, SECOND_ROW]);
    expect(PROVENANCE.cols).toBe(COLS);
  });

  test("selected, it copies as the one command in a Muse session, made either way round", async () => {
    const { term, select } = await museTerminal(bytes, true);
    select(COMMAND_START, COMMAND_END);
    expect(term.getSelection()).toBe(COMMAND);
    select(COMMAND_END, COMMAND_START);
    expect(term.getSelection()).toBe(COMMAND);
  });

  test("every copy path copies the same line: release, chord, menu, double and triple click, Copy scrollback", async () => {
    const { term, writes, drag, click, select } = await museTerminal(bytes, true);
    drag(COMMAND_START, COMMAND_END);
    expect(writes).toEqual([COMMAND]);
    // The chord and the menu's Copy read the selection as TerminalTab does.
    expect(term.getSelection()).toBe(COMMAND);
    select(COMMAND_START, COMMAND_END);
    expect(term.copySelection()).toBe(true);
    // A double click on either side of the cut takes the word Muse cut.
    click(2, COLS - 1, LINE_ROW);
    click(2, 1, LINE_ROW + 1);
    // A triple click on either row takes the line, its prefix included.
    click(3, 10, LINE_ROW);
    click(3, 10, LINE_ROW + 1);
    expect(writes).toEqual([COMMAND, COMMAND, "wrapprobe-delta", "wrapprobe-delta", PREFIX + COMMAND, PREFIX + COMMAND]);
    expect(term.getScrollbackText().split("\n").filter(Boolean)).toEqual([PREFIX + COMMAND]);
  });

  test("in a session that does not run Muse, every path keeps the break at the cut", async () => {
    const { term, writes, drag, click } = await museTerminal(bytes, false);
    drag(COMMAND_START, COMMAND_END);
    click(2, COLS - 1, LINE_ROW);
    click(3, 10, LINE_ROW + 1);
    expect(writes).toEqual([`${FIRST_ROW.slice(PREFIX.length)}\n${SECOND_ROW}`, "wrapprobe-de", SECOND_ROW]);
    expect(term.getSelection()).toBe(SECOND_ROW);
    expect(term.getScrollbackText()).toBe(ghosttyScrollbackText(term));
    expect(term.getScrollbackText().split("\n").filter(Boolean)).toEqual([FIRST_ROW, SECOND_ROW]);
  });

  test("a selection inside the second row reads that row alone", async () => {
    const { term, select } = await museTerminal(bytes, true);
    select([0, LINE_ROW + 1], [20, LINE_ROW + 1]);
    expect(term.getSelection()).toBe(SECOND_ROW.slice(0, 21));
  });

  test("scrolled into the history, a double and a triple click still span both rows", async () => {
    const { term, core, history, click } = await museTerminal(bytes, true);
    term.write(`\x1b[${ROWS};1H${"\n".repeat(ROWS)}`);
    const first = history + LINE_ROW;
    expect(core.getScrollbackLength(), "both rows are history rows").toBeGreaterThan(first + 1);
    term.viewport.reveal(first, 'start');
    const viewRow = first - core.getScrollbackLength() + Math.floor(term.viewport.offset);
    const cutWord = FIRST_ROW.length - FIRST_ROW.lastIndexOf(" ") - 1;
    click(2, COLS - 1, viewRow);
    expect(term.getSelectionRange()).toEqual({
      start: { col: COLS - cutWord, absoluteRow: first },
      end: { col: 2, absoluteRow: first + 1 },
    });
    click(3, 1, viewRow + 1);
    expect(term.getSelectionRange()).toEqual({
      start: { col: 0, absoluteRow: first },
      end: { col: SECOND_ROW.length - 1, absoluteRow: first + 1 },
    });
    expect(term.getSelection()).toBe(PREFIX + COMMAND);
  });

  test("the reading follows the program in front: Muse gone, the break is back", async () => {
    const { term, muse, select } = await museTerminal(bytes, true);
    select(COMMAND_START, COMMAND_END);
    expect(term.getSelection()).toBe(COMMAND);
    muse.runs = false;
    expect(term.getSelection()).toBe(`${FIRST_ROW.slice(PREFIX.length)}\n${SECOND_ROW}`);
  });
});

describe("in a Muse session, rows that are not a cut line keep their breaks", () => {
  const RULE = "\u2500".repeat(COLS);
  const FULL = "x".repeat(COLS);

  test("a full-width rule over a line stays two lines, by every read", async () => {
    const { term, writes, select, click } = await museTerminal(`${RULE}\r\nnext line`, true);
    select([0, 0], [COLS - 1, 1]);
    expect(term.getSelection()).toBe(`${RULE}\nnext line`);
    click(3, 2, 1);
    expect(writes).toEqual(["next line"]);
    expect(term.getScrollbackText()).toBe(`${RULE}\nnext line`);
  });

  test.each([
    ["heavy", "\u2501".repeat(COLS)],
    ["double", "\u2550".repeat(COLS)],
    ["broken by spaces", `${"\u2500 ".repeat(COLS / 2 - 1)}\u2500\u2500`],
  ])("a full-width %s rule over a line stays two lines", async (_, rule) => {
    expect(rule.length).toBe(COLS);
    const { term, select } = await museTerminal(`${rule}\r\nnext line`, true);
    select([0, 0], [COLS - 1, 1]);
    expect(term.getSelection()).toBe(`${rule}\nnext line`);
  });

  test("a line drawn to the last column over a rule stays two lines", async () => {
    const { term, select } = await museTerminal(`${FULL}\r\n${RULE}`, true);
    select([0, 0], [COLS - 1, 1]);
    expect(term.getSelection()).toBe(`${FULL}\n${RULE}`);
  });

  test("a line drawn to the last column over a blank row keeps the blank row", async () => {
    const { term, select } = await museTerminal(`${FULL}\r\n\r\nafter`, true);
    select([0, 0], [COLS - 1, 2]);
    expect(term.getSelection()).toBe(`${FULL}\n\nafter`);
  });

  test("a row that ends one column short of the edge keeps its break, by every read", async () => {
    const short = "y".repeat(COLS - 1);
    const { term, history, select, click } = await museTerminal(`${short}\r\nnext line`, true);
    select([0, 0], [COLS - 1, 1]);
    expect(term.getSelection()).toBe(`${short}\nnext line`);
    expect(term.getScrollbackText()).toBe(`${short}\nnext line`);
    click(3, 0, 0);
    expect(term.getSelectionRange()).toEqual({
      start: { col: 0, absoluteRow: history },
      end: { col: COLS - 2, absoluteRow: history },
    });
    click(3, 0, 1);
    expect(term.getSelectionRange()).toEqual({
      start: { col: 0, absoluteRow: history + 1 },
      end: { col: "next line".length - 1, absoluteRow: history + 1 },
    });
  });

  test("a real two-line output stays two lines", async () => {
    const { term, select, writes, click } = await museTerminal("first line of output\r\nsecond line", true);
    select([0, 0], [COLS - 1, 1]);
    expect(term.getSelection()).toBe("first line of output\nsecond line");
    click(3, 2, 0);
    expect(writes).toEqual(["first line of output"]);
  });

  test("a line the terminal wrapped itself joins once, as it does outside Muse", async () => {
    const long = `$ echo ${"word ".repeat(18)}end`;
    const { term, core, select } = await museTerminal(`${long}\r\nok`, true);
    expect(core.isRowWrapped(1)).toBe(true);
    select([0, 0], [COLS - 1, 2]);
    expect(term.getSelection()).toBe(`${long}\nok`);
  });
});
