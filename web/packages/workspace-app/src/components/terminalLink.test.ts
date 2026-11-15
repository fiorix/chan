import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LINK_STALLED_MS } from "../api/linkProbe";
import { WS_READ_DEADLINE_MS } from "../api/transport";
import {
  createTerminalLink,
  TERMINAL_INPUT_NOTICE_MS,
  TERMINAL_INPUT_NOTICE_MIN_MS,
  TERMINAL_STALL_REDIAL_MS,
  TERMINAL_REDIAL_SPACING_MS,
  TERMINAL_LINK_TICK_MS,
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
  function answeredStall(link: ReturnType<typeof createTerminalLink>): void {
    link.pingSent();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    expect(link.state.stalled).toBe(true);
  }

  function redialRig(allowed = true) {
    let contactAt: number | null = null;
    const runs = vi.fn();
    const link = createTerminalLink(() => {}, () => Date.now(), {
      canRedial: () => allowed,
      lastContactAt: () => contactAt,
      run: runs,
    });
    link.opened();
    return { link, runs, contact: (at: number | null) => { contactAt = at; } };
  }

  test("waits for watcher contact newer than the terminal stall, then three seconds of ok", () => {
    expect(TERMINAL_STALL_REDIAL_MS).toBe(3_000);
    const { link, runs, contact } = redialRig();
    contact(0);
    link.windowChanged("ok", false);
    answeredStall(link);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TERMINAL_REDIAL_SPACING_MS + 1_000);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test.each(["slow", "unknown", "stalled", "down"] as const)("does not redial while the window is %s", (windowState) => {
    const { link, runs, contact } = redialRig();
    answeredStall(link);
    contact(Date.now());
    link.windowChanged(windowState, false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.dispose();
  });

  test("restarts the healthy-window wait if ok lapses", () => {
    const { link, runs, contact } = redialRig();
    link.windowChanged("ok", false);
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    link.windowChanged("slow", false);
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 100);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("leaves input in flight on its socket until a frame answers and a new stall qualifies", () => {
    const { link, runs, contact } = redialRig();
    link.windowChanged("ok", false);
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    link.inputSent();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.frameArrived();
    link.pongArrived();
    link.pingSent();
    vi.advanceTimersByTime(LINK_STALLED_MS);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("spaces terminal redials by thirty seconds across socket retirements", () => {
    const { link, runs, contact } = redialRig();
    link.windowChanged("ok", false);
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    const firstRedialAt = Date.now();
    link.retired();
    link.opened();
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(firstRedialAt + 30_000 - Date.now() - 1);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(2);
    link.dispose();
  });

  test("does not redial after retire or when the session owner refuses it", () => {
    const { link, runs, contact } = redialRig(false);
    link.windowChanged("ok", false);
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    link.retired();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    link.dispose();
  });

  test("warns after unanswered input retires and clears at next input or twelve visible seconds", () => {
    const { link } = rig();
    link.inputSent();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(11_999);
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(link.state.notice).toBe(false);
    link.inputSent();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(true);
    link.inputSent();
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MIN_MS);
    link.inputSent();
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("does not warn without input or after a frame answers it", () => {
    const { link } = rig();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(false);
    link.inputSent();
    link.frameArrived();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("mouse and wheel bytes hold a stalled socket without arming a probe or a lost-input warning", () => {
    const { link, runs, contact } = redialRig();
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    link.inputWritten();
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS + 1_000);
    expect(runs).not.toHaveBeenCalled();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("a pending redial survives a read deadline and can replace a retiring socket", () => {
    const { link, runs, contact } = redialRig();
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(2_000);
    link.retiring();
    expect(link.state.lost).toBe(true);
    vi.advanceTimersByTime(999);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("the read deadline starts a never-answered socket's three-second redial wait", () => {
    const { link, runs, contact } = redialRig();
    contact(0);
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS);
    link.retiring();
    expect(link.state.stalled).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).not.toHaveBeenCalled();
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 1);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("a retiring never-answered socket polls fresh watcher contact without a state change", () => {
    const { link, runs, contact } = redialRig();
    link.windowChanged("ok", false);
    link.retiring();
    contact(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS - 1);
    expect(runs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TERMINAL_LINK_TICK_MS + 1);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("a never-answered retiring socket keeps user input in flight and refuses unhealthy watcher state", () => {
    const { link, runs, contact } = redialRig();
    link.inputWritten();
    link.retiring();
    contact(Date.now());
    link.windowChanged("slow", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.dispose();
  });

  test("a never-answered retiring socket waits for ok watcher state", () => {
    const { link, runs, contact } = redialRig();
    link.retiring();
    contact(Date.now());
    link.windowChanged("slow", false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    link.dispose();
  });

  test("a never-answered retiring socket keeps thirty-second redial spacing", () => {
    const { link, runs, contact } = redialRig();
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS);
    expect(runs).toHaveBeenCalledTimes(1);
    const firstRedialAt = Date.now();
    link.retired();
    link.opened();
    link.retiring();
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(firstRedialAt + 30_000 - Date.now() - 1);
    expect(runs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveBeenCalledTimes(2);
    link.dispose();
  });

  test("a retiring socket keeps input in flight until its close callback", () => {
    const { link, runs, contact } = redialRig();
    answeredStall(link);
    link.inputWritten();
    link.retiring();
    contact(Date.now());
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_STALL_REDIAL_MS * 2);
    expect(runs).not.toHaveBeenCalled();
    link.dispose();
  });

  test("continued typing cannot dismiss the notice before four visible seconds", () => {
    const { link } = rig();
    link.inputRefused();
    link.retired();
    link.opened();
    vi.advanceTimersByTime(3_999);
    link.inputSent();
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(link.state.notice).toBe(true);
    link.inputSent();
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("refused input before any socket has opened cannot seed a notice", () => {
    const link = createTerminalLink(() => {});
    link.inputRefused();
    link.opened();
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("holds the input warning under a cover and shows it for twelve uncovered seconds", () => {
    const { link } = rig();
    link.inputSent();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(2_000);
    link.windowChanged("down", true);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(link.state.notice).toBe(true);
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS - 2_001);
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("a hidden tab pauses the warning until it is shown again", () => {
    const { link } = rig();
    link.inputRefused();
    link.retired();
    link.windowChanged("down", true);
    link.opened();
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(link.state.notice).toBe(true);
    link.windowChanged("ok", false);
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS);
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("a second retirement preserves a visible warning with a fresh lifetime", () => {
    const { link } = rig();
    link.inputRefused();
    link.retired();
    link.opened();
    vi.advanceTimersByTime(2_000);
    link.retired();
    link.opened();
    vi.advanceTimersByTime(TERMINAL_INPUT_NOTICE_MS - 1);
    expect(link.state.notice).toBe(true);
    vi.advanceTimersByTime(1);
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("refused input after a prior opening warns on the next opening", () => {
    const { link } = rig();
    link.retired();
    link.inputRefused();
    link.opened();
    expect(link.state.notice).toBe(true);
    link.dispose();
  });

  test("retiring keeps the stalled reading past the deadline and clears it on close", () => {
    const { link } = rig();
    answeredStall(link);
    link.retiring();
    expect(link.state.retiring).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(WS_READ_DEADLINE_MS + 250);
    link.pingSent();
    expect(link.state.stalled).toBe(true);
    link.retired();
    expect(link.state.retiring).toBe(false);
    expect(link.state.stalled).toBe(false);
    link.dispose();
  });

  test("retire clears a pending redial timer", () => {
    const { link, contact } = redialRig();
    link.windowChanged("ok", false);
    answeredStall(link);
    contact(Date.now());
    link.windowChanged("ok", false);
    expect(vi.getTimerCount()).toBe(2);
    link.retired();
    expect(vi.getTimerCount()).toBe(0);
    link.dispose();
  });

  test("retire clears a pending notice timer", () => {
    const { link } = rig();
    link.inputRefused();
    link.retired();
    link.opened();
    expect(vi.getTimerCount()).toBe(1);
    link.retired();
    expect(vi.getTimerCount()).toBe(0);
    link.dispose();
  });

  test("a stall on the next socket replaces the input warning", () => {
    const { link } = rig();
    link.inputSent();
    link.retired();
    link.opened();
    expect(link.state.notice).toBe(true);
    answeredStall(link);
    expect(link.state.notice).toBe(false);
    link.dispose();
  });

  test("runs the ticker only while an answered socket waits for a pong", () => {
    const { link, pings } = rig();
    expect(vi.getTimerCount()).toBe(0);
    link.pingSent();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(40);
    link.frameArrived();
    link.pongArrived();
    expect(link.state.stalled).toBe(false);
    link.pingSent();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(link.state.waitMs).toBe(250);
    link.frameArrived();
    link.pongArrived();
    expect(vi.getTimerCount()).toBe(0);
    expect(link.state.waitMs).toBe(0);
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

  test("a ping waiting past the read deadline stops counting when the socket is not retiring", () => {
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
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
    link.opened();
    link.inputSent();
    expect(vi.getTimerCount()).toBe(2);
    link.dispose();
    expect(vi.getTimerCount()).toBe(0);
    link.opened();
    link.inputSent();
    vi.advanceTimersByTime(5_000);
    expect(pings).toHaveLength(0);
  });
});
