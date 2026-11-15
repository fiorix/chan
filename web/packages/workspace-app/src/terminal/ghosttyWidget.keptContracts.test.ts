// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const COLS = 40;
const ROWS = 6;
let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
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

async function openTerminal() {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: COLS, rows: ROWS, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const canvas = host.querySelector("canvas");
  if (!canvas || !term.renderer) throw new Error("the widget did not open its canvas");
  const metrics = term.renderer.getMetrics();
  return {
    term,
    click(column: number, row: number) {
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: rect.left + (column + 0.5) * metrics.width,
        clientY: rect.top + (row + 0.5) * metrics.height,
      }));
    },
  };
}

describe("the widget's links through its registered providers", () => {
  test("the registered OSC8 provider opens an explicit label's URI through the real buffer", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const screen = await openTerminal();
    screen.term.write("\x1b]8;;https://e.x/a\x1b\\link\x1b]8;;\x1b\\ text");
    screen.click(1, 0);
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("https://e.x/a", "_blank", "noopener,noreferrer"));
  });

  test("the registered regex provider opens a plain URL through the real buffer", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const screen = await openTerminal();
    screen.term.write("https://plain.example/b");
    screen.click(4, 0);
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("https://plain.example/b", "_blank", "noopener,noreferrer"));
  });

  test("the registered OSC8 provider opens a link after its row enters history", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const screen = await openTerminal();
    screen.term.write("\x1b]8;;https://e.x/a\x1b\\link\x1b]8;;\x1b\\\r\n" + "line\r\n".repeat(ROWS));
    const history = screen.term.getScrollbackLength();
    expect(history).toBeGreaterThan(0);
    screen.term.scrollToLine(history);
    expect(screen.term.getViewportY()).toBe(history);
    screen.click(1, 0);
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("https://e.x/a", "_blank", "noopener,noreferrer"));
  });
});

describe("the widget's retained selection and buffer reads", () => {
  test("selectLines selects the requested lines and replaces an earlier selection", async () => {
    const { term } = await openTerminal();
    term.write("alpha\r\nbeta\r\ngamma");
    term.select(0, 1, 2);
    expect(term.getSelection()).toBe("be");
    term.selectLines(0, 1);
    expect(term.hasSelection()).toBe(true);
    expect(term.getSelection()).toBe("alpha\nbeta");
    term.selectLines(2, 2);
    expect(term.getSelection()).toBe("gamma");
    term.clearSelection();
    expect(term.hasSelection()).toBe(false);
  });

  test("the buffer exposes written cells, widths, wrapping and bounds", async () => {
    const { term } = await openTerminal();
    term.write("\u65e5 x\r\n" + "x".repeat(COLS + 2));
    const buffer = term.buffer.active;
    expect(buffer).toBe(term.buffer.normal);
    expect(buffer.type).toBe("normal");
    expect(buffer.length).toBe(ROWS);
    const first = buffer.getLine(0);
    expect(first?.length).toBe(COLS);
    expect(first?.getCell(0)?.getChars()).toBe("\u65e5");
    expect(first?.getCell(0)?.getWidth()).toBe(2);
    expect(first?.getCell(1)?.getWidth()).toBe(0);
    expect(first?.getCell(3)?.getCodepoint()).toBe("x".codePointAt(0));
    expect(first?.getCell(3)?.getHyperlinkId()).toBe(0);
    expect(first?.getCell(-1)).toBeUndefined();
    expect(first?.getCell(COLS)).toBeUndefined();
    expect(buffer.getLine(-1)).toBeUndefined();
    expect(buffer.getLine(ROWS)).toBeUndefined();
    expect(buffer.getLine(1)?.isWrapped).toBe(false);
    expect(buffer.getLine(2)?.isWrapped).toBe(true);
    expect(buffer.getLine(2)?.translateToString(true)).toBe("xx");
  });

  test("the active buffer changes identity for the alternate screen and back", async () => {
    const { term } = await openTerminal();
    const normal = term.buffer.normal;
    term.write("normal\x1b[?1049h\x1b[2;1Halternate");
    expect(term.buffer.active === term.buffer.alternate, "the alternate screen exposes its alternate buffer").toBe(true);
    expect(term.buffer.active).not.toBe(normal);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.length).toBe(ROWS);
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("alternate");
    term.write("\x1b[?1049l");
    expect(term.buffer.active).toBe(normal);
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("normal");
  });
});
