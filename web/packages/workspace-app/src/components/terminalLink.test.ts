import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LINK_STALLED_MS } from "../api/linkProbe";
import { WS_READ_DEADLINE_MS } from "../api/transport";
import {
  createTerminalLink,
} from "./terminalLink.svelte";

function rig(now: () => number = () => Date.now()) {
  const pings: number[] = [];
  const link = createTerminalLink(() => {
    pings.push(Date.now());
    link.pingSent();
  }, now);
  link.opened();
  return { link, pings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal link", () => {
  test("times pongs and runs the ticker only while an answered socket waits for a pong", () => {
    const { link, pings } = rig();
    expect(vi.getTimerCount()).toBe(0);
    link.pingSent();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(40);
    link.frameArrived();
    link.pongArrived();
    expect(link.state.rttMs).toBe(40);
    expect(link.state.stalled).toBe(false);
    link.pingSent();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(link.state.waitMs).toBe(250);
    link.frameArrived();
    link.pongArrived();
    expect(vi.getTimerCount()).toBe(0);
    expect(link.state.waitMs).toBe(0);
    expect(link.state.rttMs).toBe(250);
    expect(pings).toHaveLength(0);
  });

  test("probes unanswered input at one second, with at least two seconds between input probes", () => {
    const { link, pings } = rig();
    link.inputSent();
    vi.advanceTimersByTime(999);
    expect(pings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000]);
    link.inputSent();
    vi.advanceTimersByTime(1_999);
    expect(pings).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000, 3_000]);
  });

  test("an inbound frame cancels an input probe", () => {
    const { link, pings } = rig();
    link.inputSent();
    vi.advanceTimersByTime(999);
    link.frameArrived();
    vi.advanceTimersByTime(3_000);
    expect(pings).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("later input does not debounce the first input probe", () => {
    const { link, pings } = rig();
    link.inputSent();
    vi.advanceTimersByTime(500);
    link.inputSent();
    vi.advanceTimersByTime(499);
    expect(pings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000]);
  });

  test("a healthy frame records contact with one clock read", () => {
    const now = vi.fn(() => Date.now());
    const { link } = rig(now);
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    now.mockClear();
    link.frameArrived();
    expect(now).toHaveBeenCalledTimes(1);
  });

  test("stalls after four seconds of silence on an answered socket and clears on the first frame", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS - 250);
    expect(link.state.stalled).toBe(false);
    vi.advanceTimersByTime(250);
    expect(link.state.stalled).toBe(true);
    expect(link.state.waitMs).toBe(LINK_STALLED_MS);
    link.frameArrived();
    expect(link.state.stalled).toBe(false);
  });

  test("frames flowing behind a late pong prevent a stall until four seconds after the last frame", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(2_000);
      link.frameArrived();
      expect(link.state.stalled).toBe(false);
    }
    vi.advanceTimersByTime(LINK_STALLED_MS - 250);
    expect(link.state.stalled).toBe(false);
    vi.advanceTimersByTime(250);
    expect(link.state.stalled).toBe(true);
  });

  test("a socket that never answers a ping never stalls or starts a ticker", () => {
    const { link } = rig();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS * 3);
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a wall-clock jump forgets the waiting ping instead of showing an hours-long stall", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.setSystemTime(3_600_000);
    vi.advanceTimersByTime(250);
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    link.frameArrived();
    link.pongArrived();
    expect(link.state.rttMs).toBe(0);
  });

  test("a later unanswered ping stalls after a forgotten wait", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.setSystemTime(3_600_000);
    vi.advanceTimersByTime(250);
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    expect(link.state.stalled).toBe(true);
    expect(link.state.waitMs).toBe(LINK_STALLED_MS);
  });

  test("a ping waiting past the read deadline stops counting and clears its strip state", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS);
    expect(link.state.stalled).toBe(true);
    vi.advanceTimersByTime(250);
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("opening another socket resets a stalled reading and requires its own pong", () => {
    const { link } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    expect(link.state.stalled).toBe(true);
    link.opened();
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    expect(link.state.rttMs).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    expect(link.state.stalled).toBe(false);
  });

  test("retire and dispose release pending probes and ticks and reset the reading", () => {
    const { link, pings } = rig();
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    expect(link.state.stalled).toBe(true);
    link.inputSent();
    expect(vi.getTimerCount()).toBe(2);
    link.retired();
    expect(link.state.stalled).toBe(false);
    expect(link.state.waitMs).toBe(0);
    expect(link.state.rttMs).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
    link.opened();
    link.inputSent();
    expect(vi.getTimerCount()).toBe(1);
    link.dispose();
    expect(vi.getTimerCount()).toBe(0);
    link.opened();
    link.inputSent();
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
  });
});
