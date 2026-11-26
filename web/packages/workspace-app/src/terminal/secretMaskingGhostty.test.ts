// The ghostty secret mask painter: the widget's mask paint layer. It reads
// the visible rows and the rows they wrap with at the offset ghostty draws,
// and fills each span onto the canvas after the frame's content. The fake
// buffer suites stand in for the widget's side of that contract (when it
// calls a layer, what it clips, what a registration or a refresh repaints);
// the real-build suite opens the widget over chan's binding on the vendored
// core, over the software canvas, and reads the pixels back.

import { readFileSync } from "node:fs";
import { Terminal, type PaintFrame, type PaintLayer } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { expectPixel, SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { GhosttySecretMasker, type GhosttyMaskTerminal } from "./secretMaskingGhostty";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
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

/// What one frame left: the fills that landed on the rows the frame
/// repainted, how many lines the painter read for it, whether the frame
/// repainted every row, and whether it reached the layer at all.
type Frame = { fills: Fill[]; reads: number; full: boolean; painted: boolean };

/// A ghostty terminal as the painter sees it: a buffer of lines and the
/// widget's paint-layer contract. A frame calls the layers only when it
/// repaints rows, after their content, with the canvas clipped to those rows
/// and its state saved around each layer; adding or removing a layer, a
/// viewport move, and a refresh asked for while painting each make the next
/// frame repaint every row; a refresh outside a frame repaints every row at
/// once; a terminal that is not open reports no metrics and retains no
/// layer; and only one mask can be registered.
function ghosttyTerminal(options: {
  cols: number;
  rows: number;
  lines: FakeLine[];
  type?: "normal" | "alternate";
  open?: boolean;
}) {
  const { cols, rows, lines } = options;
  const open = options.open !== false;
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
  const layers: PaintLayer[] = [];
  const listeners = new Set<() => void>();
  const refreshed: Frame[] = [];
  let viewportY = 0;
  let paintedViewportY = 0;
  let repaintAll = false;
  let painting = false;
  let refreshCalls = 0;

  /// One frame of the widget that repaints `repainted` rows.
  function paint(repainted: number[]): Frame {
    const everyRow = repaintAll || viewportY !== paintedViewportY;
    repaintAll = false;
    paintedViewportY = viewportY;
    const changedRows = everyRow ? [...Array(rows).keys()] : [...new Set(repainted)].sort((a, b) => a - b);
    fills.length = 0;
    reads = 0;
    const frame: Frame = { fills: [], reads: 0, full: changedRows.length === rows, painted: false };
    if (changedRows.length === 0) return frame;
    const snapshot = [...layers];
    painting = true;
    try {
      for (const layer of snapshot) {
        frame.painted = true;
        context.save();
        try {
          layer.paint({
            ctx: context as unknown as CanvasRenderingContext2D,
            metrics: { ...CELL },
            pixelRatio: 1,
            viewportOffset: viewportY,
            topRow: Math.max(0, lines.length - rows - Math.max(0, Math.floor(viewportY))),
            full: frame.full,
            changedRows,
            rows,
            cols,
          } satisfies PaintFrame);
        } finally {
          context.restore();
        }
      }
    } finally {
      painting = false;
    }
    // The clip: a fill lands only on a row the frame repainted.
    frame.fills = fills.filter((fill) => changedRows.includes(fill.y / CELL.height));
    frame.reads = reads;
    return frame;
  }

  const term: GhosttyMaskTerminal = {
    buffer: { active },
    getMetrics: () => (open ? { ...CELL } : undefined),
    addPaintLayer(layer) {
      if (!open) return () => {};
      if (layer.order === "mask" && layers.some((entry) => entry.order === "mask")) {
        throw new Error("Only one mask paint layer can be registered");
      }
      const entry = { order: layer.order, paint: layer.paint };
      layers.push(entry);
      repaintAll = true;
      return () => {
        const at = layers.indexOf(entry);
        if (at < 0) return;
        layers.splice(at, 1);
        repaintAll = true;
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    refresh() {
      refreshCalls += 1;
      repaintAll = true;
      if (!painting) refreshed.push(paint([]));
    },
  };
  return {
    term,
    active,
    context,
    lines,
    layers,
    listeners,
    /// The frames the painter's own refreshes painted at once.
    refreshed,
    /// How many times the painter asked the widget for a full repaint.
    get refreshCalls() {
      return refreshCalls;
    },
    scroll(to: number) {
      viewportY = to;
    },
    /// The widget's change event, as after a write or a resize.
    changed() {
      for (const listener of [...listeners]) listener();
    },
    /// The widget's next frame, repainting `repainted` rows (none unless
    /// something made the frame repaint every row).
    frame: (repainted: number[] = []) => paint(repainted),
  };
}

function cells(x: number, row: number, width: number, color = MASK): Fill {
  return { x: x * CELL.width, y: row * CELL.height, width: width * CELL.width, height: CELL.height, color };
}

describe("ghostty secret masking over a fake buffer", () => {
  test("masks a NAME=value line on the row ghostty draws it, in the frame that draws it", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=cleartext", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.layers.map((layer) => layer.order), "the one layer is the mask").toEqual(["mask"]);
    const frame = screen.frame();
    expect(frame.fills).toEqual([cells(6, 0, 9)]);
    // Registering the layer is what repaints every row; the painter asks
    // for no repaint of its own.
    expect(frame.full).toBe(true);
    expect(screen.refreshCalls).toBe(0);
    expect(masker.maskCount).toBe(1);
    expect(screen.lines[0].text).toBe("TOKEN=cleartext");
    // The painter's fill comes after the content: the widget calls the
    // layer once the rows are drawn, and the mask paints with its own colour
    // under the one saved and restored context state, which is the widget's.
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

  test("an offset below zero maps rows as the bottom view does", () => {
    const lines = ["x", "y", "z", "w", "p", "TOKEN=abc"].map((text) => new FakeLine(text, 20));
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toEqual([cells(6, 2, 3)]);
    for (const below of [-0.5, -1, -2]) {
      screen.scroll(below);
      expect(screen.frame().fills, `at ${below}`).toEqual([cells(6, 2, 3)]);
    }
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

  test("a frame with nothing written repaints the cached spans without reading the buffer", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    const first = screen.frame();
    expect(first.reads).toBeGreaterThan(0);
    // An idle frame repaints no row, so it does not reach the layer: the
    // canvas keeps the mask the first frame painted.
    const idle = screen.frame();
    expect(idle.painted).toBe(false);
    expect(idle.reads).toBe(0);
    // A frame that repaints the row for a selection or the cursor paints
    // the cached span over it.
    const repaint = screen.frame([0]);
    expect(repaint.reads).toBe(0);
    expect(repaint.fills).toEqual([cells(6, 0, 3)]);

    // A row is read again once the widget reports a write, and the spans
    // follow the new text.
    screen.lines[0].text = "TOKEN=abcdef";
    const stale = screen.frame([0]);
    expect(stale.reads).toBe(0);
    expect(stale.fills).toEqual([cells(6, 0, 3)]);
    screen.changed();
    const fresh = screen.frame([0]);
    expect(fresh.reads).toBeGreaterThan(0);
    expect(fresh.fills).toEqual([cells(6, 0, 6)]);

    // So is a write the widget repaints every row for.
    screen.lines[0].text = "TOKEN=ab";
    screen.changed();
    expect(screen.frame([0, 1, 2]).fills).toEqual([cells(6, 0, 2)]);
    // A full repaint with nothing written keeps the spans: the widget
    // repaints every row on each frame of a scrolled view, and the buffer
    // changes only by a write or a resize.
    screen.lines[0].text = "TOKEN=a";
    const forced = screen.frame([0, 1, 2]);
    expect(forced.full).toBe(true);
    expect(forced.reads).toBe(0);
    expect(forced.fills).toEqual([cells(6, 0, 2)]);
  });

  test("a rescan that changes the spans of a row the frame did not repaint has the widget repaint every row", () => {
    // One value wrapped over three rows under a name that is not a secret's.
    const lines = [new FakeLine("NAME_TOKEX=a", 12), new FakeLine("bcdefghijklm", 12, true), new FakeLine("nopq", 12, true), new FakeLine("", 12)];
    const screen = ghosttyTerminal({ cols: 12, rows: 4, lines });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toEqual([]);

    // The program rewrites the name's row alone; the widget repaints it and
    // its neighbour. The value's last row is now a secret's and was not
    // repainted, so its mask is clipped away in this frame.
    lines[0].text = "NAME_TOKEN=a";
    screen.changed();
    const partial = screen.frame([0, 1]);
    expect(partial.fills).toEqual([cells(11, 0, 1), cells(0, 1, 12)]);
    expect(masker.maskCount).toBe(3);
    expect(screen.refreshCalls, "a full repaint is asked for").toBe(1);
    const next = screen.frame();
    expect(next.full).toBe(true);
    expect(next.reads).toBe(0);
    expect(next.fills).toEqual([cells(11, 0, 1), cells(0, 1, 12), cells(0, 2, 4)]);
    expect(screen.frame().painted, "and only one").toBe(false);

    // The name stops being a secret's: the mask left on the row the frame
    // does not repaint has to go too.
    lines[0].text = "NAME_TOKEX=a";
    screen.changed();
    expect(screen.frame([0, 1]).fills).toEqual([]);
    expect(screen.refreshCalls).toBe(2);
    expect(screen.frame().full).toBe(true);

    // A rescan that changes only rows the frame repainted asks for nothing.
    lines[0].text = "NAME_TOKEN=a";
    lines[1].isWrapped = false;
    screen.changed();
    expect(screen.frame([0, 1]).fills).toEqual([cells(11, 0, 1)]);
    expect(screen.refreshCalls).toBe(2);
  });

  test("scanAll and scanViewport force the next frame to read again", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.frame();
    screen.lines[0].text = "TOKEN=abcd";
    masker.scanViewport();
    expect(screen.frame([0]).fills).toEqual([cells(6, 0, 4)]);
    screen.lines[0].text = "TOKEN=abcde";
    masker.scanAll();
    expect(screen.frame([0]).fills).toEqual([cells(6, 0, 5)]);
  });

  test("masking toggled off redraws the rows it covered and paints nothing", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toHaveLength(1);
    masker.setEnabled(false);
    expect(masker.enabled).toBe(false);
    expect(masker.maskCount).toBe(0);
    expect(screen.layers, "the layer is removed").toEqual([]);
    expect(screen.listeners.size, "and the change subscription").toBe(0);
    const off = screen.frame();
    expect(off.fills).toEqual([]);
    expect(off.full).toBe(true);
    expect(off.reads).toBe(0);
    expect(screen.frame().full).toBe(false);
    masker.setEnabled(true);
    const on = screen.frame();
    expect(on.full).toBe(true);
    expect(on.fills).toEqual([cells(6, 0, 3)]);
    expect(screen.lines[0].text).toBe("TOKEN=abc");
  });

  test("a masker made with masking off registers nothing until it is turned on", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, false);
    expect(screen.layers).toEqual([]);
    expect(screen.frame([0, 1, 2]).fills).toEqual([]);
    masker.setEnabled(true);
    expect(screen.frame().fills).toEqual([cells(6, 0, 3)]);
  });

  test("a colour change repaints the masks in the new colour at once", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    screen.frame();
    masker.setColor("#57606a");
    expect(screen.refreshed).toHaveLength(1);
    expect(screen.refreshed[0].fills).toEqual([cells(6, 0, 3, "#57606a")]);
    expect(screen.frame([0]).fills).toEqual([cells(6, 0, 3, "#57606a")]);
    // The same colour again, and a colour with no mask on screen, repaint
    // nothing.
    masker.setColor("#57606a");
    expect(screen.refreshed).toHaveLength(1);
    screen.lines[0].text = "plain";
    screen.changed();
    screen.frame([0]);
    masker.setColor(MASK);
    expect(screen.refreshed).toHaveLength(1);
  });

  test("a widget that is not open fails loud, registers nothing, and the toggle retries", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, open: false, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const onError = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(screen.layers).toEqual([]);
    expect(screen.listeners.size).toBe(0);
    expect(error).toHaveBeenCalledWith("ghostty secret masking paint layer unavailable", expect.any(Error));
    masker.setEnabled(true);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(masker.enabled).toBe(false);
  });

  test("a mask layer already taken fails loud and leaves the other layer alone", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const other = vi.fn();
    screen.term.addPaintLayer({ order: "mask", paint: other });
    const onError = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true, onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(error).toHaveBeenCalledWith("ghostty secret masking paint layer unavailable", expect.any(Error));
    expect(screen.layers).toHaveLength(1);
    masker.dispose();
    expect(screen.layers).toHaveLength(1);
    screen.frame();
    expect(other).toHaveBeenCalledOnce();
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
    screen.changed();
    // The frame's content is drawn before the layer runs, and the failure
    // does not leave the layer: the widget's frame completes.
    const failed = screen.frame([0]);
    expect(onError).toHaveBeenCalledOnce();
    expect(masker.enabled).toBe(false);
    expect(failed.fills).toEqual([]);
    expect(screen.layers).toEqual([]);
    // The next frame redraws every row, without the painter, and later
    // frames render without it until it is re-enabled.
    const redraw = screen.frame();
    expect(redraw.full).toBe(true);
    expect(redraw.fills).toEqual([]);
    const after = screen.frame();
    expect(after.fills).toEqual([]);
    expect(after.full).toBe(false);
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
    expect(screen.context.restore).toHaveBeenCalledTimes(screen.context.save.mock.calls.length);
    expect(screen.frame().full).toBe(true);
  });

  test("dispose removes the layer and the change subscription, and a later toggle adds none", () => {
    const screen = ghosttyTerminal({ cols: 20, rows: 3, lines: [new FakeLine("TOKEN=abc", 20), new FakeLine("", 20), new FakeLine("", 20)] });
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.frame().fills).toHaveLength(1);
    expect(screen.layers).toHaveLength(1);
    expect(screen.listeners.size).toBe(1);
    masker.dispose();
    expect(screen.layers).toEqual([]);
    expect(screen.listeners.size).toBe(0);
    expect(masker.maskCount).toBe(0);
    masker.setEnabled(false);
    masker.setEnabled(true);
    expect(screen.layers).toEqual([]);
    expect(screen.frame().fills).toEqual([]);
  });
});

