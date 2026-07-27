import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createTrailingFitScheduler,
  proposeGhosttyDimensions,
  runTerminalFit,
} from "./resize";

describe("terminal resize helpers", () => {
  afterEach(() => vi.useRealTimers());

  test("ghostty uses the full padded width without a scrollbar gutter", () => {
    expect(
      proposeGhosttyDimensions(
        { width: 100, height: 100 },
        { top: 5, right: 5, bottom: 5, left: 5 },
        { width: 15, height: 18 },
      ),
    ).toEqual({ cols: 6, rows: 5 });
  });

  test("ghostty waits for measurable cells and a visible host", () => {
    const box = { width: 100, height: 100 };
    const padding = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(
      proposeGhosttyDimensions(box, padding, { width: 0, height: 18 }),
    ).toBeNull();
    expect(
      proposeGhosttyDimensions(box, padding, { width: 15, height: 0 }),
    ).toBeNull();
    expect(
      proposeGhosttyDimensions({ width: 0, height: 100 }, padding, {
        width: 15,
        height: 18,
      }),
    ).toBeNull();
    expect(
      proposeGhosttyDimensions({ width: 100, height: 0 }, padding, {
        width: 15,
        height: 18,
      }),
    ).toBeNull();
  });

  test("ghostty keeps upstream minimum terminal dimensions", () => {
    expect(
      proposeGhosttyDimensions(
        { width: 1, height: 1 },
        { top: 5, right: 5, bottom: 5, left: 5 },
        { width: 15, height: 18 },
      ),
    ).toEqual({ cols: 2, rows: 1 });
  });

  test("runs fit and reports the current terminal size", () => {
    const details: string[] = [];
    const fit = vi.fn();
    expect(runTerminalFit({ fit }, { cols: 80, rows: 24 }, (detail) => details.push(detail))).toBe(
      true,
    );
    expect(fit).toHaveBeenCalledTimes(1);
    expect(details).toEqual(["80x24"]);
  });

  test("absorbs fit exceptions while layout settles", () => {
    expect(
      runTerminalFit(
        {
          fit() {
            throw new Error("not measurable");
          },
        },
        { cols: 80, rows: 24 },
        () => {},
      ),
    ).toBe(false);
  });

  test("coalesces trailing-edge fits", () => {
    vi.useFakeTimers();
    const runFit = vi.fn();
    const scheduler = createTrailingFitScheduler(runFit, 120);

    scheduler.schedule();
    vi.advanceTimersByTime(80);
    scheduler.schedule();
    vi.advanceTimersByTime(119);
    expect(runFit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runFit).toHaveBeenCalledTimes(1);
  });
});
