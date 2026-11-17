// @vitest-environment jsdom
//
// The ghostty widget's pointer behaviour, through real element listeners on
// a real opened terminal: pointer handling scoped to the terminal element
// with pointer capture and no document listener, a click outside the terminal
// element keeping the selection, and the drag auto-scroll and the scrollbar
// thumb drag moving through the viewport API. Events dispatch on the host
// and the canvas the way the engine retargets them under capture; the
// selection is read back only through the terminal's public API.
import { readFileSync } from "node:fs";
import type { FontMetrics } from "./renderer";
import { Terminal } from "./terminal";
import { GhosttyVt } from "../vt/ghosttyVt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 40;
const ROWS = 6;

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

/// The 2d context the widget's renderer needs, over no pixels: rectangles
/// and text are no-ops, measuring reports an 8 by 16 cell.
function fakeContext(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "measureText"
          ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
          : (..._args: unknown[]) => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function pointer(target: Element, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      // Engines send button -1 on moves (no button changed); only the
      // buttons bitmask says what is held.
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: x,
      clientY: y,
      ...extra,
    }),
  );
}

async function openPinned(input = ""): Promise<{
  term: Terminal;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  captureCanvas: ReturnType<typeof vi.fn>;
  captureHost: ReturnType<typeof vi.fn>;
  metrics: FontMetrics;
  px: (col: number, row: number) => [number, number];
}> {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ ghostty, cols: COLS, rows: ROWS, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => fakeContext()) as never);
  // jsdom implements no pointer capture: stub it on both elements and
  // record the calls, and dispatch captured moves on their target, the
  // way the engine retargets them.
  const captureCanvas = vi.fn();
  const captureHost = vi.fn();
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: captureCanvas });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: captureHost });
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("ghostty-web opened no canvas");
  if (input) term.write(input);
  // jsdom lays out nothing: give every canvas the grid's box so inside and
  // outside positions mean what they would in a browser.
  const metrics = term.renderer!.getMetrics();
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, COLS * metrics.width, ROWS * metrics.height),
  );
  const px = (col: number, row: number): [number, number] => [col * metrics.width + 1, row * metrics.height + 1];
  return { term, host, canvas, captureCanvas, captureHost, metrics, px };
}

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
});

