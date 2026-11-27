// A reactive loop that runs on microtasks alone (an effect whose run settles
// a promise whose callback writes the state the effect reads) never lets a
// timer fire. A case's own time bound and vitest's test timeout both wait on
// a timer, so such a loop hangs the worker and no case is reported at all.
//
// Svelte queues each flush of its effects with the global `queueMicrotask`.
// While `yieldRunawayMicrotasks` is installed, once `limit` of those have
// been queued with no timer turn between them, each further one is queued as
// a timer instead and counted: the loop goes on, but yields between its runs,
// so the case can read the count and fail by name, and a bound measured by
// the clock can end it. Below the limit nothing changes, so a case that does
// not loop runs as it would without it.

export type MicrotaskYield = {
  /// The microtasks queued as timers so far: more than zero once a loop ran
  /// past the limit.
  readonly yielded: number;
  /// Puts the global `queueMicrotask` back.
  release(): void;
};

/// Install it before `trackTimers`: the deferred flushes go through the
/// timer functions of the moment it is installed, so a teardown that clears
/// the timers a case armed leaves them alone. Svelte queues no further flush
/// while one it queued has not run, so a flush lost there would stop every
/// effect of the file's later cases.
export function yieldRunawayMicrotasks(limit = 10_000): MicrotaskYield {
  const native = globalThis.queueMicrotask;
  const later = globalThis.setTimeout;
  let queued = 0;
  let turnArmed = false;
  let yielded = 0;
  globalThis.queueMicrotask = (callback: VoidFunction): void => {
    if (!turnArmed) {
      turnArmed = true;
      later(() => {
        queued = 0;
        turnArmed = false;
      }, 0);
    }
    queued += 1;
    if (queued > limit) {
      yielded += 1;
      later(callback, 0);
    } else native(callback);
  };
  return {
    get yielded() {
      return yielded;
    },
    release() {
      globalThis.queueMicrotask = native;
    },
  };
}
