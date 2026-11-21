import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTerminalConnectionHealth,
  TERMINAL_INPUT_NOTICE_MS,
  TERMINAL_INPUT_NOTICE_MIN_MS,
} from "./terminalConnectionHealth.svelte";

function rig(now: () => number = () => Date.now()) {
  const pings: number[] = [];
  const connection = createTerminalConnectionHealth(() => {
    pings.push(Date.now());
    connection.pingSent();
  }, now);
  connection.opened();
  return { connection, pings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal connection", () => {
  test("warns after unanswered input retires and clears at next input or twelve visible seconds", () => {
    const { connection } = rig();
    connection.inputSent();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(11_999);
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(connection.state.notice).toBe(false);
    connection.inputSent();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.inputSent();
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MIN_MS);
    connection.inputSent();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("input stays in flight until a pong answers a ping sent after it", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.pongArrived();
    connection.inputSent();
    vi.advanceTimersByTime(1);
    connection.pingSent();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("does not warn without input", () => {
    const { connection } = rig();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a ping stamped in the same millisecond as the input does not answer it", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.inputSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("a key in the same millisecond as the probe fire, key first, is answered by that ping", () => {
    let t = 0;
    const { connection } = rig(() => t);
    connection.inputSent();
    vi.advanceTimersByTime(999);
    t = 1000;
    connection.inputSent();
    vi.advanceTimersByTime(1);
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a backward clock step between a key and its probe leaves no false notice", () => {
    let t = 2000;
    const { connection } = rig(() => t);
    connection.inputSent();
    t = 500;
    vi.advanceTimersByTime(1000);
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a pong before the probe fires does not cancel the input probe", () => {
    const { connection, pings } = rig();
    connection.pingSent();
    connection.inputSent();
    vi.advanceTimersByTime(500);
    connection.pongArrived();
    vi.advanceTimersByTime(500);
    expect(pings).toHaveLength(1);
    connection.dispose();
  });

  test("a pong for a ping sent after the key answers it across a new socket", () => {
    const { connection } = rig();
    connection.inputSent();
    vi.advanceTimersByTime(1);
    connection.pingSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a late pong for a ping sent before the input does not answer it once the probe has left", () => {
    const { connection, pings } = rig();
    connection.pingSent();
    vi.advanceTimersByTime(500);
    connection.inputSent();
    vi.advanceTimersByTime(1000);
    expect(pings).toHaveLength(1);
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("a pong for the first of two pings after a key still answers it", () => {
    let t = 0;
    const { connection } = rig(() => t);
    connection.inputSent();
    t = 100;
    connection.pingSent();
    t = 200;
    connection.pingSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a pong for a ping sent before the input does not answer it", () => {
    const { connection } = rig();
    connection.pingSent();
    vi.advanceTimersByTime(500);
    connection.inputSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("a pong that answers a long-waiting ping does not clear later input", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(50_000);
    connection.inputSent();
    vi.advanceTimersByTime(100);
    connection.pingSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("does not warn when a later pong answered the input", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.pongArrived();
    connection.inputSent();
    vi.advanceTimersByTime(1);
    connection.pingSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("continued typing cannot dismiss the notice before four visible seconds", () => {
    const { connection } = rig();
    connection.inputRefused();
    connection.retired();
    connection.opened();
    vi.advanceTimersByTime(3_999);
    connection.inputSent();
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(connection.state.notice).toBe(true);
    connection.inputSent();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("refused input before any socket has opened cannot seed a notice", () => {
    const connection = createTerminalConnectionHealth(() => {});
    connection.inputRefused();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("holds the input warning under a cover and shows it for twelve uncovered seconds", () => {
    const { connection } = rig();
    connection.inputSent();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(2_000);
    connection.setNoticeBlocked(true);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(connection.state.notice).toBe(true);
    connection.setNoticeBlocked(false);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS - 2_001);
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a hidden tab pauses the warning until it is shown again", () => {
    const { connection } = rig();
    connection.inputRefused();
    connection.retired();
    connection.setNoticeBlocked(true);
    connection.opened();
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(connection.state.notice).toBe(true);
    connection.setNoticeBlocked(false);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS);
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a second retirement preserves a visible warning with a fresh lifetime", () => {
    const { connection } = rig();
    connection.inputRefused();
    connection.retired();
    connection.opened();
    vi.advanceTimersByTime(2_000);
    connection.retired();
    connection.opened();
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS - 1);
    expect(connection.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("refused input after a prior opening warns on the next opening", () => {
    const { connection } = rig();
    connection.retired();
    connection.inputRefused();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    connection.dispose();
  });

  test("retire clears a pending notice timer", () => {
    const { connection } = rig();
    connection.inputRefused();
    connection.retired();
    connection.opened();
    expect(vi.getTimerCount()).toBe(1);
    connection.retired();
    expect(vi.getTimerCount()).toBe(0);
    connection.dispose();
  });

  test("probes unanswered input at one second, with at least two seconds between input probes", () => {
    const { connection, pings } = rig();
    connection.inputSent();
    vi.advanceTimersByTime(999);
    expect(pings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000]);
    connection.inputSent();
    vi.advanceTimersByTime(1_999);
    expect(pings).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000, 3_000]);
  });

  test("later input does not debounce the first input probe", () => {
    const { connection, pings } = rig();
    connection.inputSent();
    vi.advanceTimersByTime(500);
    connection.inputSent();
    vi.advanceTimersByTime(499);
    expect(pings).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pings).toEqual([1_000]);
  });

  test("retire and dispose release pending probes and the note's timer", () => {
    const { connection, pings } = rig();
    connection.inputSent();
    expect(vi.getTimerCount()).toBe(1);
    connection.retired();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
    connection.opened();
    expect(connection.state.notice, "the retired input is owed a note").toBe(true);
    connection.inputSent();
    expect(vi.getTimerCount(), "the note's lifetime and the input probe").toBe(2);
    connection.dispose();
    expect(connection.state.notice).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    connection.opened();
    connection.inputSent();
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
  });
});
