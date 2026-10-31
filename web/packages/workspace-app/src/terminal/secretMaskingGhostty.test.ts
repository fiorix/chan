// The ghostty secret mask painter: it hooks the renderer's render, reads the
// visible rows and the rows they wrap with at the offset ghostty draws, and
// fills each span onto the canvas after the frame's content. The fake
// buffer suites drive the hook the way ghostty-web's render loop does; the
// real-build suite runs the pinned wasm terminal and renderer over the
// software canvas and reads the pixels back.

import { CanvasRenderer, Ghostty, Terminal } from "ghostty-web";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expectPixel, SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { GhosttySecretMasker, type GhosttyMaskTerminal } from "./secretMaskingGhostty";

const MASK = "#6c6c70";
const CELL = { width: 8, height: 19, baseline: 13 };

class FakeCell {
  constructor(readonly char: string) {}
  getWidth() {
    return 1;
  }
  getChars() {
    return this.char === " " ? "" : this.char;
  }
}

class FakeLine {
  constructor(
    public text: string,
    readonly cols: number,
    public isWrapped = false,
  ) {}

  get length() {
    return this.cols;
  }

  getCell(x: number) {
    if (x < 0 || x >= this.cols) return undefined;
    return new FakeCell(this.text[x] ?? " ");
  }

  translateToString(_trimRight = false, start = 0, end = this.cols) {
    let out = "";
    for (let x = start; x < end; x += 1) out += this.text[x] ?? " ";
    return out;
  }
}

type Fill = { x: number; y: number; width: number; height: number; color: string };

/// A ghostty terminal as the painter sees it: a buffer of lines, the
/// renderer with the context it paints on and the render it wraps, and the
/// dirty state the parser would report for the frame.
function ghosttyTerminal(options: {
  cols: number;
  rows: number;
  lines: FakeLine[];
  type?: "normal" | "alternate";
  withContext?: boolean;
}) {
  const { cols, rows, lines } = options;
  const fills: Fill[] = [];
  let reads = 0;
  const context = {
    fillStyle: "#000000",
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ x, y, width, height, color: this.fillStyle });
    },
  };
  const original = vi.fn();
  const renderer: Record<string, unknown> = {
    getMetrics: () => ({ ...CELL }),
    render: original,
  };
  if (options.withContext !== false) renderer.ctx = context;
  const active = {
    type: options.type ?? "normal",
    get length() {
      return lines.length;
    },
    getLine(y: number) {
      reads += 1;
      return lines[y];
    },
  };
  let viewportY = 0;
  const dirty = new Set<number>();
  let fullRedraw = false;
  const term = {
    buffer: { active },
    renderer,
    getViewportY: () => viewportY,
  } as unknown as GhosttyMaskTerminal;
  const renderable = {
    getDimensions: () => ({ cols, rows }),
    isRowDirty: (row: number) => dirty.has(row),
    needsFullRedraw: () => fullRedraw,
  };
  return {
    term,
    active,
    renderer,
    original,
    context,
    lines,
    scroll(to: number) {
      viewportY = to;
    },
    markDirty(...rows: number[]) {
      for (const row of rows) dirty.add(row);
    },
    markFullRedraw() {
      fullRedraw = true;
    },
    /// One frame as ghostty-web's render loop issues it. Returns the fills
    /// the painter made after the frame's content, and how many lines it
    /// read from the buffer for it.
    frame(forceAll = false): { fills: Fill[]; reads: number; forcedRedraw: boolean } {
      fills.length = 0;
      reads = 0;
      original.mockClear();
      (renderer.render as (...args: unknown[]) => void)(renderable, forceAll, viewportY, term, 0);
      dirty.clear();
      fullRedraw = false;
      expect(original).toHaveBeenCalledOnce();
      return { fills: [...fills], reads, forcedRedraw: original.mock.calls[0][1] === true };
    },
  };
}

function cells(x: number, row: number, width: number, color = MASK): Fill {
  return { x: x * CELL.width, y: row * CELL.height, width: width * CELL.width, height: CELL.height, color };
}

