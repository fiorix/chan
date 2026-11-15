// @vitest-environment jsdom

// The window's connection state. `down` follows the watcher's status once the
// watcher has been open; every other state follows the watcher's probe; and
// while a ping waits a ticker moves the state with no socket event to report
// it. Driven with fake timers, reporting to the probe what the watcher would.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openWatch, setSocketFactory } from "../api/transport";
import {
  CONNECTION_SAMPLE_CAP,
  formatConnectionMs,
  isLoopbackHost,
  connectionHealth,
  connectionIsRemote,
  connectionLabel,
  resetConnectionHealthForTests,
  setConnectionWatchStatus,
  watchConnectionProbe,
} from "./connectionHealth.svelte";

function ping(): void {
  watchConnectionProbe.pingSent();
}

function pong(): void {
  watchConnectionProbe.frameReceived();
  watchConnectionProbe.pongReceived();
}

/// A whole round trip that takes `rttMs`.
function roundTrip(rttMs: number): void {
  ping();
  vi.advanceTimersByTime(rttMs);
  pong();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
});

afterEach(() => {
  resetConnectionHealthForTests();
  vi.useRealTimers();
});

describe("the window's connection state", () => {
  test("is unknown until the first pong, then ok", () => {
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    expect(connectionHealth.state).toBe("unknown");
    expect(connectionHealth.rttMs).toBeNull();
    expect(connectionHealth.lastContactAt).toBeNull();

    vi.advanceTimersByTime(20_000);
    roundTrip(30);

    expect(connectionHealth.state).toBe("ok");
    expect(connectionHealth.since).toBe(Date.now());
    expect(connectionHealth.rttMs).toBe(30);
    expect(connectionHealth.lastContactAt).toBe(Date.now());
    expect(connectionHealth.samples).toEqual([{ at: Date.now() - 30, rttMs: 30 }]);
  });

  test("is down only once the watcher has been open", () => {
    // A page whose first dial fails has lost nothing yet.
    setConnectionWatchStatus("connecting");
    expect(connectionHealth.state).toBe("unknown");
    setConnectionWatchStatus("reconnecting");
    expect(connectionHealth.state).toBe("unknown");
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    expect(connectionHealth.state).toBe("unknown");

    vi.advanceTimersByTime(1_000);
    setConnectionWatchStatus("reconnecting");
    expect(connectionHealth.state).toBe("down");
    const wentDown = Date.now();
    expect(connectionHealth.since).toBe(wentDown);

    vi.advanceTimersByTime(700);
    setConnectionWatchStatus("connecting");
    expect(connectionHealth.state).toBe("down");
    expect(connectionHealth.since).toBe(wentDown);

    // The redialed socket has answered nothing yet.
    setConnectionWatchStatus("open");
    expect(connectionHealth.state).toBe("down");
    expect(connectionHealth.since).toBe(wentDown);
    ping();
    pong();
    expect(connectionHealth.state).toBe("ok");
    expect(connectionHealth.since).toBe(Date.now());
  });

  test("keeps the last round trip, contact and samples while down", () => {
    setConnectionWatchStatus("open");
    roundTrip(30);
    const contact = Date.now();
    vi.advanceTimersByTime(5_000);

    // What the watcher does when it retires its socket.
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting");

    expect(connectionHealth.state).toBe("down");
    expect(connectionHealth.rttMs).toBe(30);
    expect(connectionHealth.lastContactAt).toBe(contact);
    expect(connectionHealth.samples).toHaveLength(1);
  });

  test("keeps the first cover deadline through failed redials", () => {
    setConnectionWatchStatus("open");
    roundTrip(20);
    const contact = Date.now();
    vi.advanceTimersByTime(15_000);
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting", { reason: "deadline", lastFrameAt: contact });
    const outage = connectionHealth.outage;
    expect(outage).toEqual({ startedAt: Date.now(), coverAt: contact + 45_000 });
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    expect(connectionHealth.state).toBe("down");
    expect(connectionHealth.outage).toBe(outage);
    watchConnectionProbe.pingSent();
    vi.advanceTimersByTime(1_000);
    expect(watchConnectionProbe.classify()).toBe("slow");
    expect(connectionHealth.state).toBe("down");
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting", { reason: "closed", lastFrameAt: null });
    expect(connectionHealth.outage).toBe(outage);
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    ping();
    pong();
    expect(connectionHealth.outage).toBeNull();
    expect(connectionHealth.state).toBe("ok");
    expect(connectionHealth.samples).toEqual([{ at: contact - 20, rttMs: 20 }, { at: Date.now() - 1_000, rttMs: null }, { at: Date.now(), rttMs: 0 }]);
  });

  test("a clock jump forgets a pending timing before the ticker paints a huge stall", () => {
    setConnectionWatchStatus("open");
    roundTrip(20);
    ping();
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(250);
    expect(connectionHealth.state).toBe("ok");
    expect(connectionHealth.waitMs).toBe(0);
    expect(watchConnectionProbe.oldestPingAt).toBeNull();
  });

  test("a round trip longer than the read deadline leaves the last reading in place", () => {
    setConnectionWatchStatus("open");
    roundTrip(30);
    ping();
    vi.advanceTimersByTime(45_001);
    expect(connectionHealth.state).toBe("stalled");
    pong();
    expect(connectionHealth.rttMs).toBe(30);
    expect(connectionHealth.samples).toHaveLength(1);
    expect(connectionHealth.waitMs).toBe(0);
    // This was ordinary elapsed time, so the late pong leaves slow recovery.
    expect(connectionHealth.state).toBe("slow");
    roundTrip(30);
    roundTrip(30);
    expect(connectionHealth.state).toBe("ok");
  });

  test("time alone moves it to slow and to stalled while a ping waits", () => {
    setConnectionWatchStatus("open");
    roundTrip(30);
    expect(connectionHealth.state).toBe("ok");

    ping();
    vi.advanceTimersByTime(999);
    expect(connectionHealth.state).toBe("ok");
    vi.advanceTimersByTime(1);
    expect(connectionHealth.state).toBe("slow");
    expect(connectionHealth.since).toBe(Date.now());
    expect(connectionHealth.waitMs).toBe(1_000);

    vi.advanceTimersByTime(2_999);
    expect(connectionHealth.state).toBe("slow");
    vi.advanceTimersByTime(1);
    expect(connectionHealth.state).toBe("stalled");
    expect(connectionHealth.since).toBe(Date.now());
    expect(connectionHealth.waitMs).toBe(4_000);

    // The wait keeps counting.
    vi.advanceTimersByTime(4_250);
    expect(connectionHealth.waitMs).toBe(8_250);

    // A frame that is not the pong proves the connection carries data again.
    watchConnectionProbe.frameReceived();
    expect(connectionHealth.state).toBe("slow");
    pong();
    expect(connectionHealth.state).toBe("slow");
    expect(connectionHealth.rttMs).toBe(8_250);
    expect(connectionHealth.waitMs).toBe(0);
    roundTrip(30);
    roundTrip(30);
    expect(connectionHealth.state).toBe("ok");
  });

  test("the ticker starts with a waiting ping", () => {
    setConnectionWatchStatus("open");
    roundTrip(30);
    expect(vi.getTimerCount()).toBe(0);
    ping();
    expect(vi.getTimerCount()).toBe(1);
    // A second waiting ping does not start a second one.
    vi.advanceTimersByTime(3_000);
    ping();
    expect(vi.getTimerCount()).toBe(1);
  });

  test("the ticker stops once no ping waits", () => {
    setConnectionWatchStatus("open");
    roundTrip(30);
    ping();
    vi.advanceTimersByTime(600);
    pong();
    expect(vi.getTimerCount()).toBe(0);

    // A retired socket's pings no longer wait either.
    ping();
    vi.advanceTimersByTime(600);
    watchConnectionProbe.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(connectionHealth.waitMs).toBe(0);
  });

  test("a socket that has never answered runs no ticker and counts no wait", () => {
    setConnectionWatchStatus("open");
    ping();
    vi.advanceTimersByTime(30_000);
    expect(connectionHealth.state).toBe("unknown");
    expect(connectionHealth.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the last 60 samples, a miss among them", () => {
    expect(CONNECTION_SAMPLE_CAP).toBe(60);
    setConnectionWatchStatus("open");
    const t0 = Date.now();
    for (let i = 0; i < 70; i += 1) {
      roundTrip(30);
      vi.advanceTimersByTime(2_970);
    }
    expect(connectionHealth.samples).toHaveLength(60);
    expect(connectionHealth.samples[0]).toEqual({ at: t0 + 10 * 3_000, rttMs: 30 });
    expect(connectionHealth.samples[59]).toEqual({ at: t0 + 69 * 3_000, rttMs: 30 });

    // A ping the socket never answers takes a place as a miss at the retire.
    ping();
    vi.advanceTimersByTime(15_000);
    watchConnectionProbe.reset();
    expect(connectionHealth.samples).toHaveLength(60);
    expect(connectionHealth.samples[59]).toEqual({ at: t0 + 70 * 3_000, rttMs: null });
    expect(connectionHealth.samples[0]).toEqual({ at: t0 + 11 * 3_000, rttMs: 30 });
  });
});

describe("through the watcher", () => {
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: FakeSocket[] = [];

    readyState = 0; // CONNECTING
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
    pong(): void {
      this.onmessage?.({ data: '{"type":"pong"}' });
    }
    send(): void {}
    close(): void {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.();
    }
  }

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket); // provides WebSocket.OPEN to the transport
    setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
  });

  afterEach(() => {
    setSocketFactory(null);
    vi.unstubAllGlobals();
  });

  test("a connection that goes quiet reads ok, slow, stalled, then down with its misses", () => {
    // The store's wiring: the window's probe, and each status reported.
    const handle = openWatch(
      () => {},
      (status) => setConnectionWatchStatus(status),
      undefined,
      undefined,
      undefined,
      watchConnectionProbe,
    );
    try {
      const t0 = Date.now();
      const s0 = FakeSocket.instances[0];
      s0.open();
      expect(connectionHealth.state).toBe("unknown");

      vi.advanceTimersByTime(40); // the ping the socket sent as it opened, 40 ms out
      s0.pong();
      expect(connectionHealth.state).toBe("ok");
      expect(connectionHealth.rttMs).toBe(40);

      vi.advanceTimersByTime(19_960); // the first heartbeat's ping, never answered
      vi.advanceTimersByTime(999);
      expect(connectionHealth.state).toBe("ok");
      vi.advanceTimersByTime(1);
      expect(connectionHealth.state).toBe("slow");
      vi.advanceTimersByTime(3_000);
      expect(connectionHealth.state).toBe("stalled");
      expect(connectionLabel(connectionHealth.state, connectionHealth.rttMs, connectionHealth.waitMs)).toBe("stalled 4 s");

      // The read deadline retires the socket 45 s after its last frame.
      vi.advanceTimersByTime(21_040);
      expect(s0.readyState).toBe(FakeSocket.CLOSED);
      expect(connectionHealth.state).toBe("down");
      expect(connectionHealth.samples).toEqual([
        { at: t0, rttMs: 40 },
        { at: t0 + 20_000, rttMs: null },
        { at: t0 + 40_000, rttMs: null },
      ]);
      expect(connectionHealth.rttMs).toBe(40);

      vi.advanceTimersByTime(500);
      FakeSocket.instances[1].open();
      expect(connectionHealth.state).toBe("down");
    } finally {
      handle.close();
    }
  });

  test("a slow connection reads slow a round trip after it connects", () => {
    const handle = openWatch(
      () => {},
      (status) => setConnectionWatchStatus(status),
      undefined,
      undefined,
      undefined,
      watchConnectionProbe,
    );
    try {
      const s0 = FakeSocket.instances[0];
      s0.open();
      // The open's ping waits in `unknown`: nothing counts it as overdue.
      vi.advanceTimersByTime(1_200);
      expect(connectionHealth.state).toBe("unknown");
      expect(connectionHealth.waitMs).toBe(0);
      s0.pong();
      expect(connectionHealth.state).toBe("slow");
      expect(connectionHealth.since).toBe(Date.now());
      expect(connectionLabel(connectionHealth.state, connectionHealth.rttMs, connectionHealth.waitMs)).toBe("1.2 s");
    } finally {
      handle.close();
    }
  });
});

