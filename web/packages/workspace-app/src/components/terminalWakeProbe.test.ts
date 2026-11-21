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
    quietLimitMs: LIMIT_MS,
    onSilent: () => { state.silent += 1; },
    hidden: () => state.hidden,
  });
  return { probe, state };
}

/// Begin a probe the way the terminal does: its ping follows immediately.
function wake(probe: ReturnType<typeof probeWith>["probe"]): void {
  probe.begin();
  probe.pingSent();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the terminal wake probe", () => {
  test("a heartbeat's pong from before the wake does not end the probe", () => {
    const { probe, state } = probeWith();
    probe.pingSent();
    wake(probe);

    probe.pongReceived();
    expect(probe.active).toBe(true);
    vi.advanceTimersByTime(LIMIT_MS);
    expect(state.silent).toBe(1);
  });

  test("the pong of its own ping ends the probe, even inside the send", () => {
    const { probe, state } = probeWith();
    probe.pingSent();
    probe.pongReceived();
    probe.begin();
    probe.pingSent();
    probe.pongReceived();

    expect(probe.active).toBe(false);
    vi.advanceTimersByTime(LIMIT_MS * 2);
    expect(state.silent).toBe(0);
  });

  test("frames extend the deadline from the last one and never end the probe", () => {
    const { probe, state } = probeWith();
    wake(probe);

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
    wake(probe);

    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    expect(probe.active).toBe(true);

    vi.advanceTimersByTime(LIMIT_MS - TERMINAL_WAKE_TICK_CREDIT_MS - TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(1);
  });

  test("a hidden page's throttled ticks count in full across repeated wakes", () => {
    const { probe, state } = probeWith(true);
    wake(probe);

    // A long-hidden page's timers run far apart, and the wake detector
    // reports a gap on each of them, so a new wake must not restart the count.
    vi.setSystemTime(Date.now() + LIMIT_MS - 1_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);
    expect(state.silent).toBe(0);
    wake(probe);
    vi.setSystemTime(Date.now() + LIMIT_MS - 1_000);
    vi.advanceTimersByTime(TERMINAL_WAKE_TICK_MS);

    expect(state.silent).toBe(1);
  });
});
