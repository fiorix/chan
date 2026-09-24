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
  /// Clear every timeout and interval armed since `trackTimers` that has not
  /// fired or been cleared, put the global timer functions back, and return
  /// how many were cleared. Run it with real timers installed: fake timers
  /// installed after tracking began would otherwise be put back over.
  release(): number;
}

/// Track the timers armed from now until `release`. Clearing a timer leaves
/// the handle its module keeps, so a module that refuses to re-arm while its
/// handle is set needs its own stop called first (the index poll's
/// `stopIndexStatusPoller`).
export function trackTimers(): TimerTrack {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const timeouts = new Set<Handle>();
  const intervals = new Set<Handle>();

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
    intervals.add(id);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id?: Handle) => {
    if (id !== undefined) intervals.delete(id);
    real.clearInterval(id);
  }) as typeof clearInterval;

  return {
    release(): number {
      const cleared = timeouts.size + intervals.size;
      for (const id of timeouts) real.clearTimeout(id);
      for (const id of intervals) real.clearInterval(id);
      timeouts.clear();
      intervals.clear();
      Object.assign(globalThis, real);
      return cleared;
    },
  };
}
