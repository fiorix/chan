import { readFileSync } from "node:fs";
import { CanvasRenderer, Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ghosttyCellMetrics, ghosttyCore, installSoftwareCanvas } from "../__tests__/ghosttyTab";
import { expectPixel, sourceOver } from "../__tests__/softwareCanvas";
import { installGhosttyOverlayScrollbar } from "./ghosttyCompat";
import { GhosttyViewportController } from "./ghosttyViewport";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("fractional output keeps the scrollbar visible and repaints every row until its idle fade ends", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("devicePixelRatio", 1);
  const paint = installSoftwareCanvas();
  const render = vi.spyOn(CanvasRenderer.prototype, "render");
  const host = document.createElement("div");
  document.body.append(host);
  const term = new Terminal({
    ghostty: new GhosttyVt(await WebAssembly.instantiate(vendored, {})),
    cols: 20,
    rows: 8,
    cursorBlink: false,
    theme: { background: "#101010", foreground: "#e0e0e0" },
  });
  try {
    term.open(host);
    // The spy observes the renderer the widget actually opens.
    const renderer = render.mock.contexts[0];
    if (!(renderer instanceof CanvasRenderer)) throw new Error("the widget did not render on its canvas");
    expect(installGhosttyOverlayScrollbar(renderer)).toBe(true);
    const context = paint.context(host);
    const clears = vi.spyOn(context, "clearRect");
    const { width, height } = ghosttyCellMetrics(term);
    const viewport = new GhosttyViewportController(term, {
      os: () => "mac",
      hasMouseTracking: () => false,
      isAlternateScreen: () => false,
      cellHeight: () => height,
    });
    const background = { r: 16, g: 16, b: 16, a: 1 };
    const track = sourceOver({ r: 128, g: 128, b: 128, a: 0.1 }, background);
    const trackPixel = () => context.pixelAt(20 * width - 8, 5);
    const allRows = Array.from({ length: 8 }, (_, row) => [0, row * height, 20 * width, height]);
    const frame = () => {
      clears.mockClear();
      paint.frame();
      return clears.mock.calls;
    };

    viewport.write("\x1b[?25l" + Array.from({ length: 32 }, (_, i) => `line ${i}`).join("\r\n"));
    paint.frame();
    expect(term.getScrollbackLength()).toBeGreaterThan(8);
    expect(frame(), "a clean bottom frame has no rows to repaint").toEqual([]);
    expectPixel(trackPixel(), background);

    term.scrollLines(-0.5);
    vi.advanceTimersByTime(200);
    paint.frame();
    expect(term.getViewportY()).toBe(0.5);
    expect(frame(), "the visible overlay requires every row even without new output").toEqual(allRows);
    expectPixel(trackPixel(), track);

    // Each in-place write changes only one row. Full-screen repaint is the
    // accepted overlay cost, independent of output scrolling the screen.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(500);
      viewport.write(`\x1b[3;1H\x1b[48;2;17;34;${50 + i}mX\x1b[0m`);
      expect(term.getViewportY(), `write ${i} retains the fractional offset`).toBe(0.5);
      expect(ghosttyCore(term)!.getScrollbackLength()).toBe(24);
      expect(frame(), `write ${i} repaints every row`).toEqual(allRows);
      expectPixel(context.pixelAt(width / 2, 2.5 * height), { r: 17, g: 34, b: 50 + i, a: 1 });
      expectPixel(trackPixel(), track);
      expect(frame(), `the clean frame after write ${i} also repaints every row`).toEqual(allRows);
      expectPixel(trackPixel(), track);
    }

    // A quiet terminal releases the overlay and its repaint cost.
    vi.advanceTimersByTime(1500);
    vi.advanceTimersByTime(200);
    paint.frame();
    expect(term.getViewportY()).toBe(0.5);
    expect(frame(), "the quiet fractional view returns to incremental painting").toEqual([]);
    expectPixel(trackPixel(), background);
  } finally {
    term.dispose();
    host.remove();
  }
});
