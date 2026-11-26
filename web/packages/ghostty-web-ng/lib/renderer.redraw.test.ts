// The widget's renderer repaints only the rows a frame needs: the rows the
// core marked dirty, the cursor's rows, the selection's and a hovered
// link's, and their neighbours. These tests hold each frame of an opened
// terminal's render loop, through a run of small changes, to the full frame
// the terminal paints of the same state right after it: the canvas must
// show the same calls in every cell before and after (cellPictureCanvas.ts).
// A frame that repaints too little leaves a cell showing what it held
// before, which the full frame replaces.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { GhosttyVt } from "../vt/ghosttyVt";
import { CellPictureContext, type CellPictures } from "./__tests__/cellPictureCanvas";
import type { ITheme } from "./interfaces";
import type { PaintLayer } from "./renderer";
import { Terminal } from "./terminal";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 8;

const THEME: ITheme = {
  background: "#101010",
  foreground: "#e0e0e0",
  cursor: "#58a6ff",
  selectionBackground: "rgba(88, 166, 255, 0.35)",
};

/// The colour the stand-in mask layer fills a value's cells in.
const MASK = "#6c6c70";

type Options = {
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  ratio?: number;
  glyphs?: boolean;
  masking?: boolean;
};

type Rig = {
  term: Terminal;
  /// Scrolls the view back `y` rows into the history. The terminal clamps
  /// its own offset at zero, so an offset below zero is written to the one
  /// it hands the renderer.
  view(y: number): void;
  /// What one full frame paints of the terminal scrolled back `viewportY`
  /// rows. The terminal is left on the view it showed, painted whole.
  picture(viewportY: number): CellPictures;
};

/// A step of a run: bytes the program writes, or a change made to the rig,
/// which the run awaits when it settles later.
type Step = string | ((rig: Rig) => unknown);

/// A mask layer as an embedder's secret masker registers one: on each row
/// the frame repainted, read from the buffer at the frame's top row, it
/// fills the cells of a value assigned to a name ending in TOKEN.
function maskLayer(term: Terminal): PaintLayer {
  return {
    order: "mask",
    paint({ ctx, metrics, topRow, changedRows }) {
      ctx.fillStyle = MASK;
      for (const row of changedRows) {
        const text = term.buffer.active.getLine(topRow + row)?.translateToString(true) ?? "";
        const value = /TOKEN=(\S+)/.exec(text);
        if (!value) continue;
        const x = value.index + "TOKEN=".length;
        ctx.fillRect(x * metrics.width, row * metrics.height, value[1].length * metrics.width, metrics.height);
      }
    },
  };
}

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// Runs `steps` over one opened terminal: a frame of its render loop after
/// the first write and after each step, each held to the full frame the
/// terminal paints right after it.
async function run(setup: string, steps: Step[], options: Options = {}): Promise<void> {
  const contexts = new WeakMap<HTMLCanvasElement, CellPictureContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      let context = contexts.get(this);
      if (!context) contexts.set(this, (context = new CellPictureContext(this)));
      return context as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  if (options.ratio !== undefined) vi.stubGlobal("devicePixelRatio", options.ratio);
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({
    ghostty,
    cols: COLS,
    rows: ROWS,
    scrollback: 100,
    theme: THEME,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink ?? false,
    boxGlyphs: options.glyphs,
    scrollbar: options.glyphs ? "overlay" : undefined,
    smoothScrollDuration: 0,
    testHooks: { scrollbarOpacity: 0 },
  });
  opened.push(term);
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  const context = contexts.get(host.querySelector("canvas")!)!;
  const { width, height } = term.getMetrics()!;
  context.cell = { width, height };
  if (options.masking) term.addPaintLayer(maskLayer(term));
  // The frames open() painted are kept on the context's default grid; one
  // full frame puts every cell's picture on the measured one.
  term.refresh();

  /// One frame of the render loop: the callbacks queued so far, once.
  const tick = () => {
    for (const callback of frames.splice(0)) callback(performance.now());
  };
  const pictures = () => context.pictures(term.cols, term.rows);

  const rig: Rig = {
    term,
    view(y) {
      if (y < 0) term.viewportY = y;
      else term.viewport.scrollTo(y);
    },
    picture(viewportY) {
      const shown = term.getViewportY();
      rig.view(viewportY);
      term.refresh();
      const whole = pictures();
      rig.view(shown);
      term.refresh();
      return whole;
    },
  };

  const check = (label: string) => {
    tick();
    const painted = pictures();
    // The whole picture of the same terminal, the same view and the same
    // renderer state, painted in one frame.
    term.refresh();
    expect(painted, label).toEqual(pictures());
  };

  term.write(setup);
  check("the first frame");
  for (const [i, step] of steps.entries()) {
    if (typeof step === "string") term.write(step);
    else await step(rig);
    check(`after step ${i}: ${typeof step === "string" ? JSON.stringify(step) : step.toString()}`);
  }
}

