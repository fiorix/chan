// @vitest-environment jsdom
//
// The widget's ordered paint layers, the frame they see, and the three
// renderer options: layers run after the cells, the cursor and the
// scrollbar in ascending order; a disposer removes one; the frame carries
// the context, the metrics, the pixel ratio, the viewport offset, whether
// the frame is full and which rows changed; refresh forces a full frame;
// lineHeight stretches the grid, boxGlyphs draws block elements as paths,
// and the overlay scrollbar paints a translucent track.
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

function recordingContext(log: string[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "measureText") {
          return () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 });
        }
        return (...args: unknown[]) => {
          log.push(`${String(property)}(${args.map((a) => String(a)).join(",")})`);
        };
      },
      set: (_target, property, value) => {
        log.push(`set ${String(property)}=${String(value)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

async function openPinned(input = "", options: Record<string, unknown> = {}, log: string[] = []): Promise<{
  term: Terminal;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  log: string[];
}> {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ ghostty, cols: COLS, rows: ROWS, cursorBlink: false, smoothScrollDuration: 0, ...options });
  const host = document.createElement("div");
  document.body.append(host);
  const ctx = recordingContext(log);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctx) as never);
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("ghostty-web opened no canvas");
  if (input) term.write(input);
  return { term, host, canvas, log };
}

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const FORTY = Array.from({ length: 40 }, (_, n) => `line ${n}`).join("\r\n");

function textsOf(log: string[]): string[] {
  return log.filter((l) => l.startsWith("fillText("));
}

describe("the ghostty widget's paint layers", () => {
  test("a layer paints after the cells, the cursor and the scrollbar", async () => {
    const { term, log } = await openPinned(FORTY);
    term.viewport.scrollTo(10);
    log.length = 0;
    term.addPaintLayer({
      order: 0,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(255, 0, 0)";
        frame.ctx.fillRect(0, 0, 8, 18);
      },
    });
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 1);
    const drawn = textsOf(log);
    expect(drawn.length, "cells and the cursor drew text").toBeGreaterThan(0);
    const layerAt = log.findIndex((l) => l === "set fillStyle=rgb(255, 0, 0)");
    expect(layerAt, "the layer painted").toBeGreaterThan(-1);
    const lastTextAt = log.reduce((at, l, i) => (l.startsWith("fillText(") ? i : at), -1);
    expect(layerAt, "the layer ran after the text").toBeGreaterThan(lastTextAt);
  });

  test("layers run in ascending order whatever the registration order", async () => {
    const { term, log } = await openPinned(FORTY);
    log.length = 0;
    term.addPaintLayer({
      order: 10,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(0, 10, 0)";
        frame.ctx.fillRect(0, 0, 1, 1);
      },
    });
    term.addPaintLayer({
      order: 1,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(0, 1, 0)";
        frame.ctx.fillRect(0, 0, 1, 1);
      },
    });
    term.renderer!.render(term.wasmTerm!, true, 0, 0);
    const first = log.findIndex((l) => l === "set fillStyle=rgb(0, 1, 0)");
    const tenth = log.findIndex((l) => l === "set fillStyle=rgb(0, 10, 0)");
    expect(first, "order 1 painted").toBeGreaterThan(-1);
    expect(tenth, "order 10 painted").toBeGreaterThan(-1);
    expect(first, "order 1 ran first").toBeLessThan(tenth);
  });

  test("the disposer removes a layer and a later frame does not call it", async () => {
    const { term, log } = await openPinned(FORTY);
    log.length = 0;
    const dispose = term.addPaintLayer({
      order: 0,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(9, 9, 9)";
        frame.ctx.fillRect(0, 0, 1, 1);
      },
    });
    dispose();
    term.renderer!.render(term.wasmTerm!, true, 0, 0);
    expect(log.findIndex((l) => l === "set fillStyle=rgb(9, 9, 9)"), "the removed layer stayed silent").toBe(-1);
  });

  test("a later layer paints over an earlier one", async () => {
    const { term, log } = await openPinned(FORTY);
    log.length = 0;
    term.addPaintLayer({
      order: 0,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(0, 0, 1)";
        frame.ctx.fillRect(0, 0, 8, 18);
      },
    });
    term.addPaintLayer({
      order: Number.MAX_SAFE_INTEGER,
      paint: (frame) => {
        frame.ctx.fillStyle = "rgb(1, 0, 0)";
        frame.ctx.fillRect(0, 0, 8, 18);
      },
    });
    term.renderer!.render(term.wasmTerm!, true, 0, 0);
    const first = log.findIndex((l) => l === "set fillStyle=rgb(0, 0, 1)");
    const last = log.findIndex((l) => l === "set fillStyle=rgb(1, 0, 0)");
    expect(first, "the early layer painted").toBeGreaterThan(-1);
    expect(last, "the last layer painted").toBeGreaterThan(-1);
    expect(last, "the last layer painted over the early one").toBeGreaterThan(first);
  });
});

describe("the ghostty widget's paint frame", () => {
  test("a full frame then a partial one carry what changed", async () => {
    const { term } = await openPinned(FORTY);
    const seen: { full: boolean; offset: number; rows: number[]; ratio: number }[] = [];
    term.addPaintLayer({
      order: 0,
      paint: (frame) => {
        seen.push({ full: frame.full, offset: frame.viewportOffset, rows: [...frame.changedRows], ratio: frame.pixelRatio });
        expect(frame.ctx, "a context").toBeDefined();
        expect(frame.metrics, "the metrics").toEqual(term.renderer!.getMetrics());
      },
    });
    term.viewport.scrollTo(10);
    term.renderer!.render(term.wasmTerm!, true, term.viewportY, 0);
    const full = seen.at(-1)!;
    expect(full.full, "a forced frame is full").toBe(true);
    expect(full.offset, "the offset").toBe(10);
    expect(full.rows.length, "every row changed").toBe(ROWS);
    expect(full.ratio, "the pixel ratio").toBe(1);
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 0);
    const scrolled = seen.at(-1)!;
    expect(scrolled.full, "a settled scrolled frame is not full").toBe(false);
    expect(scrolled.rows.length, "a scrolled view repaints").toBe(ROWS);
    term.viewport.scrollToBottom();
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 0);
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 0);
    const quiet = seen.at(-1)!;
    expect(quiet.full, "an idle frame is not full").toBe(false);
    expect(quiet.rows, "no row changed").toEqual([]);
    term.write("hello");
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 0);
    const partial = seen.at(-1)!;
    expect(partial.full, "a write is not a full frame").toBe(false);
    expect(partial.rows, "the written row changed").toContain(ROWS - 1);
  });

  test("refresh forces a full frame", async () => {
    const { term } = await openPinned(FORTY);
    const seen: boolean[] = [];
    term.addPaintLayer({ order: 0, paint: (frame) => void seen.push(frame.full) });
    term.renderer!.render(term.wasmTerm!, false, 0, 0);
    term.renderer!.render(term.wasmTerm!, false, 0, 0);
    expect(seen.at(-1), "an idle frame is not full").toBe(false);
    term.refresh();
    expect(seen.at(-1), "refresh forced a full frame").toBe(true);
  });
});

describe("the ghostty widget's paint options", () => {
  test("lineHeight stretches the grid", async () => {
    const low = await openPinned("", { lineHeight: 1 });
    const high = await openPinned("", { lineHeight: 2 });
    const short = low.term.renderer!.getMetrics().height;
    const tall = high.term.renderer!.getMetrics().height;
    expect(tall, "a doubled line height stretches the cell").toBeGreaterThan(short);
  });

  test("boxGlyphs draws block elements as paths, not the font", async () => {
    const plain = await openPinned("", {}, []);
    plain.term.write("█");
    plain.term.renderer!.render(plain.term.wasmTerm!, true, 0, 0);
    const plainRects = plain.log.filter((l) => l.startsWith("fillRect(")).length;
    const shaped = await openPinned("", { boxGlyphs: true }, []);
    shaped.term.write("█");
    shaped.term.renderer!.render(shaped.term.wasmTerm!, true, 0, 0);
    expect(textsOf(shaped.log).join(""), "the font drew no block").not.toContain("█");
    expect(textsOf(plain.log).join(""), "without the option the font drew it").toContain("█");
    const shapedRects = shaped.log.filter((l) => l.startsWith("fillRect(")).length;
    expect(shapedRects, "the path painted over the background").toBeGreaterThan(plainRects);
  });

  test("the overlay scrollbar paints onto the content, not over an opaque strip", async () => {
    const { term, log } = await openPinned(FORTY, { scrollbar: "overlay" });
    term.viewport.scrollTo(10);
    log.length = 0;
    term.renderer!.render(term.wasmTerm!, false, term.viewportY, 1);
    const strip = log.filter((l) => /^(clearRect|fillRect)\(306,0,14,108\)$/.test(l));
    expect(strip, "no opaque full-height strip clear").toEqual([]);
    expect(log.some((l) => l.startsWith("set fillStyle=rgba(128, 128, 128,")), "a translucent track").toBe(true);
  });
});