function installClipboard() {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

/// Stand the overlay's finished visible state up directly: in a browser it
/// fades in over animation frames, but these tests pin the press gate, not
/// the fade. The hidden-strip tests use a fresh terminal, whose overlay
/// never showed.
function showStrip(term: Terminal): void {
  const inner = term as unknown as { scrollbarVisible: boolean; scrollbarOpacity: number };
  inner.scrollbarVisible = true;
  inner.scrollbarOpacity = 1;
}

function isDraggingScrollbar(term: Terminal): boolean {
  return (term as unknown as { isDraggingScrollbar: boolean }).isDraggingScrollbar;
}

describe("the ghostty widget's pointer handling", () => {
  test("open adds no listener on document or window, not even for the context menu", async () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    const { canvas } = await openPinned();
    expect(docAdd, "no document listener after open").not.toHaveBeenCalled();
    expect(winAdd, "no window listener after open").not.toHaveBeenCalled();
    // The context menu arms a one-shot textarea reset on blur and on the
    // next canvas press: both element-scoped, nothing on the document.
    vi.useFakeTimers();
    try {
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      vi.advanceTimersByTime(10);
    } finally {
      vi.useRealTimers();
    }
    expect(docAdd, "no document listener after the menu").not.toHaveBeenCalled();
    expect(winAdd, "no window listener after the menu").not.toHaveBeenCalled();
  });

  test("a press captures its pointer, for a selection drag and for the thumb", async () => {
    const { term, canvas, captureCanvas, captureHost } = await openPinned("hello world\r\nsecond row");
    expect(term.hasSelection()).toBe(false);
    pointer(canvas, "pointerdown", 1, 1, { pointerId: 7 });
    expect(captureCanvas, "the drag captures the pointer to the canvas").toHaveBeenCalledWith(7);
    pointer(canvas, "pointermove", 60, 1);
    expect(term.hasSelection(), "the press starts a selection").toBe(true);
    expect(captureHost, "a canvas press captures nothing on the host").not.toHaveBeenCalled();
    const scrolled = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    scrolled.term.viewport.scrollTo(10);
    showStrip(scrolled.term);
    showStrip(term);
    vi.spyOn(scrolled.canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = scrolled.term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    const writeText = installClipboard();
    const bubbled: Event[] = [];
    const capturedBefore = captureCanvas.mock.calls.length;
    scrolled.host.addEventListener("pointerdown", (e) => void bubbled.push(e));
    scrolled.canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 9, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY }),
    );
    expect(scrolled.captureHost, "the thumb press captures the pointer to the host").toHaveBeenCalledWith(9);
    expect(bubbled, "the press still bubbles to the page").toHaveLength(1);
    expect(captureCanvas.mock.calls.length, "the selection never captures a strip press").toBe(capturedBefore);
    scrolled.canvas.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 9, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY + 5 }),
    );
    scrolled.canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, pointerType: "mouse" }));
    expect(scrolled.term.hasSelection(), "a thumb press selects nothing").toBe(false);
    expect(writeText, "a thumb press copies nothing").not.toHaveBeenCalled();
  });

  test("a thumb drag moves the view through the real parent listeners", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    expect(history).toBeGreaterThan(10);
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    const press = (type: string, y: number) =>
      (type === "pointerdown" ? canvas : host).dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 3, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: y }),
      );
    press("pointerdown", thumbY);
    expect(term.viewport.offset, "the press alone holds the view").toBe(10);
    press("pointermove", thumbY + 11);
    const moved = term.viewport.offset;
    expect(moved, "the drag moved the view toward newer rows").toBeLessThan(10);
    expect(moved, "the drag moved by about delta over track times history").toBeCloseTo(10 - (11 / (trackHeight - thumbHeight)) * history, 0);
    press("pointerup", thumbY + 11);
  });

  test("a write during a scrollbar thumb drag keeps the anchor", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    expect(history).toBeGreaterThan(20);
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history);
    const press = (type: string, y: number) =>
      (type === "pointerdown" ? canvas : host).dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 5, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: y }),
      );
    press("pointerdown", thumbY);
    expect(term.viewport.offset, "the press alone holds the view").toBe(10);
    term.write(Array.from({ length: 5 }, (_, n) => `stream ${n}`).join("\r\n"));
    const anchored = term.viewport.offset;
    expect(anchored, "streaming while held grows the offset").toBeGreaterThan(10);
    press("pointermove", thumbY);
    expect(term.viewport.offset, "the drag did not undo the rows the write anchored").toBe(anchored);
    press("pointerup", thumbY);
  });

  test("a press on the scrollbar track jumps the viewport to that position", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    expect(history).toBeGreaterThan(20);
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    // The track's top stands for the oldest rows: the press jumps there, it
    // does not start a thumb drag and it does not nudge by a page. The
    // press lands one padding below the track's top edge.
    const trackHeight = 96 - 4 * 2;
    const expected = Math.round((1 - (8 - 4) / trackHeight) * history);
    expect(expected, "the track top really moves the view").toBeGreaterThan(10);
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 6, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: 8 }),
    );
    expect(term.viewport.offset, "the track press jumps the viewport to that position").toBe(expected);
    host.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 6, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: 8 }),
    );
    expect(term.viewport.offset, "a track press starts no drag").toBe(expected);
  });

  test("a buttonless move during a thumb drag ends the drag, and a held button does not", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    const at = (type: string, y: number, buttons: number) =>
      (type === "pointerdown" ? canvas : host).dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, buttons, pointerId: 8, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: y }),
      );
    at("pointerdown", thumbY, 1);
    expect(term.viewport.offset, "the press alone holds the view").toBe(10);
    at("pointermove", thumbY + 11, 0);
    expect(term.viewport.offset, "a buttonless move ends the thumb drag").toBe(10);
    at("pointermove", thumbY + 22, 1);
    expect(term.viewport.offset, "a later move after the release changes nothing").toBe(10);
    at("pointerup", thumbY + 22, 0);
  });

  test("a lost capture ends the thumb drag", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 11, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY }),
    );
    expect(term.viewport.offset, "the press alone holds the view").toBe(10);
    host.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 11, pointerType: "mouse" }));
    host.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 11, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY + 11 }),
    );
    expect(term.viewport.offset, "the capture loss released the thumb drag").toBe(10);
    host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 11, pointerType: "mouse" }));
  });
});