const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(2, "0")} ${"abcdefghij".slice(0, 2 + (i % 8))}`).join("\r\n");

/// A step that scrolls the view back `y` rows into the history.
const at = (y: number) => (r: Rig) => r.view(y);

/// DECTCEM hides and shows the cursor where it stands (`tput civis` at an
/// idle prompt); the core marks no row dirty for it.
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const TYPING: Step[] = [
  "e", "c", "h", "o", " hi", "\b", "\b \b", "i", "\r\n", "hi\r\n", "$ ", "ls -l", "\x1b[D", "\x1b[D", "X", "\x1b[C", "\r\n",
];

describe("the ghostty renderer's partial redraws", () => {
  test("typing at a prompt and running a command", async () => {
    await run("$ ", TYPING);
  });

  test.each(["underline", "bar"] as const)("typing with a %s cursor", async (cursorStyle) => {
    await run("$ ", TYPING, { cursorStyle });
  });

  test("a status line rewritten in place over a full screen", async () => {
    const status = (n: number) => `\x1b7\x1b[1;1H\x1b[7m status ${n} \x1b[0m\x1b[K\x1b8`;
    await run(lines(ROWS + 4), [status(1), status(2), status(3), "\x1b[5;3H\x1b[31mred\x1b[0m", status(4), "\x1b[8;1H\x1b[2K$ "]);
  });

  test("erases, inserts and deletes", async () => {
    await run(lines(ROWS), [
      "\x1b[3;5H\x1b[K",
      "\x1b[4;5H\x1b[1K",
      "\x1b[2;3H\x1b[2@",
      "\x1b[2;3H\x1b[3P",
      "\x1b[5;1H\x1b[L",
      "\x1b[3;1H\x1b[2M",
      "\x1b[6;4H\x1b[44m\x1b[5X\x1b[0m",
      "\x1b[7;1H\x1b[J",
      "\x1b[2;10H\x1b[1J",
      "\x1b[2J",
    ]);
  });

  test("a scroll region scrolls", async () => {
    await run(lines(ROWS), ["\x1b[2;5r", "\x1b[5;1H", "\n", "\nnew", "\x1b[2;1H\x1bM", "\x1b[2;1H\x1bMtop", "\x1b[r", "\x1b[8;1H\n\nend"]);
  });

  test("wide characters and clusters are overwritten", async () => {
    await run("\x1b[1;1H漢字かな", [
      "\x1b[1;1Ha",
      "\x1b[1;4Hb",
      "\x1b[2;1Hé ñ ä",
      "\x1b[2;1Hx",
      "\x1b[2;3H\x1b[31my\x1b[0m",
      `\x1b[3;${COLS}H漢`,
      "\x1b[6;1H\u{1f44d}\u{1f3fd} ok \u{1f468}‍\u{1f469}‍\u{1f467}",
      "\x1b[6;1H\x1b[2K",
      "\x1b[7;1H\x1b[4m漢\x1b[0m\x1b[7m字\x1b[0m",
      "\x1b[7;2Hz",
    ]);
  });

  test("the alternate screen comes and goes", async () => {
    await run("primary text\r\nmore", ["\x1b[?1049h", "\x1b[2J\x1b[Halt one", "\x1b[3;3Halt two", "\x1b[?1049l", " back", "\x1b[?1049h\x1b[2J", "\x1b[?1049l"]);
  });

  test("a resize and back", async () => {
    await run(lines(ROWS + 2), [
      (r) => r.term.resize(24, 6),
      "after",
      (r) => r.term.resize(12, 8),
      "\x1b[1;1Hx",
      (r) => r.term.resize(COLS, ROWS),
      "y",
    ]);
  });

  test("the colours change under painted rows", async () => {
    const styled = "\x1b[31mred\x1b[0m \x1b[42mgreen\x1b[0m \x1b[38;5;208m208\x1b[0m plain\r\n\x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m";
    await run(styled, [
      (r) =>
        r.term.setTheme({ ...THEME, background: "#fafafa", foreground: "#202020", black: "#000000", red: "#aa0000", green: "#00aa00" }),
      "\x1b]4;1;rgb:00/ff/00\x07",
      "\x1b]11;rgb:20/20/40\x07",
      "\x1b]10;rgb:ff/ff/00\x07",
    ]);
  });

  test("scrolled back and to the bottom again", async () => {
    await run(lines(ROWS + 12), [at(3), at(5), "x", at(12), at(0), "y", at(1), at(0), "\r\nz"]);
  });

  // chan's macOS pixel scroll (the workspace app's
  // terminal/ghosttyViewport.ts) moves the view by fractions of a row. Every
  // reader of the offset floors it (the hover, the selection, a mask layer's
  // top row), so the view shows the rows of the floor: at 2.5 and just below
  // 3 those of 2, at 0.5 the screen and its cursor, which a hide takes away
  // there as at the bottom.
  const JUST_BELOW_3 = 3 - 1e-9;
  const floored = (y: number) => (r: Rig) => {
    expect(r.picture(y), `the picture at ${y}`).toEqual(r.picture(Math.floor(y)));
  };

  test.each([
    [3, 2.5],
    [0, 0.5],
    [3, JUST_BELOW_3],
  ])("scrolled back from %s rows to %s, a fraction of a row", async (from, to) => {
    await run(lines(ROWS + 12), [at(from), at(to), floored(to), HIDE, floored(to), SHOW, "x", at(from), at(to), "\r\ny", at(0)]);
  });

  // The terminal clamps its own offset at 0, but an offset below it handed
  // to the renderer shows the bottom view, masked values masked, as the
  // hover, the selection and a mask layer's top row read it.
  const bottom = (y: number) => (r: Rig) => {
    expect(r.picture(y), `the picture at ${y}`).toEqual(r.picture(0));
  };

  test("an offset below zero shows the bottom view", async () => {
    await run(lines(ROWS + 12), [at(-0.5), bottom(-0.5), at(-2), bottom(-2), "x", at(0)]);
  });

  test("an offset below zero masks a value on the screen where it shows", async () => {
    await run(`${lines(ROWS + 3)}\r\nexport TOKEN=abcdef`, [at(-0.5), bottom(-0.5), at(-1), bottom(-1)], { masking: true });
  });

  // chan's viewport controller keeps a fraction less than a row back under
  // output (the workspace app's terminal/ghosttyViewport.ts): the frames that
  // follow paint the bottom view, the prompt the output ends on and its
  // cursor.
  test("output written while the view rests a fraction back paints the bottom view and its cursor", async () => {
    const cursorShown = (y: number) => (r: Rig) => {
      const { x, y: row } = r.term.getCursor()!;
      expect(r.picture(y)[row][x].join(" | "), `the cursor at ${y}`).toContain(`fill ${THEME.cursor}`);
    };
    await run(`${lines(ROWS + 12)}\r\n$ `, [
      at(0.3), "out 1\r\n$ ", bottom(0.3), cursorShown(0.3),
      "out 2\r\nout 3\r\n$ ", bottom(0.3),
      at(0.999), "out 4\r\n$ ", bottom(0.999), cursorShown(0.999),
    ]);
  });

  test("a masked value in the history scrolled back by a fraction of a row", async () => {
    // The value's row is history row 3 of 7: at an offset of 5 it shows on
    // view row 1, where the mask layer's top row finds it too.
    const masked = (y: number, row: number) => (r: Rig) => {
      const value = r.picture(y)[row].slice(13, 19).flat().join("\n");
      expect(value, `the value at ${y}`).toContain("#6c6c70");
      expect(value, `the value at ${y}`).not.toMatch(/text "[a-f]"/);
    };
    await run(`${lines(3)}\r\nexport TOKEN=abcdef\r\n${lines(ROWS + 3)}`, [
      at(5), masked(5, 1),
      at(5.5), floored(5.5), masked(5.5, 1),
      at(4.75), floored(4.75), masked(4.75, 0),
    ], { masking: true });
  });

  test("a link hovered and left", async () => {
    // The pointer over the cell at `col` of view row `row`, and the link
    // lookup it starts settled: hover moves are throttled to one per 16 ms
    // and the lookup resolves asynchronously.
    const over = (col: number, row: number) => async (r: Rig) => {
      const { width, height } = r.term.getMetrics()!;
      const at = { clientX: (col + 0.5) * width, clientY: (row + 0.5) * height };
      r.term.element!.querySelector("canvas")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...at }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const leave = (r: Rig) => void r.term.element!.dispatchEvent(new MouseEvent("mouseleave"));
    // The OSC 8 link on row 0 and the text after it, the URL on row 1 that
    // wraps onto row 2, and an empty row.
    const [link, text, url, empty] = [over(1, 0), over(7, 0), over(3, 1), over(0, 5)];
    await run(
      "\x1b]8;;https://e.x/a\x1b\\link\x1b]8;;\x1b\\ text\r\nhttps://plain.example/b\r\n\x1b]8;;https://e.x/c\x1b\\other\x1b]8;;\x1b\\",
      [link, text, url, empty, link, "\x1b[5;1Hmore", leave],
    );
  });

  // The screen holds no history, so a view row is its absolute row.
  const range = (startCol: number, startRow: number, endCol: number, endRow: number) => ({
    start: { col: startCol, absoluteRow: startRow },
    end: { col: endCol, absoluteRow: endRow },
  });
  const call = (f: (term: Terminal) => void) => (r: Rig) => f(r.term);

  test("a selection set, moved and dropped", async () => {
    await run(lines(ROWS), [
      call((t) => t.setSelection(range(3, 1, 6, 3))),
      call((t) => t.setSelection(range(0, 2, 19, 5))),
      "\x1b[4;2Hchanged",
      call((t) => t.setSelection(range(5, 6, 9, 6))),
      call((t) => t.setSelection(null)),
    ]);
  });

  test.each([
    ["select", call((t) => t.select(4, 1, COLS + 10)), call((t) => t.select(2, 5, 6))],
    ["selectLines", call((t) => t.selectLines(0, 1)), call((t) => t.selectLines(5, 6))],
  ])("%s moves a selection to other rows", async (_name, first, second) => {
    await run(lines(ROWS), [first, second]);
  });

  test("a selection made, moved, dropped and made again", async () => {
    await run(lines(ROWS), [
      call((t) => t.select(4, 1, COLS + 10)),
      call((t) => t.select(2, 3, COLS * 2 + 6)),
      call((t) => t.selectLines(6, 7)),
      "\x1b[7;2Hchanged",
      call((t) => t.selectLines(0, 2)),
      call((t) => t.clearSelection()),
      call((t) => t.select(6, 5, 12)),
      call((t) => t.selectAll()),
      call((t) => t.select(0, 7, 3)),
    ]);
  });

  test("a blinking cursor through its phases, a write and a move", async () => {
    // The renderer blinks on an interval it starts when it is built.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const blink = () => vi.advanceTimersByTime(530);
    await run("$ ", [blink, blink, "x", blink, "\x1b[2;3H", blink, blink, "y"], { cursorBlink: true });
  });

  test("the cursor moves without a write", async () => {
    await run(lines(ROWS - 2), ["\x1b[2;2H", "\x1b[2;8H", "\x1b[7;1H", "\x1b[1;20H", "\x1b[A", "\x1b[3B"]);
  });

  // Hidden and shown where it stands (HIDE, SHOW). The prompt is on row 4,
  // two rows below the nearest row the status write repaints.
  const PROMPT = "$ ls\r\na\r\nb\r\nc\r\n$ ";
  const ELSEWHERE = "\x1b7\x1b[1;1Hstatus\x1b8";

  test.each(["block", "underline", "bar"] as const)("a %s cursor hidden where it stands", async (cursorStyle) => {
    await run(PROMPT, [HIDE], { cursorStyle });
  });

  test("a hidden cursor shown where it stands", async () => {
    await run(PROMPT + HIDE, [SHOW]);
  });

  test("a cursor hidden as a write lands on another row", async () => {
    await run(PROMPT, [ELSEWHERE + HIDE]);
  });

  test("a cursor hidden, written under, moved and shown again", async () => {
    await run(PROMPT, [HIDE, "x", SHOW, HIDE + "\x1b[1;3H", SHOW, "\x1b[5;4H", ELSEWHERE + HIDE, ELSEWHERE + SHOW]);
  });

  test("a blinking cursor hidden and shown where it stands", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const blink = () => vi.advanceTimersByTime(530);
    await run(PROMPT, [HIDE, blink, SHOW, blink, blink, HIDE, blink, ELSEWHERE + SHOW], { cursorBlink: true });
  });

  test("box and block glyphs at a device pixel ratio of two", async () => {
    await run(
      "\x1b[?25l┌──┐\r\n│██│\r\n└──┘ ╭─╮\r\n▀▄▌▐ ░▒▓",
      ["\x1b[2;2H▀", "\x1b[2;3H\x1b[2m░\x1b[0m", "\x1b[3;7H\x1b[31m┼\x1b[0m", "\x1b[1;1H\x1b[2K", "\x1b[5;1H\x1b[7m█\x1b[0m─│"],
      { ratio: 2, glyphs: true },
    );
  });

  test("a masked value typed a character at a time", async () => {
    await run("$ ", ["export TOKEN=", "a", "b", "c", "\r\n", "x", "\x1b[1;14Hd"], { masking: true });
  });
});
