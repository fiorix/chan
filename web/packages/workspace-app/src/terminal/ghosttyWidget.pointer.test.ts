// @vitest-environment jsdom
//
// Stage A (pointer) of part 4 task 2: pointer handling scoped to the
// terminal element with pointer capture and no `document` listener, the
// selection's outside-click behaviour scoped to the element, and the drag
// auto-scroll and the scrollbar thumb drag moved onto `viewport`.
// Each test fails against the base (`91f2c91e0`) and passes with the stage.
import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { installGhosttySelection } from "./ghosttySelection";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// A ghostty-web terminal on the vendored core, opened in a host; `sent` is
/// every string the terminal handed the program.
async function openTerminal() {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: 40, rows: 6, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  const textarea = host.querySelector("textarea");
  const canvas = host.querySelector("canvas");
  if (!textarea || !canvas) throw new Error("ghostty-web opened no textarea or canvas");
  return { term, host, textarea, canvas, sent };
}

/// A pointer press, move or release at canvas CSS pixels, dispatched where
/// pointer capture would retarget it: on the canvas itself.
function pointer(target: Element, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, ...extra }));
}

describe("the ghostty widget's pointer handling", () => {
  test("open adds no listener on document or window", async () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    await openTerminal();
    expect(docAdd, "no document listener after open").not.toHaveBeenCalled();
    expect(winAdd, "no window listener after open").not.toHaveBeenCalled();
  });

  test("a selection drag that leaves the canvas keeps selecting by pointer capture", async () => {
    const { term, canvas } = await openTerminal();
    const writes: string[] = [];
    expect(installGhosttySelection(term, (text) => void writes.push(text))).toBe(true);
    term.write("hello world\r\nsecond row");
    pointer(canvas, "pointerdown", 1, 1);
    // Far outside the canvas: under pointer capture the move still reaches it.
    pointer(canvas, "pointermove", 500, 300);
    pointer(canvas, "pointerup", 500, 300);
    expect(term.hasSelection(), "the excursion kept the drag selecting").toBe(true);
    expect(writes).toEqual(["hello world\nsecond row"]);
  });

  test("a click outside the terminal element keeps the selection", async () => {
    const { term } = await openTerminal();
    term.write("hello world");
    // The anchors the click-extent installer reads; a structural type, so
    // the test does not reach the manager's private members.
    const manager = (
      term as unknown as {
        selectionManager: {
          selectionStart: { col: number; absoluteRow: number } | null;
          selectionEnd: { col: number; absoluteRow: number } | null;
        };
      }
    ).selectionManager;
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: 4, absoluteRow: 0 };
    expect(term.hasSelection()).toBe(true);
    // A sibling of the host stands in for the find bar.
    const sibling = document.createElement("div");
    document.body.append(sibling);
    sibling.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    expect(term.hasSelection(), "the outside click kept the selection").toBe(true);
    expect(term.getSelection()).toBe("hello");
  });

  test("the selection drag's auto-scroll moves the view through the viewport API", async () => {
    const { term, canvas } = await openTerminal();
    term.write(Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\r\n"));
    expect(term.getScrollbackLength()).toBeGreaterThan(10);
    term.viewport.scrollTo(8);
    const scrollBy = vi.spyOn(term.viewport, "scrollBy");
    const scrollLines = vi.spyOn(term, "scrollLines");
    vi.useFakeTimers();
    try {
      pointer(canvas, "pointerdown", 1, 1);
      // Past the bottom edge, where the drag asks for newer rows.
      pointer(canvas, "pointermove", 1, 500);
      vi.advanceTimersByTime(160);
    } finally {
      vi.useRealTimers();
    }
    expect(scrollBy, "the auto-scroll moved through the viewport API").toHaveBeenCalledWith(-3);
    expect(scrollLines, "no write bypassed the viewport API").not.toHaveBeenCalled();
    expect(term.viewport.offset).toBe(0);
  });

  test("a write during a scrollbar thumb drag keeps the anchor", async () => {
    const { term, canvas } = await openTerminal();
    term.write(Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n"));
    const history = term.getScrollbackLength();
    expect(history).toBeGreaterThan(20);
    term.viewport.scrollTo(10);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 96, width: 320, height: 96, toJSON: () => {},
    });
    const trackHeight = 96 - 4 * 2;
    const thumbHeight = Math.max(20, (6 / (history + 6)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - 10 / history);
    const press = new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: 310, clientY: thumbY });
    (term as unknown as { handlePointerDown(e: PointerEvent): void }).handlePointerDown(press);
    expect((term as unknown as { isDraggingScrollbar: boolean }).isDraggingScrollbar).toBe(true);
    term.write(Array.from({ length: 5 }, (_, n) => `stream ${n}`).join("\r\n"));
    const anchored = term.viewport.offset;
    expect(anchored).toBeGreaterThan(10);
    const move = new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", clientX: 310, clientY: thumbY });
    (term as unknown as { processScrollbarDrag(e: PointerEvent): void }).processScrollbarDrag(move);
    expect(term.viewport.offset, "the drag did not undo the rows the write anchored").toBe(anchored);
  });

  test("a context menu reset hides the textarea when it loses the keyboard", async () => {
    const { canvas, textarea } = await openTerminal();
    vi.useFakeTimers();
    try {
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }));
      expect(textarea.style.pointerEvents, "the menu arms the textarea").toBe("auto");
      vi.advanceTimersByTime(10);
      textarea.blur();
      expect(textarea.style.pointerEvents, "losing the keyboard hides it again").toBe("none");
      expect(textarea.style.width).toBe("0px");
      expect(textarea.value).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an interrupted drag copies nothing and keeps the selection", async () => {
    const { term, canvas } = await openTerminal();
    const writes: string[] = [];
    expect(installGhosttySelection(term, (text) => void writes.push(text))).toBe(true);
    term.write("hello world\r\nsecond row");
    pointer(canvas, "pointerdown", 1, 1);
    pointer(canvas, "pointermove", 60, 1);
    pointer(canvas, "pointercancel", 60, 1);
    expect(writes, "the interruption copied nothing").toEqual([]);
    expect(term.hasSelection(), "the interrupted drag kept its selection").toBe(true);
  });
});
