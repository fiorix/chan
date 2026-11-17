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
      button: 0,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
});

function installClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
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
    const { term, host, canvas, captureCanvas, captureHost } = await openPinned("hello world\r\nsecond row");
    expect(term.hasSelection()).toBe(false);
    pointer(canvas, "pointerdown", 1, 1, { pointerId: 7 });
    expect(captureCanvas, "the drag captures the pointer to the canvas").toHaveBeenCalledWith(7);
    pointer(canvas, "pointermove", 60, 1);
    expect(term.hasSelection(), "the press starts a selection").toBe(true);
    expect(captureHost, "a canvas press captures nothing on the host").not.toHaveBeenCalled();
    const scrolled = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    scrolled.term.viewport.scrollTo(10);
    vi.spyOn(scrolled.canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = scrolled.term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    scrolled.host.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 9, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: thumbY }),
    );
    expect(scrolled.captureHost, "the thumb press captures the pointer to the host").toHaveBeenCalledWith(9);
    scrolled.host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, pointerType: "mouse" }));
  });

  test("a thumb drag moves the view through the real parent listeners", async () => {
    const { term, host, canvas } = await openPinned(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    expect(history).toBeGreaterThan(10);
    term.viewport.scrollTo(10);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    const press = (type: string, y: number) =>
      host.dispatchEvent(
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
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history);
    const press = (type: string, y: number) =>
      host.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 5, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: y }),
      );
    press("pointerdown", thumbY);
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
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    // The track's top stands for the oldest rows: the press jumps there, it
    // does not start a thumb drag and it does not nudge by a page. The
    // press lands one padding below the track's top edge.
    const trackHeight = 96 - 4 * 2;
    const expected = Math.round((1 - (8 - 4) / trackHeight) * history);
    expect(expected, "the track top really moves the view").toBeGreaterThan(10);
    host.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, pointerId: 6, pointerType: "mouse", isPrimary: true, clientX: 310, clientY: 8 }),
    );
    expect(term.viewport.offset, "the track press jumps the viewport to that position").toBe(expected);
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
    delete (navigator as { clipboard?: unknown }).clipboard;
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
    delete (navigator as { clipboard?: unknown }).clipboard;
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
    delete (navigator as { clipboard?: unknown }).clipboard;
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
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("a triple click selects the whole row", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(0, 1);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3, clientX: x, clientY: y }));
    expect(term.getSelection()).toBe("second row");
    expect(writeText).toHaveBeenCalledTimes(1);
    term.dispose();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("a move without a pressed button ends the drag and copies nothing", async () => {
    const writeText = installClipboard();
    const { term, canvas, px } = await openPinned("hello world\r\nsecond row");
    const [x0, y0] = px(0, 0);
    const [x1, y1] = px(10, 0);
    pointer(canvas, "pointerdown", x0, y0);
    pointer(canvas, "pointermove", x1, y1);
    expect(term.hasSelection()).toBe(true);
    canvas.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x1 + 4, clientY: y1 }),
    );
    pointer(canvas, "pointerup", x1 + 4, y1);
    expect(term.hasSelection(), "the buttonless move ended the drag").toBe(false);
    expect(writeText, "an ended drag copies nothing").not.toHaveBeenCalled();
    term.dispose();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("a drag past the top edge selects from column zero, past the bottom from the last column", async () => {
    const { term, canvas, px, metrics } = await openPinned("hello world\r\nsecond row");
    const [x, y] = px(20, 0);
    pointer(canvas, "pointerdown", x, y);
    pointer(canvas, "pointermove", x, -50);
    pointer(canvas, "pointerup", x, -50);
    expect(term.getSelection(), "above the canvas the drag starts at column zero").toBe("hello world");
    const { term: term2, canvas: canvas2 } = await openPinned("hello world\r\nsecond row");
    const [x2, y2] = px(2, 0);
    pointer(canvas2, "pointerdown", x2, y2);
    pointer(canvas2, "pointermove", x2, ROWS * metrics.height + 50);
    pointer(canvas2, "pointerup", x2, ROWS * metrics.height + 50);
    expect(term2.getSelection(), "below the canvas the drag runs to the last column").toBe("llo world\nsecond row\n\n\n\n");
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
    delete (navigator as { clipboard?: unknown }).clipboard;
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
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const history = term.getScrollbackLength();
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history) + thumbHeight / 2;
    host.dispatchEvent(
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
    delete (navigator as { clipboard?: unknown }).clipboard;
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
});
