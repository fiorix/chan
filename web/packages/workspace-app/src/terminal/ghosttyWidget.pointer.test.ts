// @vitest-environment jsdom
//
// The installed ghostty selection adapter over the widget's pointer
// handling: a tap copies nothing, a drag ended by capture loss copies once,
// and an interrupted drag keeps its selection without copying. The widget's
// own suite pins the pointer contract itself (element-scoped handling,
// capture, no document listener, the thumb drag).
import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { installGhosttySelection } from "./ghosttySelection";
import { modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 40;
const ROWS = 6;

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

/// A ghostty-web terminal on the vendored core, opened in a host, with
/// chan's selection adapter installed; `writes` holds each copy's text.
async function openTerminal() {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: COLS, rows: ROWS, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector("canvas");
  if (!canvas || !term.renderer) throw new Error("ghostty-web opened no canvas");
  const metrics = term.renderer.getMetrics();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, COLS * metrics.width, ROWS * metrics.height));
  modelPointerCapture(canvas);
  const writes: string[] = [];
  expect(installGhosttySelection(term, (text) => void writes.push(text))).toBe(true);
  term.write("hello world\r\nsecond row");
  return { term, canvas, writes };
}

describe("the ghostty selection adapter over the widget's pointer handling", () => {
  test("a press with a below-threshold move selects and copies nothing", async () => {
    const { term, canvas, writes } = await openTerminal();
    mousePointer(canvas, "pointerdown", { clientX: 1, clientY: 1 });
    // One pixel: below the half-cell drag threshold, so this stays a tap.
    mousePointer(canvas, "pointermove", { clientX: 2, clientY: 1 });
    mousePointer(canvas, "pointerup", { clientX: 2, clientY: 1 });
    expect(writes, "a jittered press copies nothing").toEqual([]);
    expect(term.hasSelection(), "a jittered press selects nothing").toBe(false);
  });

  test("a drag ended by capture loss alone keeps its selection and copies once", async () => {
    const { term, canvas, writes } = await openTerminal();
    mousePointer(canvas, "pointerdown", { clientX: 1, clientY: 1 });
    mousePointer(canvas, "pointermove", { clientX: 60, clientY: 1 });
    expect(term.hasSelection()).toBe(true);
    const selected = term.getSelection();
    mousePointer(canvas, "lostpointercapture", { clientX: 60, clientY: 1 });
    // The loss ends the drag as a release: later moves and the release change nothing more.
    mousePointer(canvas, "pointermove", { clientX: 100, clientY: 20 });
    mousePointer(canvas, "pointerup", { clientX: 100, clientY: 20 });
    expect(writes, "the lost drag copies once").toEqual([selected]);
    expect(term.getSelection(), "the lost drag keeps its selection").toBe(selected);
  });

  test("an interrupted drag copies nothing and keeps the selection", async () => {
    const { term, canvas, writes } = await openTerminal();
    mousePointer(canvas, "pointerdown", { clientX: 1, clientY: 1 });
    mousePointer(canvas, "pointermove", { clientX: 60, clientY: 1 });
    mousePointer(canvas, "pointercancel", { clientX: 60, clientY: 1 });
    expect(writes, "the interruption copied nothing").toEqual([]);
    expect(term.hasSelection(), "the interrupted drag kept its selection").toBe(true);
  });
});
