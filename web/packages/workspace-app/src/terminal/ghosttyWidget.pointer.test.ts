// @vitest-environment jsdom
//
// The installed ghostty selection adapter over the widget's pointer
// handling: the drag selects and copies through the adapter, the drag's
// auto-scroll moves through the viewport API, and interrupted drags keep
// their selection without copying. The widget's own suite pins the
// pointer contract itself (element-scoped handling, capture, no document
// listener, the thumb drag through the viewport API).
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
  delete (navigator as { clipboard?: unknown }).clipboard;
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
  // Engines send button -1 on moves (no button changed); only the buttons
  // bitmask says what is held. On macOS the engine fills buttons from the
  // live button state, so a helper move never stands for a released one.
  const buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1;
  const button = type === "pointermove" ? -1 : 0;
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, ...extra }));
}

describe("the ghostty widget's pointer handling", () => {
  test("open adds no listener on document or window", async () => {
    const docAdd = vi.spyOn(document, "addEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    await openTerminal();
    expect(docAdd, "no document listener after open").not.toHaveBeenCalled();
    expect(winAdd, "no window listener after open").not.toHaveBeenCalled();
  });

  test("a press with a below-threshold move selects and copies nothing", async () => {
    const { term, canvas } = await openTerminal();
    const writes: string[] = [];
    expect(installGhosttySelection(term, (text) => void writes.push(text))).toBe(true);
    term.write("hello world\r\nsecond row");
    pointer(canvas, "pointerdown", 1, 1);
    // One pixel: below the half-cell drag threshold, so this stays a tap.
    pointer(canvas, "pointermove", 2, 1);
    pointer(canvas, "pointerup", 2, 1);
    expect(writes, "a jittered press copies nothing").toEqual([]);
    expect(term.hasSelection(), "a jittered press selects nothing").toBe(false);
  });

  test("a drag ended by capture loss alone keeps its selection and copies once", async () => {
    const { term, canvas } = await openTerminal();
    const writes: string[] = [];
    expect(installGhosttySelection(term, (text) => void writes.push(text))).toBe(true);
    term.write("hello world\r\nsecond row");
    pointer(canvas, "pointerdown", 1, 1);
    pointer(canvas, "pointermove", 60, 1);
    expect(term.hasSelection()).toBe(true);
    const selected = term.getSelection();
    canvas.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: false, pointerId: 1, pointerType: "mouse" }));
    // The loss ends the drag as a release: later moves and the release change nothing more.
    pointer(canvas, "pointermove", 100, 2);
    pointer(canvas, "pointerup", 100, 2);
    expect(writes, "the lost drag copies once").toEqual([selected]);
    expect(term.getSelection(), "the lost drag keeps its selection").toBe(selected);
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