describe("the ghostty widget's selection", () => {
  test("a drag that leaves the canvas keeps selecting by pointer capture", async () => {
    const { term, canvas } = await openPinned("hello world\r\nsecond row");
    const writeText = installClipboard();
    pointer(canvas, "pointerdown", 1, 1);
    // Far outside the canvas: under pointer capture the move still reaches it.
    pointer(canvas, "pointermove", 500, 300);
    pointer(canvas, "pointerup", 500, 300);
    expect(term.hasSelection(), "the excursion kept the drag selecting").toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("hello world");
    term.dispose();
  });

  test("a click outside the terminal element keeps the selection", async () => {
    const { term, canvas } = await openPinned("hello world");
    pointer(canvas, "pointerdown", 1, 1);
    pointer(canvas, "pointermove", 33, 1);
    pointer(canvas, "pointerup", 33, 1);
    expect(term.hasSelection(), "the drag selected").toBe(true);
    const before = term.getSelection();
    // A sibling of the host stands in for the find bar.
    const sibling = document.createElement("div");
    document.body.append(sibling);
    sibling.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    expect(term.hasSelection(), "the outside click kept the selection").toBe(true);
    expect(term.getSelection(), "the outside click kept the text").toBe(before);
  });
});

describe("the ghostty widget's selection mechanics", () => {
  test("a drag copies through the clipboard", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    pointer(canvas, "pointerup", x1, y1);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe("hello");
    term.dispose();
  });

  test("a press and release without a drag selects and copies nothing", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(2, 0);
    pointer(canvas, "pointerdown", x, y);
    pointer(canvas, "pointerup", x, y);
    expect(term.hasSelection()).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    term.dispose();
  });

  test("a move just over half a cell starts the drag, a smaller move does not", async () => {
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(0, 0);
    pointer(canvas, "pointerdown", x, y);
    pointer(canvas, "pointermove", x + 5, y);
    pointer(canvas, "pointerup", x + 5, y);
    expect(term.hasSelection(), "half a cell plus a pixel selects").toBe(true);
    const { term: term2, canvas: canvas2 } = await openPinned("hello world\r\nsecond row");
    const [x2, y2] = px(0, 0);
    pointer(canvas2, "pointerdown", x2, y2);
    pointer(canvas2, "pointermove", x2 + 3, y2);
    pointer(canvas2, "pointerup", x2 + 3, y2);
    expect(term2.hasSelection(), "three pixels stay a tap").toBe(false);
  });

  test("a double click selects the word on its row", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(7, 0);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2, clientX: x, clientY: y }));
    expect(term.getSelection()).toBe("world");
    expect(writeText).toHaveBeenCalledTimes(1);
    term.dispose();
  });

  test("a triple click selects the whole row", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(0, 1);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3, clientX: x, clientY: y }));
    expect(term.getSelection()).toBe("second row");
    expect(writeText).toHaveBeenCalledTimes(1);
    term.dispose();
  });

  test("a buttonless move keeps selecting while the canvas holds the pointer, and ends the drag once it is gone", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(10, 0);
    // jsdom implements no pointer capture: model the held drag explicitly.
    if (typeof canvas.hasPointerCapture !== "function") canvas.hasPointerCapture = () => false;
    const held = vi.spyOn(canvas, "hasPointerCapture").mockImplementation(() => true);
    try {
      pointer(canvas, "pointerdown", x0, y0);
      pointer(canvas, "pointermove", x1, y1);
      expect(term.hasSelection()).toBe(true);
      canvas.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x1 + 4, clientY: y1 }),
      );
      expect(term.hasSelection(), "the held drag keeps selecting").toBe(true);
      pointer(canvas, "pointerup", x1 + 4, y1);
      expect(writeText, "the release copies once").toHaveBeenCalledTimes(1);
      held.mockImplementation(() => false);
      pointer(canvas, "pointerdown", x0, y0);
      pointer(canvas, "pointermove", x1, y1);
      expect(term.hasSelection()).toBe(true);
      canvas.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x1 + 4, clientY: y1 }),
      );
      expect(term.hasSelection(), "the released drag keeps the selection").toBe(true);
      pointer(canvas, "pointerup", x1 + 4, y1);
      expect(writeText, "an ended drag copies nothing more").toHaveBeenCalledTimes(1);
    } finally {
      held.mockRestore();
    }
    term.dispose();
  });

  test("a drag past the top edge selects from column zero, past the bottom from the last column", async () => {
    const { term, canvas, px, metrics } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(20, 0);
    pointer(canvas, "pointerdown", x, y);
    pointer(canvas, "pointermove", x, -50);
    pointer(canvas, "pointerup", x, -50);
    expect(term.getSelection(), "above the canvas the drag starts at column zero").toBe("hello world");
    const { term: term2, canvas: canvas2, px: px2 } = await openPinned(
      ["hello world", "", "", "", "", "last row here"].join("\r\n"),
    );
    const [x2, y2] = px2(2, 0);
    pointer(canvas2, "pointerdown", x2, y2);
    pointer(canvas2, "pointermove", x2, ROWS * metrics.height + 50);
    pointer(canvas2, "pointerup", x2, ROWS * metrics.height + 50);
    expect(term2.getSelection(), "below the canvas the drag runs to the last row").toContain("last row here");
    expect(term2.getSelection(), "the whole row is selected").toMatch(/^llo world\n(\n*)last row here$/);
  });

  test("a press whose capture throws still selects", async () => {
    const { term, canvas, captureCanvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    captureCanvas.mockImplementationOnce(() => {
      throw new DOMException("unknown pointer id");
    });
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    expect(term.hasSelection(), "the drag started without capture").toBe(true);
    pointer(canvas, "pointerup", x1, y1);
    expect(term.getSelection(), "the drag still selects").toBe("hello");
  });

  test("a touch press starts no selection drag and copies nothing", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(10, 1);
    const touch = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 2, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
    touch("pointerdown", x0, y0);
    touch("pointermove", x1, y1);
    touch("pointerup", x1, y1);
    expect(term.hasSelection(), "a touch drag selects nothing").toBe(false);
    expect(writeText, "a touch drag copies nothing").not.toHaveBeenCalled();
    term.dispose();
  });

  test("a primary pen press selects", async () => {
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 2, pointerType: "pen", isPrimary: true, clientX: x0, clientY: y0 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 2, pointerType: "pen", isPrimary: true, clientX: x1, clientY: y1 }));
    expect(term.hasSelection(), "a primary pen press starts a selection drag").toBe(true);
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "pen", isPrimary: true, clientX: x1, clientY: y1 }));
    expect(term.getSelection(), "the pen drag selected").toBe("hello");
  });

  test("mouse reports outside the grid clamp to it through the wired dimensions", async () => {
    const reports: string[] = [];
    const { term, canvas } = await openPinned("");
    term.onData((data) => void reports.push(data));
    term.write("\x1b[?1002h\x1b[?1006h");
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5000, clientY: 5000 }));
    canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5000, clientY: 5000 }));
    expect(reports.join(""), "the far move reports the clamped cell").toContain("\x1b[<32;40;6M");
    canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 5000, clientY: 5000 }));
  });

  test("a non-primary press starts no selection drag", async () => {
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(10, 1);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 2, pointerType: "pen", isPrimary: false, clientX: x0, clientY: y0 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1, pointerId: 2, pointerType: "pen", isPrimary: false, clientX: x1, clientY: y1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "pen", clientX: x1, clientY: y1 }));
    expect(term.hasSelection(), "a second pointer selects nothing").toBe(false);
  });

  test("a non-left press on the thumb starts no drag", async () => {
    const { term, host, canvas, captureHost } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 2, buttons: 2, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY }),
    );
    expect(captureHost, "a right press captures nothing").not.toHaveBeenCalled();
    host.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, buttons: 2, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY - 20 }),
    );
    expect(term.viewport.offset, "a right press on the thumb holds the view").toBe(10);
    host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
  });

  test("an interrupted drag copies nothing and keeps the selection", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(10, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    canvas.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    expect(writeText, "the interruption copies nothing").not.toHaveBeenCalled();
    expect(term.hasSelection(), "the interrupted drag kept its selection").toBe(true);
    term.dispose();
  });

  test("a context menu reset hides the textarea when it loses the keyboard", async () => {
    const { term, canvas } = await openPinned("hello world\r\nsecond row");
    const textarea = term.element!.querySelector("textarea")!;
    vi.useFakeTimers();
    try {
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }));
      expect(textarea.style.pointerEvents, "the menu arms the textarea").toBe("auto");
      vi.advanceTimersByTime(10);
    } finally {
      vi.useRealTimers();
    }
    textarea.blur();
    expect(textarea.style.pointerEvents, "losing the keyboard hides it again").toBe("none");
    expect(textarea.style.width).toBe("0px");
    expect(textarea.value).toBe("");
  });
});

