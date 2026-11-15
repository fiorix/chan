// Timers a mounted app arms outlive its component tree. Module state holds
// debounces, pollers and detectors that unmounting does not stop, so a test
// that mounts the real App leaves them running into the next test, and one
// that fires after the file's environment is torn down fails the run with
// every test passing (`window is not defined`), or reaches the transport after
// uninstallDemoWorkspace. The tests that mount the app track every timer armed
// while a test runs and clear the ones still pending in its teardown.

type Handle = ReturnType<typeof setTimeout>;
type Callback = (...args: unknown[]) => void;

export interface TimerTrack {
  /// Clear every timeout, interval and animation frame armed since
  /// `trackTimers` that has not fired or been cleared, put the global
  /// functions back, and return how many were cleared. Run it with real
  /// timers installed: fake timers installed after tracking began would
  /// otherwise be put back over.
  release(): number;
}

/// jsdom runs every outstanding animation frame from one interval it starts,
/// through the global setInterval, on the first request, and stops it when
/// none is left. That interval is its frame loop, not a timer of the test's:
/// clearing it would leave jsdom counting frames that never run, and no later
/// frame in the file would. Frames are released by cancelling them instead.
function armedByJsdomFrameLoop(): boolean {
  return new Error().stack?.includes("/jsdom/browser/Window.js") ?? false;
}

/// Track the timers and animation frames armed from now until `release`.
/// Clearing a timer leaves its module's handle and pending work behind, so
/// call the module's own stop before releasing the tracked timers
/// (the index poll's `stopIndexStatusPoller` and the session refetch's
/// `stopSessionSyncRefetch`, plus the store's `teardown` for the pane-width
/// and page-width debounces and their pending preference edits).
///
/// One limit: d3-timer binds `window.requestAnimationFrame` when its module
/// loads, before any test runs, so the graph simulation's frame loop goes to
/// jsdom directly and is not tracked here. GraphCanvas stops its simulation
/// when it is destroyed.
export function trackTimers(): TimerTrack {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const timeouts = new Set<Handle>();
  const intervals = new Set<Handle>();
  const frames = new Set<number>();

  globalThis.setTimeout = ((handler: Callback, delay?: number, ...args: unknown[]) => {
    const id: Handle = real.setTimeout(
      (...fired: unknown[]) => {
        timeouts.delete(id);
        handler(...fired);
      },
      delay,
      ...args,
    );
    timeouts.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: Handle) => {
    if (id !== undefined) timeouts.delete(id);
    real.clearTimeout(id);
  }) as typeof clearTimeout;
  globalThis.setInterval = ((handler: Callback, delay?: number, ...args: unknown[]) => {
    const id: Handle = real.setInterval(handler, delay, ...args);
    if (!armedByJsdomFrameLoop()) intervals.add(id);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id?: Handle) => {
    if (id !== undefined) intervals.delete(id);
    real.clearInterval(id);
  }) as typeof clearInterval;
  if (typeof real.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      // A test's stub may run the callback before returning its handle.
      let ran = false;
      let id = 0;
      id = real.requestAnimationFrame((time) => {
        ran = true;
        frames.delete(id);
        callback(time);
      });
      if (!ran) frames.add(id);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      frames.delete(id);
      real.cancelAnimationFrame(id);
    }) as typeof cancelAnimationFrame;
  }

  return {
    release(): number {
      const cleared = timeouts.size + intervals.size + frames.size;
      // Frames first, through jsdom's own cancel, which stops its frame loop
      // once none is left.
      for (const id of frames) real.cancelAnimationFrame(id);
      for (const id of timeouts) real.clearTimeout(id);
      for (const id of intervals) real.clearInterval(id);
      frames.clear();
      timeouts.clear();
      intervals.clear();
      Object.assign(globalThis, real);
      return cleared;
    },
  };
}