describe("ghostty secret masking over the pinned build", () => {
  let vendored: WebAssembly.Module;

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync(VENDORED));
  });

  const opened: Terminal[] = [];
  let frames: FrameRequestCallback[] = [];

  afterEach(() => {
    for (const term of opened.splice(0)) {
      term.dispose();
      term.element?.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const COLS = 20;
  const ROWS = 4;
  const BACKGROUND = { r: 16, g: 16, b: 16, a: 1 };
  const MASKED = { r: 0x6c, g: 0x6c, b: 0x70, a: 1 };

  /// The widget opened over the binding's terminal on its own instance of
  /// the vendored core, as backend.ts's kit hands one to each terminal. The
  /// test runs the animation frames the widget's render loop asks for, the
  /// scrollbar is held out of the picture, and the software canvas records
  /// what the renderer and the painter fill.
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
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const term = new Terminal({
      ghostty: vt,
      cols: COLS,
      rows: ROWS,
      scrollback: 100,
      cursorBlink: false,
      smoothScrollDuration: 0,
      testHooks: { scrollbarOpacity: 0 },
      theme: { background: "#101010", foreground: "#e0e0e0" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    term.open(host);
    opened.push(term);
    const context = contexts.get(host.querySelector("canvas")!)!;
    return {
      term,
      write(text: string) {
        term.write(text);
      },
      /// One animation frame: the callbacks queued so far, once.
      frame() {
        for (const callback of frames.splice(0)) callback(performance.now());
      },
      /// The pixel at the centre of a cell, in CSS coordinates.
      pixel(x: number, row: number) {
        const metrics = term.getMetrics()!;
        return context.pixelAt((x + 0.5) * metrics.width, (row + 0.5) * metrics.height);
      },
      /// The pixel at the centre of every cell, by row.
      cells() {
        return Array.from({ length: ROWS }, (_, row) => Array.from({ length: COLS }, (_, x) => this.pixel(x, row)));
      },
    };
  }

  /// One frame of the render loop, held to the full frame the widget paints
  /// of the same state right after it.
  function expectFrameWhole(screen: Awaited<ReturnType<typeof pinnedTerminal>>, label: string) {
    screen.frame();
    const painted = screen.cells();
    screen.term.refresh();
    expect(painted, label).toEqual(screen.cells());
  }

  test("a value typed a character at a time is masked in each frame as a full frame masks it", async () => {
    const screen = await pinnedTerminal();
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    for (const typed of ["$ export TOKEN=", "a", "b", "c"]) {
      screen.write(typed);
      expectFrameWhole(screen, `after ${JSON.stringify(typed)}`);
    }
    expect(masker.maskCount).toBe(1);
    expectPixel(screen.pixel(14, 0), BACKGROUND);
    for (const x of [15, 16, 17]) expectPixel(screen.pixel(x, 0), MASKED);
    // The name rewritten under the value: the row is no longer masked.
    screen.write("\x1b[1;14Hd");
    expectFrameWhole(screen, "after the name is rewritten");
    expect(masker.maskCount).toBe(0);
    for (const x of [15, 16, 17]) expectPixel(screen.pixel(x, 0), BACKGROUND);
  });

  test("a value in the history masks on the row its fractional offset's floor shows", async () => {
    const screen = await pinnedTerminal();
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    // Eleven lines over four rows: the value line is history row 3 of 7, so
    // at an offset of 5 it shows on view row 1, and at 4.75 on view row 0.
    screen.write(["a", "b", "c", "TOKEN=abc", "d", "e", "f", "g", "h", "i", "j"].join("\r\n"));
    expect(screen.term.getScrollbackLength()).toBe(7);
    for (const [offset, row] of [
      [5, 1],
      [5.5, 1],
      [4.75, 0],
    ]) {
      screen.term.viewport.scrollTo(offset);
      expect(screen.term.getViewportY()).toBe(offset);
      expectFrameWhole(screen, `at ${offset}`);
      expectPixel(screen.pixel(5, row), BACKGROUND);
      for (const x of [6, 7, 8]) expectPixel(screen.pixel(x, row), MASKED);
    }
  });

  test("the mask is the widget's one mask layer, and the renderer keeps its own render", async () => {
    const screen = await pinnedTerminal();
    const render = screen.term.renderer!.render;
    const masker = new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    expect(screen.term.renderer!.render, "the renderer's render is not replaced").toBe(render);
    expect(Object.hasOwn(screen.term.renderer!, "render")).toBe(false);
    expect(() => screen.term.addPaintLayer({ order: "mask", paint() {} }), "the mask is taken").toThrow(/one mask/);
    masker.setEnabled(false);
    const remove = screen.term.addPaintLayer({ order: "mask", paint() {} });
    remove();
    masker.dispose();
  });

  test("the mask paints over a layer registered after it, in the frame that draws the value", async () => {
    const screen = await pinnedTerminal();
    new GhosttySecretMasker(screen.term, ["TOKEN"], MASK, true);
    const TINT = { r: 0x20, g: 0x40, b: 0x60, a: 1 };
    screen.term.addPaintLayer({
      order: 1000,
      paint({ ctx, metrics, rows, cols }) {
        ctx.fillStyle = "#204060";
        ctx.fillRect(0, 0, cols * metrics.width, rows * metrics.height);
      },
    });
    screen.frame();
    expectPixel(screen.pixel(6, 0), TINT);
    screen.write("TOKEN=abc");
    // One frame: the row, the later layer over it, then the mask.
    screen.frame();
    expectPixel(screen.pixel(5, 0), TINT);
    expectPixel(screen.pixel(6, 0), MASKED);
    expectPixel(screen.pixel(8, 0), MASKED);
    expectPixel(screen.pixel(9, 1), TINT);
  });

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