describe("the ghostty widget's drag auto-scroll", () => {
  test("the drag's auto-scroll moves the view through the viewport API", async () => {
    const { term, canvas, px } = await openPinned(Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\r\n"));
    expect(term.getScrollbackLength()).toBeGreaterThan(10);
    term.viewport.scrollTo(8);
    const scrollBy = vi.spyOn(term.viewport, "scrollBy");
    const scrollLines = vi.spyOn(term, "scrollLines");
    vi.useFakeTimers();
    try {
      const [x0, y0] = px(0, 0);
      pointer(canvas, "pointerdown", x0, y0);
      const rect = canvas.getBoundingClientRect();
      pointer(canvas, "pointermove", 1, rect.height + 404);
      vi.advanceTimersByTime(160);
    } finally {
      vi.useRealTimers();
    }
    expect(scrollBy, "the auto-scroll moved through the viewport API").toHaveBeenCalledWith(-3);
    expect(scrollLines, "no write bypassed the viewport API").not.toHaveBeenCalled();
    expect(term.viewport.offset).toBe(0);
  });

  test("the auto-scroll stops once the canvas leaves the document", async () => {
    const { term, host, canvas, px } = await openPinned(Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\r\n"));
    term.viewport.scrollTo(8);
    const scrollBy = vi.spyOn(term.viewport, "scrollBy");
    vi.useFakeTimers();
    try {
      const [x0, y0] = px(0, 0);
      pointer(canvas, "pointerdown", x0, y0);
      const rect = canvas.getBoundingClientRect();
      pointer(canvas, "pointermove", 1, rect.height + 404);
      vi.advanceTimersByTime(160);
      expect(scrollBy, "the edge drag scrolls while attached").toHaveBeenCalled();
      scrollBy.mockClear();
      host.remove();
      vi.advanceTimersByTime(320);
    } finally {
      vi.useRealTimers();
    }
    expect(scrollBy, "no scroll drives a detached canvas").not.toHaveBeenCalled();
  });
});

describe("the ghostty widget's release under mouse tracking", () => {
  test("a drag under DECSET 1000 copies nothing on release but still reports it", async () => {
    const writeText = installClipboard();
    const reports: string[] = [];
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    term.onData((data) => void reports.push(data));
    term.write("\x1b[?1000h\x1b[?1006h");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    pointer(canvas, "pointerup", x1, y1);
    // The compat mouseup the engine fires next carries the program's
    // release report, which clears the highlight the way the base left it.
    canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: x1, clientY: y1 }));
    expect(writeText, "a tracked drag copies nothing").not.toHaveBeenCalled();
    expect(reports.join(""), "the release still reports to the program").toContain("\x1b[<0;");
    expect(term.hasSelection(), "the report clears the highlight as at the base").toBe(false);
  });

  test("a capture lost under DECSET 1000 ends the drag without copying", async () => {
    const writeText = installClipboard();
    const reports: string[] = [];
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    term.onData((data) => void reports.push(data));
    term.write("\x1b[?1000h\x1b[?1006h");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    canvas.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: false, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: x1, clientY: y1 }));
    expect(writeText, "a tracked loss copies nothing").not.toHaveBeenCalled();
    expect(reports.join(""), "the loss still reports the release").toContain("\x1b[<0;");
  });
});

