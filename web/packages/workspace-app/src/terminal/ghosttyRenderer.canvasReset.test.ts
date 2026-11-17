// @vitest-environment jsdom
//
// A ghostty terminal whose canvas drawing state the host reset at an
// unchanged size: the backing store, CSS size and box are the same, but
// the 2D transform is back to identity. A full pass must paint at full
// scale again, filling the last cell's background in that cell's device
// rectangle.
import { readFileSync } from "node:fs";
import { CanvasRenderer, Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 8;

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class RecordingContext extends SoftwareCanvasContext {
  fills: { rect: number[]; style: string }[] = [];
  override fillRect(x = 0, y = 0, width = 0, height = 0): void {
    const t = this.getTransform();
    this.fills.push({ rect: [x * t.a, y * t.d, width * t.a, height * t.d], style: this.fillStyle });
    super.fillRect(x, y, width, height);
  }
}

async function openAt(ratio: number, cols = COLS, rows = ROWS) {
  vi.stubGlobal("devicePixelRatio", ratio);
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ ghostty, cols, rows, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) contexts.set(this, (context = new RecordingContext(this, 8)));
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  term.open(host);
  const canvas = host.querySelector("canvas")!;
  const context = contexts.get(canvas)!;
  const renderer = term.renderer!;
  return { term, canvas, context, renderer };
}

function deviceRectOfLastCell(renderer: CanvasRenderer, ratio: number, cols = COLS, rows = ROWS): number[] {
  const { width, height } = renderer.getMetrics();
  return [(cols - 1) * width * ratio, (rows - 1) * height * ratio, width * ratio, height * ratio];
}

function covers(fills: { rect: number[] }[], [x, y, width, height]: number[]): boolean {
  return fills.some(({ rect: [fx, fy, fw, fh] }) => fx <= x && fy <= y && fx + fw >= x + width && fy + fh >= y + height);
}

describe("a ghostty canvas reset at an unchanged size", () => {
  test("a full pass paints at full scale again", async () => {
    const { term, canvas, context, renderer } = await openAt(2);
    term.write(`${"x".repeat(COLS)}\r\n`.repeat(ROWS));
    renderer.render(term.wasmTerm!, true, 0, 0);
    const target = deviceRectOfLastCell(renderer, 2);
    expect(term.renderer, "a renderer").toBeDefined();
    expect(covers(context.fills, target), "the baseline paints the last cell").toBe(true);
    // The host reset: a same-size assignment, which resets the state and
    // blanks the pixels, the page not told.
    canvas.width = canvas.width;
    expect(context.getTransform().a, "the reset dropped the scale").toBe(1);
    context.fills.length = 0;
    renderer.render(term.wasmTerm!, true, 0, 0);
    expect(context.getTransform().a, "a full pass restores the scale").toBe(2);
    expect(covers(context.fills, target), "a full pass fills the last cell at full scale").toBe(true);
    term.dispose();
  });

  test("a forced pass after a grid change fills the new last cell at full scale", async () => {
    const { term, context, renderer } = await openAt(2, 20, 8);
    term.write(`${"x".repeat(20)}\r\n`.repeat(8));
    renderer.render(term.wasmTerm!, true, 0, 0);
    // Grow the grid behind the widget: the next render resizes mid-frame,
    // and the resize must re-establish the scale the size assignment reset.
    term.wasmTerm!.resize(30, 8);
    const target = deviceRectOfLastCell(renderer, 2, 30, 8);
    context.fills.length = 0;
    renderer.render(term.wasmTerm!, true, 0, 0);
    expect(context.getTransform().a, "the post-resize pass restores the scale").toBe(2);
    expect(covers(context.fills, target), "the post-resize pass fills the new last cell at full scale").toBe(true);
    term.dispose();
  });
});