describe("ghostty secret masking over a fake buffer", () => {
  test("masks a NAME=value line on the row ghostty draws it, in the frame that draws it", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=cleartext", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    const frame = screen.frame();
    expect(frame.fills).toEqual([cells(6, 0, 9)]);
    expect(frame.forcedRedraw).toBe(false);
    expect(masker.maskCount).toBe(1);
    expect(screen.lines[0].text).toBe("TOKEN=cleartext");
    // The painter's fill comes after the content: the original render ran
    // before the fill was made, and the mask paints with its own colour
    // under a saved and restored context state.
    expect(screen.context.save).toHaveBeenCalledOnce();
    expect(screen.context.restore).toHaveBeenCalledOnce();
  });

  test("a value that wraps onto the next screen row masks on both rows", () => {
    const screen = ghosttyTerminal({ cols: 12, rows: 3, lines: [new FakeLine("NAME_TOKEN=a", 12), new FakeLine("bcdef", 12, true), new FakeLine("", 12)] });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toEqual([cells(11, 0, 1), cells(0, 1, 5)]);
  });

  test("a viewport scrolled by whole rows reads the scrollback and shifts the rows", () => {
    const lines = ["x", "TOKEN=abc", "y", "z", "w", "p", "q", "r"].map((text) => new FakeLine(text, 20));
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toEqual([]);
    // Five scrollback lines over three rows: four back shows lines 1..3.
    screen.scroll(4);
    expect(screen.frame().fills).toEqual([cells(6, 0, 3)]);
    screen.scroll(3);
    expect(screen.frame().fills).toEqual([]);
    screen.scroll(5);
    expect(screen.frame().fills).toEqual([cells(6, 1, 3)]);
  });

  test("a fractional viewport offset maps rows as its floor does", () => {
    const lines = ["x", "TOKEN=abc", "y", "z", "w", "p", "q", "r"].map((text) => new FakeLine(text, 20));
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.scroll(4.5);
    expect(screen.frame().fills).toEqual([cells(6, 0, 3)]);
    screen.scroll(3.5);
    expect(screen.frame().fills).toEqual([]);
    screen.scroll(4.999);
    expect(screen.frame().fills).toEqual([cells(6, 0, 3)]);
  });

  test("a scrollback line filled to its last column reads as wrapping into the next", () => {
    // ghostty-web's buffer reports no wrap flag for a scrollback line, so both read
    // unwrapped; the first is full, which is what a soft wrap leaves.
    const wrapped = [new FakeLine("NAME_TOKEN=a", 12), new FakeLine("bcdef", 12), new FakeLine("", 12), new FakeLine("", 12), new FakeLine("", 12)];
    const screen = ghosttyTerminal({ cols: 12, rows: 3, lines: wrapped });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.scroll(2);
    expect(screen.frame().fills).toEqual([cells(11, 0, 1), cells(0, 1, 5)]);

    // The same two lines with the first one short: no soft wrap could have
    // left it, so they are two lines and the second masks nothing.
    const separate = [new FakeLine("NAME_TOKEN=", 12), new FakeLine("bcdef", 12), new FakeLine("", 12), new FakeLine("", 12), new FakeLine("", 12)];
    const apart = ghosttyTerminal({ cols: 12, rows: 3, lines: separate });
    new GhosttySecretMasker(apart.term, ["TOKEN"], MASK, true);
    apart.scroll(2);
    expect(apart.frame().fills).toEqual([]);
  });

  test("a group reaches a screenful above the viewport and no further", () => {
    // A value whose name sits two rows above the top of a three-row
    // viewport is still joined; one four rows above is not.
    // The first three lines are scrollback and read unwrapped; "z" is the
    // first screen row and carries the parser's flag.
    const near = [new FakeLine("", 12), new FakeLine("NAME_TOKEN=a", 12), new FakeLine("bcdefghijklm", 12), new FakeLine("nopqrstuvwxy", 12), new FakeLine("z", 12, true), new FakeLine("", 12), new FakeLine("", 12)];
    const screen = ghosttyTerminal({ cols: 12, rows: 3, lines: near });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    // Four scrollback lines; one back shows lines 3..5.
    screen.scroll(1);
    expect(screen.frame().fills).toEqual([cells(0, 0, 12), cells(0, 1, 1)]);

    const far = [new FakeLine("NAME_TOKEN=a", 12), new FakeLine("bcdefghijklm", 12), new FakeLine("nopqrstuvwxy", 12), new FakeLine("zabcdefghijk", 12), new FakeLine("lmnopqrstuvw", 12), new FakeLine("x", 12, true), new FakeLine("", 12), new FakeLine("", 12)];
    const beyond = ghosttyTerminal({ cols: 12, rows: 3, lines: far });
    new GhosttySecretMasker(beyond.term, ["TOKEN"], MASK, true);
    // Five scrollback lines; one back shows lines 4..6, four rows under the name.
    beyond.scroll(1);
    expect(beyond.frame().fills).toEqual([]);
  });

  test("the alternate screen reads its own rows at offset zero", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, type: "alternate", lines: [new FakeLine("", 20), new FakeLine("TOKEN=abc", 20), new FakeLine("", 20)] });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toEqual([cells(6, 1, 3)]);
  });

  test("an idle frame repaints the cached spans without reading the buffer", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    const first = screen.frame();
    expect(first.reads).toBeGreaterThan(0);
    const idle = screen.frame();
    expect(idle.reads).toBe(0);
    expect(idle.fills).toEqual([cells(6, 0, 3)]);

    // A row the parser marked dirty is read again, and the spans follow
    // the new text.
    screen.lines[0].text = "TOKEN=abcdef";
    const stale = screen.frame();
    expect(stale.reads).toBe(0);
    expect(stale.fills).toEqual([cells(6, 0, 3)]);
    screen.markDirty(0);
    const fresh = screen.frame();
    expect(fresh.reads).toBeGreaterThan(0);
    expect(fresh.fills).toEqual([cells(6, 0, 6)]);

    // So is a frame the parser wants fully redrawn, and a forced one.
    screen.lines[0].text = "TOKEN=ab";
    screen.markFullRedraw();
    expect(screen.frame().fills).toEqual([cells(6, 0, 2)]);
    screen.lines[0].text = "TOKEN=a";
    expect(screen.frame(true).fills).toEqual([cells(6, 0, 1)]);
  });

  test("scanAll and scanViewport force the next frame to read again", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.frame();
    screen.lines[0].text = "TOKEN=abcd";
    masker.scanViewport();
    expect(screen.frame().fills).toEqual([cells(6, 0, 4)]);
    screen.lines[0].text = "TOKEN=abcde";
    masker.scanAll();
    expect(screen.frame().fills).toEqual([cells(6, 0, 5)]);
    // The write hooks are no-ops: the parser's dirty rows carry a write.
    expect(masker.captureWrite()).toBeNull();
    masker.scanWrite(null);
    expect(screen.frame().reads).toBe(0);
  });

  test("masking toggled off redraws the rows it covered and paints nothing", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toHaveLength(1);
    masker.setEnabled(false);
    expect(masker.enabled).toBe(false);
    expect(masker.maskCount).toBe(0);
    const off = screen.frame();
    expect(off.fills).toEqual([]);
    expect(off.forcedRedraw).toBe(true);
    expect(off.reads).toBe(0);
    expect(screen.frame().forcedRedraw).toBe(false);
    masker.setEnabled(true);
    expect(screen.frame().fills).toEqual([cells(6, 0, 3)]);
    expect(screen.lines[0].text).toBe("TOKEN=abc");
  });

  test("a colour change paints the next frame in the new colour", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.frame();
    masker.setColor("#57606a");
    expect(screen.frame().fills).toEqual([cells(6, 0, 3, "#57606a")]);
  });

  test("a renderer without its context fails loud, leaves the render alone, and the toggle retries", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, withContext: false, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const onError = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(screen.renderer.render).toBe(screen.original);
    expect(error).toHaveBeenCalledWith("ghostty secret masking render hook unavailable", "");
    masker.setEnabled(true);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(masker.enabled).toBe(false);
  });

  test("a throwing buffer read disables masking, redraws, and keeps the frame", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true, onError);
    expect(screen.frame().fills).toHaveLength(1);
    const boom = new Error("wasm memory gone");
    screen.active.getLine = () => {
      throw boom;
    };
    screen.markDirty(0);
    const failed = screen.frame();
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(failed.fills).toEqual([]);
    expect(failed.forcedRedraw).toBe(true);
    // Later frames render without the painter until it is re-enabled.
    const after = screen.frame();
    expect(after.fills).toEqual([]);
    expect(after.forcedRedraw).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("a throwing paint fails loud after the frame's content is drawn", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true, onError);
    screen.context.fillRect = () => {
      throw new Error("context lost");
    };
    screen.frame();
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(screen.frame().forcedRedraw).toBe(true);
  });

  test("dispose hands the renderer its render back", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.renderer.render).not.toBe(screen.original);
    masker.dispose();
    expect(screen.renderer.render).toBe(screen.original);
    expect(masker.maskCount).toBe(0);
    masker.setEnabled(true);
    expect(screen.renderer.render).toBe(screen.original);
  });
});