describe("a capture lost mid-drag ends it as a release", () => {
  test("a capture lost before the release copies once", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    // Chrome drops the capture on a move with no buttons and fires the loss
    // before the release: the drag is still open, so the loss releases it.
    canvas.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: false, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x1, clientY: y1 }),
    );
    pointer(canvas, "pointerup", x1, y1);
    expect(writeText, "the lost capture copies once").toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe("hello");
    expect(term.hasSelection(), "the released drag keeps its selection").toBe(true);
  });

  test("a capture lost after the release ends nothing", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    pointer(canvas, "pointerup", x1, y1);
    expect(writeText, "the release copies once").toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: false, pointerId: 1, pointerType: "mouse" }));
    expect(writeText, "the late loss copies nothing more").toHaveBeenCalledTimes(1);
  });

  test("a capture lost after a cancel copies nothing", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(4, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    canvas.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: false, pointerId: 1, pointerType: "mouse" }));
    expect(writeText, "neither the cancel nor the loss copies").not.toHaveBeenCalled();
    expect(term.hasSelection(), "the interrupted drag keeps its selection").toBe(true);
  });
});

describe("the ghostty widget's overlay strip gate", () => {
  test("a press on the hidden strip starts a selection, not a thumb drag", async () => {
    const { term, canvas, px } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    // A fresh terminal never showed the overlay: the strip is content.
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 21, pointerType: "mouse", isPrimary: true, clientX: 312, clientY: 9 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented, "the hidden strip claims nothing").toBe(false);
    expect(isDraggingScrollbar(term), "no thumb drag starts").toBe(false);
    const [, my] = px(0, 1);
    canvas.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, cancelable: true, buttons: 1, pointerId: 21, pointerType: "mouse", isPrimary: true, clientX: 300, clientY: my }),
    );
    expect(term.hasSelection(), "the hidden strip selects like content").toBe(true);
  });

  test("a press on the visible strip claims the press and starts a thumb drag", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    term.viewport.scrollTo(10);
    showStrip(term);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 22, pointerType: "mouse", isPrimary: true, clientX: 312, clientY: thumbY });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented, "the visible strip claims the press").toBe(true);
    expect(isDraggingScrollbar(term), "the thumb drag starts").toBe(true);
    expect(term.hasSelection(), "the strip press selects nothing").toBe(false);
    host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 22, pointerType: "mouse" }));
    expect(isDraggingScrollbar(term), "the release ends the thumb drag").toBe(false);
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 22, pointerType: "mouse", isPrimary: true, clientX: 312, clientY: thumbY }),
    );
    expect(isDraggingScrollbar(term), "a second press claims the strip again").toBe(true);
  });

  test("with no history the strip area selects like content", async () => {
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 23, pointerType: "mouse", isPrimary: true, clientX: 312, clientY: 9 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented, "no bar means no claim").toBe(false);
    const [, my] = px(0, 1);
    canvas.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, cancelable: true, buttons: 1, pointerId: 23, pointerType: "mouse", isPrimary: true, clientX: 300, clientY: my }),
    );
    expect(term.hasSelection(), "the strip area selects like content").toBe(true);
    expect(isDraggingScrollbar(term), "no thumb drag starts").toBe(false);
  });
});
