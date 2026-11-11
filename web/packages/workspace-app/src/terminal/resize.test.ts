import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFitFrameScheduler,
  createTrailingFitScheduler,
  proposeGhosttyDimensions,
  runTerminalFit,
  shouldReclaimPtySize,
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

  test("runs fit, reports the current terminal size, and says the grid was measured", () => {
    const details: string[] = [];
    const fit = vi.fn();
    const proposeDimensions = () => ({ cols: 80, rows: 24 });
    expect(
      runTerminalFit({ fit, proposeDimensions }, { cols: 80, rows: 24 }, (detail) => details.push(detail)),
    ).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(details).toEqual(["80x24"]);
  });

  test("says the grid was not measured when the fitter declines the host", () => {
    const fit = vi.fn();
    expect(runTerminalFit({ fit, proposeDimensions: () => undefined }, { cols: 80, rows: 24 }, () => {})).toBe(
      false,
    );
    expect(fit).toHaveBeenCalledTimes(1);
  });

  test("says the grid was not measured when a detached or hidden host proposes no finite grid", () => {
    // xterm's fitter reads the host's computed size, which a detached or
    // display:none host does not have, and proposes NaN.
    const proposeDimensions = () => ({ cols: Number.NaN, rows: Number.NaN });
    expect(runTerminalFit({ fit: vi.fn(), proposeDimensions }, { cols: 80, rows: 24 }, () => {})).toBe(false);
  });

  test("a trusted event reclaims the PTY only while it holds another grid", () => {
    const local = { cols: 97, rows: 40 };
    expect(shouldReclaimPtySize({ isTrusted: true }, local, { cols: 61, rows: 40 })).toBe(true);
    expect(shouldReclaimPtySize({ isTrusted: true }, local, { cols: 97, rows: 33 })).toBe(true);
    expect(shouldReclaimPtySize({ isTrusted: true }, local, { cols: 97, rows: 40 })).toBe(false);
    expect(shouldReclaimPtySize({ isTrusted: true }, local, null), "no size broadcast yet").toBe(false);
    expect(shouldReclaimPtySize({ isTrusted: false }, local, { cols: 61, rows: 40 })).toBe(false);
  });

  test("absorbs fit exceptions while layout settles", () => {
    expect(
      runTerminalFit(
        {
          fit() {
            throw new Error("not measurable");
          },
          proposeDimensions: () => ({ cols: 80, rows: 24 }),
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

/// A frame host that holds every frame until the test runs them, as a hidden
/// page holds them until its window comes back.
function heldFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const requestFrame = vi.fn((callback: () => void) => {
    const handle = next++;
    queue.set(handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((handle: number) => {
    queue.delete(handle);
  });
  return {
    host: { requestFrame, cancelFrame },
    pending: () => queue.size,
    run() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("the leading-edge fit frame", () => {
  test("many requests while a frame is pending queue one frame and one fit", () => {
    const frames = heldFrames();
    const runFit = vi.fn();
    const scheduler = createFitFrameScheduler(runFit, frames.host);

    for (let asked = 0; asked < 1000; asked++) scheduler.request();
    expect(frames.host.requestFrame).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(1);

    frames.run();
    expect(runFit).toHaveBeenCalledTimes(1);

    scheduler.request();
    expect(frames.host.requestFrame, "a request after the frame ran schedules again").toHaveBeenCalledTimes(2);
  });

  test("cancel drops the pending frame, and a later request schedules again", () => {
    const frames = heldFrames();
    const runFit = vi.fn();
    const scheduler = createFitFrameScheduler(runFit, frames.host);

    scheduler.request();
    scheduler.cancel();
    expect(frames.host.cancelFrame).toHaveBeenCalledWith(1);
    expect(frames.pending()).toBe(0);

    scheduler.request();
    expect(frames.host.requestFrame).toHaveBeenCalledTimes(2);
    frames.run();
    expect(runFit).toHaveBeenCalledTimes(1);
  });

  test("cancel with nothing pending cancels nothing", () => {
    const frames = heldFrames();
    const scheduler = createFitFrameScheduler(vi.fn(), frames.host);
    scheduler.cancel();
    scheduler.request();
    frames.run();
    scheduler.cancel();
    expect(frames.host.cancelFrame).not.toHaveBeenCalled();
  });

  test("a host that runs the frame before returning fits on every request", () => {
    // The component tests' frame stub runs the callback synchronously, as no
    // browser does; the handle it returns names a frame that already ran.
    const runFit = vi.fn();
    const requestFrame = vi.fn((callback: () => void) => {
      callback();
      return 0;
    });
    const cancelFrame = vi.fn();
    const scheduler = createFitFrameScheduler(runFit, { requestFrame, cancelFrame });
    for (let asked = 0; asked < 3; asked++) scheduler.request();
    expect(requestFrame).toHaveBeenCalledTimes(3);
    expect(runFit).toHaveBeenCalledTimes(3);
    scheduler.cancel();
    expect(cancelFrame).not.toHaveBeenCalled();
  });
});
