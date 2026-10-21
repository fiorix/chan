import { vi } from "vitest";

/// The fake timers still pending once the tasks due now have run. svelte
/// queues a zero-delay task when one of its event handlers runs and none is
/// queued, to release its last-event slot, so a raw count read after a click,
/// a pointer event or any other event a component handles includes that task,
/// and only until a test's teardown clears it unrun, which leaves svelte
/// queueing none for the rest of the file. Running the due tasks first counts
/// the code under test's own timers in any test order; code whose own timers
/// are zero-delay cannot be counted this way.
export function pendingTimers(): number {
  vi.advanceTimersByTime(0);
  return vi.getTimerCount();
}
