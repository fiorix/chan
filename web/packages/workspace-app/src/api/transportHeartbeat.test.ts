// @vitest-environment jsdom

// The watcher transport keeps a live-but-quiet /ws from going unnoticed: it
// pings on a cadence, treats any inbound frame (event OR the heartbeat pong) as
// liveness against a read-deadline, and force-closes -> reconnects a socket that
// has gone silent (a half-open zombie the browser never reports closed) or that
// a machine sleep froze. Driven with fake timers + an injected socket.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openWatch, setSocketFactory } from "./transport";
import * as wakeGap from "../wakeGap";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  message(data: string): void {
    this.onmessage?.({ data });
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const pingCount = (s: FakeSocket) => s.sent.filter((x) => x === '{"type":"ping"}').length;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket); // provides WebSocket.OPEN to the transport
  setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
});

afterEach(() => {
  setSocketFactory(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("watcher heartbeat + read-deadline", () => {
  test("sends a ping on the heartbeat cadence while open", () => {
    const handle = openWatch(() => {});
    const s = FakeSocket.instances[0];
    s.open();
    expect(pingCount(s)).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(pingCount(s)).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(pingCount(s)).toBe(2);
    handle.close();
  });

  test("a pong refreshes the deadline and is not forwarded as an event", () => {
    const events: unknown[] = [];
    const handle = openWatch((e) => events.push(e));
    const s = FakeSocket.instances[0];
    s.open();
    vi.advanceTimersByTime(44_000);
    s.message('{"type":"pong"}');
    expect(events).toEqual([]); // pong is liveness-only, not an app event
    // 44s since the pong (< the 45s deadline): the socket stays live, no reconnect.
    vi.advanceTimersByTime(44_000);
    expect(FakeSocket.instances.length).toBe(1);
    handle.close();
  });

  test("an event frame refreshes the deadline and IS forwarded", () => {
    const events: unknown[] = [];
    const handle = openWatch((e) => events.push(e));
    const s = FakeSocket.instances[0];
    s.open();
    vi.advanceTimersByTime(44_000);
    s.message('{"type":"windowset","windows":[]}');
    expect(events).toEqual([{ type: "windowset", windows: [] }]);
    vi.advanceTimersByTime(44_000);
    expect(FakeSocket.instances.length).toBe(1); // frame kept it alive
    handle.close();
  });

  test("force-closes and reconnects after the read-deadline with no inbound frame", () => {
    const statuses: string[] = [];
    const handle = openWatch(
      () => {},
      (s) => statuses.push(s),
    );
    const s0 = FakeSocket.instances[0];
    s0.open();
    expect(statuses).toContain("open");
    // No inbound frame for the whole deadline -> the zombie is force-closed.
    vi.advanceTimersByTime(45_000);
    expect(s0.readyState).toBe(FakeSocket.CLOSED);
    expect(statuses).toContain("reconnecting");
    // The backoff reconnect opens a fresh socket.
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances.length).toBe(2);
    handle.close();
  });

  test("a dial stuck in CONNECTING trips the connect-deadline and redials", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    // Never opened: the read-deadline only arms on open, so the dial's own
    // 10s deadline is what force-closes the hung attempt into the backoff.
    vi.advanceTimersByTime(10_000);
    expect(s0.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances.length).toBe(2);
    handle.close();
  });

  test("stops the heartbeat + deadline once the socket closes", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    vi.advanceTimersByTime(20_000);
    expect(pingCount(s0)).toBe(1);
    // Dispose: no more pings on the (now closed) socket, and no reconnect churn.
    handle.close();
    const before = FakeSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(pingCount(s0)).toBe(1);
    expect(FakeSocket.instances.length).toBe(before);
  });
});

describe("wake-gap probe", () => {
  test("a healthy wake keeps one socket and delivers each command once", () => {
    // Capture the onWake the transport hands the detector, then fire it to model
    // a wake without fighting the fake-timer/Date coupling. Starts as a noop, so
    // the socket only closes if the transport actually installed a detector.
    let onWake: () => void = () => {};
    vi.spyOn(wakeGap, "installWakeGapDetector").mockImplementation((cb: () => void) => {
      onWake = cb;
      return () => {};
    });
    const events: unknown[] = [];
    const ready = vi.fn();
    const handle = openWatch((event) => events.push(event), undefined, ready);
    const s0 = FakeSocket.instances[0];
    s0.open();
    expect(ready).toHaveBeenCalledTimes(1);
    onWake();
    // App's debounced resume can nudge in the same turn as the transport
    // detector. One pending probe sends one ping and keeps its first deadline.
    handle.probe();
    expect(pingCount(s0)).toBe(1);
    s0.message('{"type":"pong"}');
    expect(FakeSocket.instances).toHaveLength(1);
    expect(s0.readyState).toBe(FakeSocket.OPEN);
    expect(ready).toHaveBeenCalledTimes(1);

    const survey = '{"type":"window_command","command":"open_survey","survey":{"surveyId":"survey-1"}}';
    s0.message(survey);
    expect(events).toEqual([JSON.parse(survey)]);
    const command = '{"type":"window_command","command":"open_term_new"}';
    s0.message(command);
    expect(events).toEqual([JSON.parse(survey), JSON.parse(command)]);
    s0.message(command);
    expect(events).toEqual([JSON.parse(survey), JSON.parse(command), JSON.parse(command)]);
    handle.close();
  });

  test("a silent wake probe closes and redials through backoff", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    handle.probe();
    expect(pingCount(s0)).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(s0.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    handle.close();
  });

  test("a queued event does not answer the post-wake ping", () => {
    const events: unknown[] = [];
    const handle = openWatch((event) => events.push(event));
    const s0 = FakeSocket.instances[0];
    s0.open();
    handle.probe();
    s0.message('{"type":"window_command","command":"open_term_new"}');
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(s0.readyState).toBe(FakeSocket.CLOSED);
    handle.close();
  });

  test("repeated probes do not extend the first response deadline", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    handle.probe();
    vi.advanceTimersByTime(2_500);
    handle.probe();
    vi.advanceTimersByTime(500);
    expect(s0.readyState).toBe(FakeSocket.CLOSED);
    handle.close();
  });

  test("a nudge during reconnect backoff dials immediately", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    s0.close();
    expect(FakeSocket.instances).toHaveLength(1);
    handle.probe();
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    handle.close();
  });

  test("a nudge during a connecting attempt keeps that one dial", () => {
    const handle = openWatch(() => {});
    handle.probe();
    expect(FakeSocket.instances).toHaveLength(1);
    const s0 = FakeSocket.instances[0];
    s0.open();
    expect(s0.readyState).toBe(FakeSocket.OPEN);
    handle.close();
  });

  test("disposal cancels a pending probe", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    handle.probe();
    handle.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("disposal cancels reconnect backoff", () => {
    const handle = openWatch(() => {});
    const s0 = FakeSocket.instances[0];
    s0.open();
    s0.close();
    handle.close();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
