// The ghostty widget's renderer repaints only the rows a frame needs: the
// rows the core marked dirty, the cursor's rows, the selection's and a
// hovered link's, and their neighbours. These tests hold every frame of a run
// of small changes to what one frame that repaints everything would leave:
// after each frame of the renderer under test, a fresh renderer paints the
// same terminal whole, and the two canvases must show the same calls in every
// cell (cellPictureCanvas.ts). A frame that repaints too little leaves a cell
// showing what it held before, which no single full frame can show.

import { readFileSync } from "node:fs";
import { CanvasRenderer, SelectionManager, Terminal, type ITheme } from "@chan/ghostty-web-ng";
import { GhosttyVt, type VtTerminal } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { CellPictureContext, type CellPictures } from "../__tests__/cellPictureCanvas";
import { installGhosttyCustomGlyphs, installGhosttyOverlayScrollbar } from "./ghosttyCompat";
import { DEFAULT_SECRET_MASK_SUFFIXES } from "./secretMasking";
import { GhosttySecretMasker } from "./secretMaskingGhostty";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 8;

const THEME: ITheme = {
  background: "#101010",
  foreground: "#e0e0e0",
  cursor: "#58a6ff",
  selectionBackground: "rgba(88, 166, 255, 0.35)",
};

type Coords = { startCol: number; startRow: number; endCol: number; endRow: number };

/// The renderer's view of a selection: the coordinates it paints and the
/// rows a moved or dropped selection leaves to repaint.
class Selection {
  coords: Coords | null = null;
  readonly dirty = new Set<number>();
  hasSelection(): boolean {
    return this.coords !== null;
  }
  getSelectionCoords(): Coords | null {
    return this.coords;
  }
  getDirtySelectionRows(): Set<number> {
    return this.dirty;
  }
  clearDirtySelectionRows(): void {
    this.dirty.clear();
  }
  set(coords: Coords | null): void {
    if (this.coords) for (let row = this.coords.startRow; row <= this.coords.endRow; row++) this.dirty.add(row);
    this.coords = coords;
  }
}

type Options = {
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  ratio?: number;
  glyphs?: boolean;
  masking?: boolean;
};

type Painter = {
  term: Terminal;
  renderer: CanvasRenderer;
  context: CellPictureContext;
};

type Rig = {
  core: VtTerminal;
  painter: Painter;
  selection: Selection;
  theme: ITheme;
  resize(cols: number, rows: number): void;
  /// What one full frame of a fresh renderer paints of the terminal
  /// scrolled back `viewportY` rows. It ends a frame of the core, so a step
  /// takes it only when the core has changed nothing since the last check.
  picture(viewportY: number): CellPictures;
};

