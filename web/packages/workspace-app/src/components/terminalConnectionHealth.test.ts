import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CONNECTION_STALLED_MS } from "../api/connectionProbe";
import { WS_READ_DEADLINE_MS } from "../api/transport";
import {
  createTerminalConnectionHealth,
  TERMINAL_INPUT_NOTICE_MS,
  TERMINAL_INPUT_NOTICE_MIN_MS,
  TERMINAL_STALL_REDIAL_MS,
  TERMINAL_REDIAL_SPACING_MS,
  TERMINAL_CONNECTION_TICK_MS,
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
  function answeredStall(connection: ReturnType<typeof createTerminalConnectionHealth>): void {
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
  }

  function redialRig(allowed = true) {
    let contactAt: number | null = null;
    const runs = vi.fn();
    const connection = createTerminalConnectionHealth(() => {}, () => Date.now(), {
      canRedial: () => allowed,
      lastContactAt: () => contactAt,
      run: runs,
    });
    connection.opened();
    return { connection, runs, contact: (at: number | null) => { contactAt = at; } };
  }

  test("counts one terminal stall from the earlier window wait through window loss", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    vi.advanceTimersByTime(10_000);
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    connection.windowChanged("stalled", false, 5_000);
    expect(connection.state.waitMs).toBe(9_000);
    connection.windowChanged("down", false);
    vi.advanceTimersByTime(1_000);
    expect(connection.state.waitMs).toBe(10_000);
    connection.frameArrived();
    expect(connection.state.stalled).toBe(false);
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.waitMs).toBe(CONNECTION_STALLED_MS);
    connection.dispose();
  });

  test("waits for watcher contact newer than the terminal stall, then three seconds of ok", () => {
    expect(TERMINAL_STALL_REDIAL_MS).toBe(3_000);
    const { connection, runs, contact } = redialRig();
    contact(0);
    connection.windowChanged("ok", false);
    answeredStall(connection);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TERMINAL_REDIAL_SPACING_MS + 1_000);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test.each(["slow", "unknown", "stalled", "down"] as const)("does not redial while the window is %s", (windowState) => {
    const { connection, runs, contact } = redialRig();
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged(windowState, false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    connection.dispose();
  });

  test("restarts the healthy-window wait if ok lapses", () => {
    const { connection, runs, contact } = redialRig();
    connection.windowChanged("ok", false);
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    connection.windowChanged("slow", false);
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test("holds input in flight through an unrelated frame and releases it on a later pong", () => {
    const { connection, runs, contact } = redialRig();
    connection.windowChanged("ok", false);
    connection.pingSent();
    connection.pongArrived();
    vi.advanceTimersByTime(1000);
    connection.inputSent();
    connection.pingSent();
    connection.frameArrived();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("spaces terminal redials by thirty seconds across socket retirements", () => {
    const { connection, runs, contact } = redialRig();
    connection.windowChanged("ok", false);
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    const firstRedialAt = Date.now();
    connection.retired();
    connection.opened();
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(firstRedialAt + 30_000 - Date.now() - 1);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(2);
    connection.dispose();
  });

  test("does not redial after retire or when the session owner refuses it", () => {
    const { connection, runs, contact } = redialRig(false);
    connection.windowChanged("ok", false);
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    connection.retired();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    connection.dispose();
  });

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

  test("an unrelated frame does not answer in-flight input", () => {
    const { connection, runs, contact } = redialRig();
    connection.windowChanged("ok", false);
    connection.pingSent();
    connection.pongArrived();
    connection.inputSent();
    vi.advanceTimersByTime(1000);
    connection.pingSent();
    connection.frameArrived();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
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

  test("warns when only a frame arrived after input", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.pongArrived();
    connection.inputSent();
    connection.pingSent();
    connection.frameArrived();
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
    connection.pingSent();
    connection.pongArrived();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("mouse and wheel bytes hold a stalled socket without arming a probe or a lost-input warning", () => {
    const { connection, runs, contact } = redialRig();
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    connection.inputWritten();
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS + 1_000);
    expect(runs).not.toHaveBeenCalled();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("a pending redial survives a read deadline and can replace a retiring socket", () => {
    const { connection, runs, contact } = redialRig();
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(2_000);
    connection.retiring();
    expect(connection.state.lost).toBe(true);
    vi.advanceTimersByTime(999);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test("the read deadline starts a never-answered socket's three-second redial wait", () => {
    const { connection, runs, contact } = redialRig();
    contact(0);
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS);
    connection.retiring();
    expect(connection.state.stalled).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 1);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test("a retiring never-answered socket polls fresh watcher contact without a state change", () => {
    const { connection, runs, contact } = redialRig();
    connection.windowChanged("ok", false);
    connection.retiring();
    contact(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 1);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TERMINAL_CONNECTION_TICK_MS + 1);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test("a never-answered retiring socket keeps user input in flight and refuses unhealthy watcher state", () => {
    const { connection, runs, contact } = redialRig();
    connection.inputWritten();
    connection.retiring();
    contact(Date.now());
    connection.windowChanged("slow", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    connection.dispose();
  });

  test("a never-answered retiring socket waits for ok watcher state", () => {
    const { connection, runs, contact } = redialRig();
    connection.retiring();
    contact(Date.now());
    connection.windowChanged("slow", false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  test("a never-answered retiring socket keeps thirty-second redial spacing", () => {
    const { connection, runs, contact } = redialRig();
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    const firstRedialAt = Date.now();
    connection.retired();
    connection.opened();
    connection.retiring();
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(firstRedialAt + 30_000 - Date.now() - 1);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(2);
    connection.dispose();
  });

  test("a retiring socket keeps input in flight until its close callback", () => {
    const { connection, runs, contact } = redialRig();
    answeredStall(connection);
    connection.inputWritten();
    connection.retiring();
    contact(Date.now());
    connection.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
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
    connection.windowChanged("down", true);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(connection.state.notice).toBe(true);
    connection.windowChanged("ok", false);
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
    connection.windowChanged("down", true);
    connection.opened();
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(connection.state.notice).toBe(true);
    connection.windowChanged("ok", false);
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

  test("retiring keeps the stalled reading past the deadline and clears it on close", () => {
    const { connection } = rig();
    answeredStall(connection);
    connection.retiring();
    expect(connection.state.retiring).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS + 250);
    connection.pingSent();
    expect(connection.state.stalled).toBe(true);
    connection.retired();
    expect(connection.state.retiring).toBe(false);
    expect(connection.state.stalled).toBe(false);
    connection.dispose();
  });

  test("retire clears a pending redial timer", () => {
    const { connection, contact } = redialRig();
    connection.windowChanged("ok", false);
    answeredStall(connection);
    contact(Date.now());
    connection.windowChanged("ok", false);
    expect(vi.getTimerCount()).toBe(2);
    connection.retired();
    expect(vi.getTimerCount()).toBe(0);
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

  test("a stall on the next socket replaces the input warning", () => {
    const { connection } = rig();
    connection.inputSent();
    connection.retired();
    connection.opened();
    expect(connection.state.notice).toBe(true);
    answeredStall(connection);
    expect(connection.state.notice).toBe(false);
    connection.dispose();
  });

  test("runs the ticker only while an answered socket waits for a pong", () => {
    const { connection, pings } = rig();
    expect(vi.getTimerCount()).toBe(0);
    connection.pingSent();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(40);
    connection.frameArrived();
    connection.pongArrived();
    expect(connection.state.stalled).toBe(false);
    connection.pingSent();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(connection.state.waitMs).toBe(250);
    connection.frameArrived();
    connection.pongArrived();
    expect(vi.getTimerCount()).toBe(0);
    expect(connection.state.waitMs).toBe(0);
    expect(pings).toHaveLength(0);
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

  test("an inbound frame cancels an input probe", () => {
    const { connection, pings } = rig();
    connection.inputSent();
    vi.advanceTimersByTime(999);
    connection.frameArrived();
    vi.advanceTimersByTime(3_000);
    expect(pings).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
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

  test("a healthy frame records contact with one clock read", () => {
    const now = vi.fn(() => Date.now());
    const { connection } = rig(now);
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    now.mockClear();
    connection.frameArrived();
    expect(now).toHaveBeenCalledTimes(1);
  });

  test("stalls after four seconds of silence on an answered socket and clears on the first frame", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS - 250);
    expect(connection.state.stalled).toBe(false);
    vi.advanceTimersByTime(250);
    expect(connection.state.stalled).toBe(true);
    expect(connection.state.waitMs).toBe(CONNECTION_STALLED_MS);
    connection.frameArrived();
    expect(connection.state.stalled).toBe(false);
  });

  test("frames flowing behind a late pong prevent a stall until four seconds after the last frame", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(2_000);
      connection.frameArrived();
      expect(connection.state.stalled).toBe(false);
    }
    vi.advanceTimersByTime(CONNECTION_STALLED_MS - 250);
    expect(connection.state.stalled).toBe(false);
    vi.advanceTimersByTime(250);
    expect(connection.state.stalled).toBe(true);
  });

  test("a socket that never answers a ping never stalls or starts a ticker", () => {
    const { connection } = rig();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS * 3);
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a wall-clock jump forgets the waiting ping instead of showing an hours-long stall", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.setSystemTime(3_600_000);
    vi.advanceTimersByTime(250);
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    connection.frameArrived();
    connection.pongArrived();
  });

  test("a later unanswered ping stalls after a forgotten wait", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.setSystemTime(3_600_000);
    vi.advanceTimersByTime(250);
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    expect(connection.state.waitMs).toBe(CONNECTION_STALLED_MS);
  });

  test("a ping waiting past the read deadline stops counting when the socket is not retiring", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS);
    expect(connection.state.stalled).toBe(true);
    vi.advanceTimersByTime(250);
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("opening another socket resets a stalled reading and requires its own pong", () => {
    const { connection } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    connection.opened();
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(false);
  });

  test("retire and dispose release pending probes and ticks and reset the reading", () => {
    const { connection, pings } = rig();
    connection.pingSent();
    connection.frameArrived();
    connection.pongArrived();
    connection.pingSent();
    vi.advanceTimersByTime(CONNECTION_STALLED_MS);
    expect(connection.state.stalled).toBe(true);
    connection.inputSent();
    expect(vi.getTimerCount()).toBe(2);
    connection.retired();
    expect(connection.state.stalled).toBe(false);
    expect(connection.state.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
    connection.opened();
    connection.inputSent();
    expect(vi.getTimerCount()).toBe(2);
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    connection.opened();
    connection.inputSent();
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
  });
});