describe("ghostty secret masking over the pinned build", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const COLS = 20;
  const ROWS = 4;
  const BACKGROUND = { r: 16, g: 16, b: 16, a: 1 };
  const MASKED = { r: 0x6c, g: 0x6c, b: 0x70, a: 1 };

  /// The real wasm terminal and renderer, wired the way Terminal.open()
  /// wires them, without the DOM and the render loop open() starts: the
  /// test issues the frames. The software canvas records what the renderer
  /// and the painter fill.
  async function pinnedTerminal() {
    const contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        const existing = contexts.get(this);
        if (existing) return existing as unknown as CanvasRenderingContext2D;
        const created = new SoftwareCanvasContext(this, CELL.width);
        contexts.set(this, created);
        return created as unknown as CanvasRenderingContext2D;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const ghostty = await Ghostty.load();
    const term = new Terminal({ ghostty, cols: COLS, rows: ROWS });
    term.wasmTerm = ghostty.createTerminal(COLS, ROWS, { scrollbackLimit: 100 });
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, {
      devicePixelRatio: 1,
      theme: { background: "#101010", foreground: "#e0e0e0" },
    });
    renderer.resize(COLS, ROWS);
    term.renderer = renderer;
    const context = contexts.get(canvas)!;
    return {
      term,
      write(text: string) {
        term.wasmTerm!.write(text);
      },
      frame() {
        renderer.render(term.wasmTerm!, false, term.getViewportY(), term, 0);
      },
      /// The pixel at the centre of a cell, in CSS coordinates.
      pixel(x: number, row: number) {
        return context.pixelAt((x + 0.5) * renderer.getMetrics().width, (row + 0.5) * renderer.getMetrics().height);
      },
    };
  }

  test("masks a value through the real buffer wrapper and paints the real canvas", async () => {
    const screen = await pinnedTerminal();
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.write("TOKEN=abc\r\n");
    screen.frame();
    expect(masker.maskCount).toBe(1);
    expectPixel(screen.pixel(5, 0), BACKGROUND);
    expectPixel(screen.pixel(6, 0), MASKED);
    expectPixel(screen.pixel(8, 0), MASKED);
    expectPixel(screen.pixel(9, 0), BACKGROUND);
    expect(screen.term.buffer.active.getLine(0)?.translateToString(true)).toBe("TOKEN=abc");
  });

  test("a wrapped value masks on both screen rows, then on both scrollback lines", async () => {
    const screen = await pinnedTerminal();
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.write("NAME_TOKEN=abcdefghijklmnop\r\n");
    screen.frame();
    expect(masker.maskCount).toBe(2);
    expectPixel(screen.pixel(10, 0), BACKGROUND);
    expectPixel(screen.pixel(11, 0), MASKED);
    expectPixel(screen.pixel(19, 0), MASKED);
    expectPixel(screen.pixel(0, 1), MASKED);
    expectPixel(screen.pixel(6, 1), MASKED);
    expectPixel(screen.pixel(7, 1), BACKGROUND);

    // Four more lines push both into the scrollback, where the wrap flag
    // is lost; three rows back shows them at the top again, joined from
    // the full first line.
    screen.write("x\r\ny\r\nz\r\nw\r\n");
    screen.term.scrollLines(-3);
    expect(screen.term.getViewportY()).toBe(3);
    expect(screen.term.buffer.active.getLine(0)?.translateToString(true)).toBe("NAME_TOKEN=abcdefghi");
    expect(screen.term.buffer.active.getLine(1)?.isWrapped).toBe(false);
    screen.frame();
    expect(masker.maskCount).toBe(2);
    expectPixel(screen.pixel(10, 0), BACKGROUND);
    expectPixel(screen.pixel(11, 0), MASKED);
    expectPixel(screen.pixel(0, 1), MASKED);
    expectPixel(screen.pixel(6, 1), MASKED);
    expectPixel(screen.pixel(7, 1), BACKGROUND);
  });

  test("a fractional scroll maps the rows as ghostty draws them", async () => {
    const screen = await pinnedTerminal();
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.write("TOKEN=abc\r\nx\r\ny\r\nz\r\nw\r\nv\r\n");
    expect(screen.term.getScrollbackLength()).toBe(3);
    screen.term.scrollLines(-2.5);
    expect(screen.term.getViewportY()).toBe(2.5);
    screen.frame();
    // Two and a half of three lines back: the value line is above the top.
    expect(masker.maskCount).toBe(0);
    expectPixel(screen.pixel(6, 0), BACKGROUND);
    screen.term.scrollLines(-0.5);
    expect(screen.term.getViewportY()).toBe(3);
    screen.frame();
    expect(masker.maskCount).toBe(1);
    expectPixel(screen.pixel(6, 0), MASKED);
  });

  test("the alternate screen masks its own rows and the toggle clears them", async () => {
    const screen = await pinnedTerminal();
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.write("history\r\n\x1b[?1049h\x1b[2;1HTOKEN=abc");
    screen.frame();
    expect(screen.term.buffer.active.type).toBe("alternate");
    expect(masker.maskCount).toBe(1);
    expectPixel(screen.pixel(6, 1), MASKED);
    masker.setEnabled(false);
    screen.frame();
    expectPixel(screen.pixel(6, 1), BACKGROUND);
    masker.setEnabled(true);
    screen.frame();
    expectPixel(screen.pixel(6, 1), MASKED);
  });
});