/// A step of a run: bytes the program writes, or a change made to the rig.
type Step = string | ((rig: Rig) => void);

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/// Runs `steps` over one terminal: a frame of the renderer under test after
/// the first write and after each step, each held to a full frame of a
/// fresh renderer over the same terminal.
async function run(setup: string, steps: Step[], options: Options = {}): Promise<void> {
  const contexts = new WeakMap<HTMLCanvasElement, CellPictureContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      let context = contexts.get(this);
      if (!context) {
        context = new CellPictureContext(this);
        contexts.set(this, context);
      }
      return context as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const core = vt.createTerminal(COLS, ROWS, { scrollbackLimit: 100 });
  let cols = COLS;
  let rows = ROWS;
  const selection = new Selection();

  /// A terminal over the core with a renderer of its own, wired as
  /// Terminal.open() and TerminalTab wire them.
  const paint = (theme: ITheme): Painter => {
    const term = new Terminal({ ghostty: vt, cols, rows });
    term.wasmTerm = core;
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, {
      devicePixelRatio: options.ratio ?? 1,
      cursorStyle: options.cursorStyle,
      cursorBlink: options.cursorBlink,
      theme,
    });
    renderer.resize(cols, rows);
    term.renderer = renderer;
    const context = contexts.get(canvas)!;
    const { width, height } = renderer.getMetrics();
    context.cell = { width, height };
    if (options.glyphs) {
      expect(installGhosttyCustomGlyphs(renderer)).toBe(true);
      expect(installGhosttyOverlayScrollbar(renderer)).toBe(true);
    }
    if (options.masking) new GhosttySecretMasker(term as never, DEFAULT_SECRET_MASK_SUFFIXES, "#6c6c70", true);
    return { term, renderer, context };
  };

  const rig: Rig = {
    core,
    painter: paint(THEME),
    selection,
    theme: THEME,
    resize(c, r) {
      cols = c;
      rows = r;
      core.resize(c, r);
    },
    picture(viewportY) {
      const fresh = paint(rig.theme);
      (fresh.term as unknown as { viewportY: number }).viewportY = viewportY;
      frame(fresh, true);
      fresh.renderer.dispose();
      return fresh.context.pictures(cols, rows);
    },
  };
  rig.painter.renderer.setSelectionManager(selection as never);
  const viewport = (painter: Painter) => (painter.term as unknown as { viewportY: number }).viewportY;

  /// One frame as the widget's render loop issues it.
  const frame = (painter: Painter, forceAll: boolean) => {
    painter.renderer.render(core, forceAll, painter.term.getViewportY(), 0);
    core.getCursor();
  };

  const check = (label: string) => {
    const { painter } = rig;
    frame(painter, false);
    // The whole picture of the same terminal, the same view and the same
    // renderer state, painted in one frame.
    const whole = paint(rig.theme);
    (whole.term as unknown as { viewportY: number }).viewportY = viewport(painter);
    // The selection the renderer under test reads: the rig's, or
    // ghostty-web's own once a step installs it.
    const shown = (painter.renderer as unknown as { selectionManager: { getSelectionCoords(): Coords | null } }).selectionManager;
    const fresh = new Selection();
    fresh.coords = shown.getSelectionCoords();
    whole.renderer.setSelectionManager(fresh as never);
    const hover = painter.renderer as unknown as { hoveredHyperlinkId: number; hoveredLinkRange: unknown; cursorVisible: boolean };
    whole.renderer.setHoveredHyperlinkId(hover.hoveredHyperlinkId);
    whole.renderer.setHoveredLinkRange(hover.hoveredLinkRange as never);
    (whole.renderer as unknown as { cursorVisible: boolean }).cursorVisible = hover.cursorVisible;
    frame(whole, true);
    whole.renderer.dispose();
    expect(painter.context.pictures(cols, rows), label).toEqual(whole.context.pictures(cols, rows));
  };

  core.write(setup);
  check("the first frame");
  for (const [i, step] of steps.entries()) {
    if (typeof step === "string") core.write(step);
    else step(rig);
    check(`after step ${i}: ${typeof step === "string" ? JSON.stringify(step) : step.toString()}`);
  }
  rig.painter.renderer.dispose();
}