describe("connectionLabel", () => {
  test.each<[string, Parameters<typeof connectionLabel>, string]>([
    ["ok shows nothing", ["ok", 30, 0], ""],
    ["unknown shows nothing", ["unknown", null, 0], ""],
    ["down says it is reconnecting", ["down", 30, 0], "reconnecting"],
    ["stalled counts the wait in whole seconds", ["stalled", 30, 8_250], "stalled 8 s"],
    ["slow names the round-trip time", ["slow", 850, 0], "850 ms"],
    ["recovering slow hides a healthy round-trip time", ["slow", 26, 0], ""],
    ["recovering slow hides a healthy pending wait", ["slow", 26, 299], ""],
    ["slow shows a wait at the recovery threshold", ["slow", 26, 300], "300 ms"],
    ["slow names the wait once it is the longer", ["slow", 50, 2_400], "2.4 s"],
    ["slow with no round trip yet names the wait", ["slow", null, 1_000], "1.0 s"],
  ])("%s", (_what, args, label) => {
    expect(connectionLabel(...args)).toBe(label);
  });

  test("a duration is in milliseconds under a second and in seconds from there", () => {
    expect(formatConnectionMs(0)).toBe("0 ms");
    expect(formatConnectionMs(999)).toBe("999 ms");
    expect(formatConnectionMs(1_000)).toBe("1.0 s");
    expect(formatConnectionMs(12_340)).toBe("12.3 s");
  });
});

describe("connectionIsRemote", () => {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };

  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
    window.history.replaceState(null, "", "/");
  });

  test("a browser page on a loopback host is local, whatever its library", () => {
    expect(isLoopbackHost(window.location.hostname)).toBe(true);
    expect(connectionIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=lib-abc123");
    expect(connectionIsRemote()).toBe(false);
  });

  test("a desktop window is remote when its library is not the local one", () => {
    tauri.__TAURI_INTERNALS__ = {};
    expect(connectionIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=local");
    expect(connectionIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=lib-abc123");
    expect(connectionIsRemote()).toBe(true);
  });

  test.each<[string, boolean]>([
    ["localhost", true],
    ["LOCALHOST", true],
    ["app.localhost", true],
    ["127.0.0.1", true],
    ["127.4.5.6", true],
    ["[::1]", true],
    ["example.com", false],
    ["geekom.lan", false],
    ["192.168.1.20", false],
    ["10.0.0.1", false],
    ["127.0.0.1.example.com", false],
    ["notlocalhost", false],
    ["", false],
  ])("the host %j is loopback: %j", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});
