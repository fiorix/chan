// @vitest-environment jsdom
//
// The ghostty widget's highlight layer through a real terminal: a highlight
// paints over the cell background under the glyph, clears back to the
// unhighlighted pixels, and never moves the selection.
import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { expectPixel, sourceOver, SoftwareCanvasContext, type Rgba } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 4;

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];
const contexts: SoftwareCanvasContext[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  contexts.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const context = new SoftwareCanvasContext(this, 8);
    contexts.push(context);
    return context as unknown as CanvasRenderingContext2D;
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

async function openTerminal() {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: COLS, rows: ROWS, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("ghostty-web opened no canvas");
  return { term, host, canvas };
}

function paint(term: Terminal): SoftwareCanvasContext {
  term.renderer!.render(term.wasmTerm!, true, term.viewport.offset, 0);
  const context = contexts[0];
  if (!context) throw new Error("the renderer never took a canvas context");
  return context;
}

function centre(term: Terminal, col: number, row: number): [number, number] {
  const metrics = term.renderer!.getMetrics();
  return [(col + 0.5) * metrics.width, (row + 0.5) * metrics.height];
}

describe("the ghostty widget's highlight layer", () => {
  test("a highlight paints, clears back, and never moves the selection", async () => {
    const { term } = await openTerminal();
    term.write("hello world\r\nsecond row");
    const [x, y] = centre(term, 1, 0);
    const plain = paint(term).pixelAt(x, y);
    term.highlights.set("t", [{ start: { col: 0, absoluteRow: 0 }, end: { col: 4, absoluteRow: 0 } }]);
    const painted = paint(term).pixelAt(x, y);
    expect(painted, "the highlight paints over the cell background").not.toEqual(plain);
    const tint: Rgba = { r: 0xd4, g: 0xd4, b: 0xd4, a: 1 };
    expectPixel(painted, sourceOver(tint, plain));
    expect(term.getSelectionRange(), "the highlight selects nothing").toBeNull();
    expect(term.hasSelection()).toBe(false);
    expect(term.highlights.clear("t")).toBe(true);
    expectPixel(paint(term).pixelAt(x, y), plain);
  });

  test("a highlight keeps a user's selection as it was", async () => {
    const { term } = await openTerminal();
    term.write("hello world\r\nsecond row");
    term.setSelection({ start: { col: 0, absoluteRow: 0 }, end: { col: 4, absoluteRow: 0 } });
    term.highlights.set("t", [{ start: { col: 0, absoluteRow: 1 }, end: { col: 5, absoluteRow: 1 } }]);
    paint(term);
    expect(term.getSelectionRange()).toEqual({ start: { col: 0, absoluteRow: 0 }, end: { col: 4, absoluteRow: 0 } });
    expect(term.getSelection()).toBe("hello");
  });

  test("a highlight style paints its own background", async () => {
    const { term } = await openTerminal();
    term.write("hello world\r\nsecond row");
    const [x, y] = centre(term, 1, 0);
    const plain = paint(term).pixelAt(x, y);
    term.highlights.set("t", [{ start: { col: 0, absoluteRow: 0 }, end: { col: 4, absoluteRow: 0 } }], {
      background: "#ff0000",
    });
    expectPixel(paint(term).pixelAt(x, y), sourceOver({ r: 255, g: 0, b: 0, a: 1 }, plain));
  });
});
