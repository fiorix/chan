import { describe, expect, test, vi } from "vitest";
import {
  alignGhosttyRendererToXterm,
  installGhosttyCustomGlyphs,
  writeGhosttyPreservingScroll,
  xtermCellDimensionsFromMeasurement,
} from "./ghosttyCompat";

describe("Ghostty xterm-compatible font metrics", () => {
  test("uses xterm's device-pixel rounding and line height", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        1,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        2,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
  });

  test("rejects unsettled or invalid measurements", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 0, height: 16 },
        1,
        1.2,
      ),
    ).toBeNull();
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8, height: 16 },
        0,
        1.2,
      ),
    ).toBeNull();
  });

  test("centers Ghostty glyphs in the xterm-sized cell and resizes", () => {
    const renderer = {
      metrics: { width: 9, height: 15, baseline: 11 },
      getMetrics() {
        return { ...this.metrics };
      },
      resize: vi.fn(),
    };

    expect(
      alignGhosttyRendererToXterm(
        renderer as never,
        { width: 8, height: 19 },
        80,
        24,
      ),
    ).toEqual({ width: 8, height: 19, baseline: 13 });
    expect(renderer.metrics).toEqual({
      width: 8,
      height: 19,
      baseline: 13,
    });
    expect(renderer.resize).toHaveBeenCalledWith(80, 24);
  });

  test("fails open if ghostty-web changes its private metrics field", () => {
    const renderer = {
      getMetrics: () => ({ width: 9, height: 15, baseline: 11 }),
      resize: vi.fn(),
    };

    expect(
      alignGhosttyRendererToXterm(
        renderer as never,
        { width: 8, height: 19 },
        80,
        24,
      ),
    ).toBeNull();
    expect(renderer.resize).not.toHaveBeenCalled();
  });
});

describe("Ghostty custom box glyphs", () => {
  function boxRenderer() {
    const context = {
      beginPath: vi.fn(),
      bezierCurveTo: vi.fn(),
      fillStyle: "#aabbcc",
      globalAlpha: 1,
      lineCap: "butt",
      lineJoin: "miter",
      lineTo: vi.fn(),
      lineWidth: 1,
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "#000000",
    };
    const original = vi.fn();
    const renderer = {
      ctx: context,
      getMetrics: () => ({ width: 8, height: 19, baseline: 13 }),
      renderCellText: original,
      resize: vi.fn(),
    };
    return { context, original, renderer };
  }

  function cell(codepoint: number) {
    return {
      bg_b: 0,
      bg_g: 0,
      bg_r: 0,
      codepoint,
      fg_b: 255,
      fg_g: 255,
      fg_r: 255,
      flags: 0,
      grapheme_len: 0,
      hyperlink_id: 0,
      width: 1,
    };
  }

  test("replaces a font horizontal rule with a full-cell path", () => {
    const { context, original, renderer } = boxRenderer();
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(true);

    renderer.renderCellText(cell(0x2500), 2, 3);

    expect(original.mock.calls[0][0].codepoint).toBe(32);
    expect(context.moveTo).toHaveBeenCalledWith(16, 66.5);
    expect(context.lineTo).toHaveBeenCalledWith(24, 66.5);
    expect(context.strokeStyle).toBe("#aabbcc");
    expect(context.stroke).toHaveBeenCalledOnce();
  });

  test("draws rounded corners and leaves ordinary text on Ghostty", () => {
    const { context, original, renderer } = boxRenderer();
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(true);

    renderer.renderCellText(cell(0x256d), 0, 0);
    expect(context.bezierCurveTo).toHaveBeenCalled();

    const ordinary = cell("A".codePointAt(0)!);
    renderer.renderCellText(ordinary, 1, 0);
    expect(original).toHaveBeenLastCalledWith(ordinary, 1, 0, undefined);
  });

  test("fails open if ghostty-web changes its private text hook", () => {
    const renderer = {
      getMetrics: () => ({ width: 8, height: 19, baseline: 13 }),
      resize: vi.fn(),
    };
    expect(installGhosttyCustomGlyphs(renderer as never)).toBe(false);
  });
});

describe("Ghostty scroll preservation", () => {
  function terminal(viewport: number, lengths: number[]) {
    let read = 0;
    return {
      getViewportY: vi.fn(() => viewport),
      getScrollbackLength: vi.fn(() => lengths[read++] ?? lengths.at(-1)!),
      scrollToLine: vi.fn(),
      write: vi.fn(),
    };
  }

  test("keeps following output when already at the bottom", () => {
    const term = terminal(0, [20]);
    writeGhosttyPreservingScroll(term, "output");
    expect(term.write).toHaveBeenCalledWith("output");
    expect(term.getScrollbackLength).not.toHaveBeenCalled();
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  test("restores a scrolled viewport after output appends lines", () => {
    const term = terminal(7, [20, 23]);
    writeGhosttyPreservingScroll(term, "output");
    expect(term.scrollToLine).toHaveBeenCalledWith(10);
  });

  test("restores the same offset for an in-place screen update", () => {
    const term = terminal(7, [20, 20]);
    writeGhosttyPreservingScroll(term, "output");
    expect(term.scrollToLine).toHaveBeenCalledWith(7);
  });

  test("clamps the restored viewport after scrollback is cleared", () => {
    const term = terminal(7, [20, 3]);
    writeGhosttyPreservingScroll(term, "output");
    expect(term.scrollToLine).toHaveBeenCalledWith(3);
  });
});