const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(2, "0")} ${"abcdefghij".slice(0, 2 + (i % 8))}`).join("\r\n");

/// A step that scrolls the view back `y` rows into the history.
const at = (y: number) => (r: Rig) => {
  (r.painter.term as unknown as { viewportY: number }).viewportY = y;
};

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
      (r) => r.resize(24, 6),
      "after",
      (r) => r.resize(12, 8),
      "\x1b[1;1Hx",
      (r) => r.resize(COLS, ROWS),
      "y",
    ]);
  });

  test("the colours change under painted rows", async () => {
    const styled = "\x1b[31mred\x1b[0m \x1b[42mgreen\x1b[0m \x1b[38;5;208m208\x1b[0m plain\r\n\x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m";
    await run(styled, [
      (r) => {
        r.theme = { ...THEME, background: "#fafafa", foreground: "#202020" };
        r.painter.renderer.setTheme(r.theme);
        r.core.setColors({ fgColor: 0x202020, bgColor: 0xfafafa, palette: [0, 0xaa0000, 0x00aa00] });
      },
      "\x1b]4;1;rgb:00/ff/00\x07",
      "\x1b]11;rgb:20/20/40\x07",
      "\x1b]10;rgb:ff/ff/00\x07",
    ]);
  });

  test("scrolled back and to the bottom again", async () => {
    await run(lines(ROWS + 12), [at(3), at(5), "x", at(12), at(0), "y", at(1), at(0), "\r\nz"]);
  });

  // chan's macOS pixel scroll moves the view by fractions of a row
  // (ghosttyViewport.ts). Every reader of the offset floors it (the hover,
  // the selection, the masker), so the view shows the rows of the floor:
  // at 2.5 and just below 3 those of 2, at 0.5 the screen and its cursor,
  // which a hide takes away there as at the bottom.
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

  // ghostty-web clamps its own offset at 0, but an offset below it handed
  // to the renderer shows the bottom view, masked values masked, as the
  // hover, the selection and the masker read it.
  const bottom = (y: number) => (r: Rig) => {
    expect(r.picture(y), `the picture at ${y}`).toEqual(r.picture(0));
  };

  test("an offset below zero shows the bottom view", async () => {
    await run(lines(ROWS + 12), [at(-0.5), bottom(-0.5), at(-2), bottom(-2), "x", at(0)]);
  });

  test("an offset below zero masks a value on the screen where it shows", async () => {
    await run(`${lines(ROWS + 3)}\r\nexport TOKEN=abcdef`, [at(-0.5), bottom(-0.5), at(-1), bottom(-1)], { masking: true });
  });

  test("a masked value in the history scrolled back by a fraction of a row", async () => {
    // The value's row is history row 3 of 7: at an offset of 5 it shows on
    // view row 1, where the masker's floored offset finds it too.
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
    const hover = (id: number) => (r: Rig) => r.painter.renderer.setHoveredHyperlinkId(id);
    const range = (value: { startX: number; startY: number; endX: number; endY: number } | null) => (r: Rig) =>
      r.painter.renderer.setHoveredLinkRange(value);
    await run(
      "\x1b]8;;https://e.x/a\x1b\\link\x1b]8;;\x1b\\ text\r\nhttps://plain.example/b\r\n\x1b]8;;https://e.x/c\x1b\\other\x1b]8;;\x1b\\",
      [hover(1), hover(0), range({ startX: 0, startY: 1, endX: 18, endY: 1 }), range(null), hover(1), "\x1b[5;1Hmore", hover(0)],
    );
  });

  test("a selection moved and dropped", async () => {
    const select = (coords: Coords | null) => (r: Rig) => r.selection.set(coords);
    await run(lines(ROWS), [
      select({ startCol: 3, startRow: 1, endCol: 6, endRow: 3 }),
      select({ startCol: 0, startRow: 2, endCol: 19, endRow: 5 }),
      "\x1b[4;2Hchanged",
      select({ startCol: 5, startRow: 6, endCol: 9, endRow: 6 }),
      select(null),
    ]);
  });

  /// A step that gives the renderer under test ghostty-web's own
  /// SelectionManager, wired as Terminal.open() wires it.
  const ownSelection = (r: Rig) => {
    const manager = new SelectionManager(r.painter.term, r.painter.renderer, r.core, document.createElement("textarea"));
    onTestFinished(() => manager.dispose());
    (r.painter.term as unknown as { selectionManager: SelectionManager }).selectionManager = manager;
    r.painter.renderer.setSelectionManager(manager);
  };
  const call = (f: (term: Terminal) => void) => (r: Rig) => f(r.painter.term);

  test.each([
    ["select", call((t) => t.select(4, 1, COLS + 10)), call((t) => t.select(2, 5, 6))],
    ["selectLines", call((t) => t.selectLines(0, 1)), call((t) => t.selectLines(5, 6))],
  ])("ghostty-web's %s moves a selection to other rows", async (_name, first, second) => {
    await run(lines(ROWS), [ownSelection, first, second]);
  });

  test("ghostty-web's own selection made, moved, dropped and made again", async () => {
    await run(lines(ROWS), [
      ownSelection,
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
