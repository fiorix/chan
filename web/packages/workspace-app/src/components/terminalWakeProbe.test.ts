import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createTerminalWakeProbe,
  TERMINAL_WAKE_TICK_CREDIT_MS,
  TERMINAL_WAKE_TICK_MS,
} from "./terminalWakeProbe";

const LIMIT_MS = 3_000;

function probeWith(hidden = false) {
  const state = { hidden, silent: 0 };
  const probe = createTerminalWakeProbe({
    onSilent: () => { state.silent += 1; },
    hidden: () => state.hidden,
  });
  return { probe, state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the terminal wake probe", () => {
  test("an answer ends the probe", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS);
    probe.answered();

    expect(probe.active).toBe(false);
    vi.advanceTimersByTime(LIMIT_MS * 2);
    expect(state.silent).toBe(0);
  });

  test("the limit is the one the wake asked for", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS * 2);

    vi.advanceTimersByTime(LIMIT_MS * 2 - TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(1);
  });

  test("frames extend the deadline from the last one and never end the probe", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS);

    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_MS);
      probe.frameReceived();
    }
    expect(state.silent).toBe(0);
    expect(probe.active).toBe(true);

    vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(1);
    expect(probe.active).toBe(false);
  });

  test("a stall on a shown page adds one tick's credit, not its length", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS);

    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    expect(probe.active).toBe(true);

    vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_CREDIT_MS - TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(1);
  });

  test("a late tick that reaches the limit leaves the verdict to the next tick", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS);
    vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_MS);

    // The stall ends here, with its queued frame still behind this tick.
    vi.setSystemTime(Date.now() + 2_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);

    probe.answered();
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
  });

  test("a stalled page with nothing queued is still given up on, one tick later", () => {
    const { probe, state } = probeWith();
    probe.begin(LIMIT_MS);
    vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_MS);

    vi.setSystemTime(Date.now() + 2_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(1);
  });

  test("a hidden page's throttled ticks count in full across repeated wakes", () => {
    const { probe, state } = probeWith(true);
    probe.begin(LIMIT_MS);

    // A long-hidden page's timers run far apart, and the wake detector
    // reports a gap on each of them, so a new wake must not restart the count.
    vi.setSystemTime(Date.now() + LIMIT_MS - 1_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    probe.begin(LIMIT_MS);
    vi.setSystemTime(Date.now() + LIMIT_MS - 1_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);

    expect(state.silent).toBe(1);
  });
});
