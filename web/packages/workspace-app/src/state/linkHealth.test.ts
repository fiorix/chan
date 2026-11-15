// @vitest-environment jsdom

// The window's link state. `down` follows the watcher's status once the
// watcher has been open; every other state follows the watcher's probe; and
// while a ping waits a ticker moves the state with no socket event to report
// it. Driven with fake timers, reporting to the probe what the watcher would.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openWatch, setSocketFactory } from "../api/transport";
import {
  LINK_SAMPLE_CAP,
  formatLinkMs,
  isLoopbackHost,
  linkHealth,
  linkIsRemote,
  linkLabel,
  resetLinkHealthForTests,
  setLinkWatchStatus,
  watchLinkProbe,
} from "./linkHealth.svelte";

function ping(): void {
  watchLinkProbe.pingSent();
}

function pong(): void {
  watchLinkProbe.frameReceived();
  watchLinkProbe.pongReceived();
}

/// A whole round trip that takes `rttMs`.
function roundTrip(rttMs: number): void {
  ping();
  vi.advanceTimersByTime(rttMs);
  pong();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetLinkHealthForTests();
});

afterEach(() => {
  resetLinkHealthForTests();
  vi.useRealTimers();
});

describe("the window's link state", () => {
  test("is unknown until the first pong, then ok", () => {
    setLinkWatchStatus("connecting");
    setLinkWatchStatus("open");
    expect(linkHealth.state).toBe("unknown");
    expect(linkHealth.rttMs).toBeNull();
    expect(linkHealth.lastContactAt).toBeNull();

    vi.advanceTimersByTime(20_000);
    roundTrip(30);

    expect(linkHealth.state).toBe("ok");
    expect(linkHealth.since).toBe(Date.now());
    expect(linkHealth.rttMs).toBe(30);
    expect(linkHealth.lastContactAt).toBe(Date.now());
    expect(linkHealth.samples).toEqual([{ at: Date.now() - 30, rttMs: 30 }]);
  });

  test("is down only once the watcher has been open", () => {
    // A page whose first dial fails has lost nothing yet.
    setLinkWatchStatus("connecting");
    expect(linkHealth.state).toBe("unknown");
    setLinkWatchStatus("reconnecting");
    expect(linkHealth.state).toBe("unknown");
    setLinkWatchStatus("connecting");
    setLinkWatchStatus("open");
    expect(linkHealth.state).toBe("unknown");

    vi.advanceTimersByTime(1_000);
    setLinkWatchStatus("reconnecting");
    expect(linkHealth.state).toBe("down");
    const wentDown = Date.now();
    expect(linkHealth.since).toBe(wentDown);

    vi.advanceTimersByTime(700);
    setLinkWatchStatus("connecting");
    expect(linkHealth.state).toBe("down");
    expect(linkHealth.since).toBe(wentDown);

    // The redialed socket has answered nothing yet.
    setLinkWatchStatus("open");
    expect(linkHealth.state).toBe("down");
    expect(linkHealth.since).toBe(wentDown);
    ping();
    pong();
    expect(linkHealth.state).toBe("ok");
    expect(linkHealth.since).toBe(Date.now());
  });

  test("keeps the last round trip, contact and samples while down", () => {
    setLinkWatchStatus("open");
    roundTrip(30);
    const contact = Date.now();
    vi.advanceTimersByTime(5_000);

    // What the watcher does when it retires its socket.
    watchLinkProbe.reset();
    setLinkWatchStatus("reconnecting");

    expect(linkHealth.state).toBe("down");
    expect(linkHealth.rttMs).toBe(30);
    expect(linkHealth.lastContactAt).toBe(contact);
    expect(linkHealth.samples).toHaveLength(1);
  });

  test("keeps the first cover deadline through failed redials", () => {
    setLinkWatchStatus("open");
    roundTrip(20);
    const contact = Date.now();
    vi.advanceTimersByTime(15_000);
    watchLinkProbe.reset();
    setLinkWatchStatus("reconnecting", { reason: "deadline", lastFrameAt: contact });
    const outage = linkHealth.outage;
    expect(outage).toEqual({ startedAt: Date.now(), coverAt: contact + 45_000 });
    setLinkWatchStatus("connecting");
    setLinkWatchStatus("open");
    expect(linkHealth.state).toBe("down");
    expect(linkHealth.outage).toBe(outage);
    watchLinkProbe.pingSent();
    vi.advanceTimersByTime(1_000);
    expect(watchLinkProbe.classify()).toBe("slow");
    expect(linkHealth.state).toBe("down");
    watchLinkProbe.reset();
    setLinkWatchStatus("reconnecting", { reason: "closed", lastFrameAt: null });
    expect(linkHealth.outage).toBe(outage);
    setLinkWatchStatus("connecting");
    setLinkWatchStatus("open");
    ping();
    pong();
    expect(linkHealth.outage).toBeNull();
    expect(linkHealth.state).toBe("ok");
    expect(linkHealth.samples).toEqual([{ at: contact - 20, rttMs: 20 }, { at: Date.now() - 1_000, rttMs: null }, { at: Date.now(), rttMs: 0 }]);
  });

  test("a clock jump forgets a pending timing before the ticker paints a huge stall", () => {
    setLinkWatchStatus("open");
    roundTrip(20);
    ping();
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(250);
    expect(linkHealth.state).toBe("ok");
    expect(linkHealth.waitMs).toBe(0);
    expect(watchLinkProbe.oldestPingAt).toBeNull();
  });

  test("a round trip longer than the read deadline leaves the last reading in place", () => {
    setLinkWatchStatus("open");
    roundTrip(30);
    ping();
    vi.advanceTimersByTime(45_001);
    expect(linkHealth.state).toBe("stalled");
    pong();
    expect(linkHealth.rttMs).toBe(30);
    expect(linkHealth.samples).toHaveLength(1);
    expect(linkHealth.waitMs).toBe(0);
    // This was ordinary elapsed time, so the late pong leaves slow recovery.
    expect(linkHealth.state).toBe("slow");
    roundTrip(30);
    roundTrip(30);
    expect(linkHealth.state).toBe("ok");
  });

  test("time alone moves it to slow and to stalled while a ping waits", () => {
    setLinkWatchStatus("open");
    roundTrip(30);
    expect(linkHealth.state).toBe("ok");

    ping();
    vi.advanceTimersByTime(999);
    expect(linkHealth.state).toBe("ok");
    vi.advanceTimersByTime(1);
    expect(linkHealth.state).toBe("slow");
    expect(linkHealth.since).toBe(Date.now());
    expect(linkHealth.waitMs).toBe(1_000);

    vi.advanceTimersByTime(2_999);
    expect(linkHealth.state).toBe("slow");
    vi.advanceTimersByTime(1);
    expect(linkHealth.state).toBe("stalled");
    expect(linkHealth.since).toBe(Date.now());
    expect(linkHealth.waitMs).toBe(4_000);

    // The wait keeps counting.
    vi.advanceTimersByTime(4_250);
    expect(linkHealth.waitMs).toBe(8_250);

    // A frame that is not the pong proves the link carries data again.
    watchLinkProbe.frameReceived();
    expect(linkHealth.state).toBe("slow");
    pong();
    expect(linkHealth.state).toBe("slow");
    expect(linkHealth.rttMs).toBe(8_250);
    expect(linkHealth.waitMs).toBe(0);
    roundTrip(30);
    roundTrip(30);
    expect(linkHealth.state).toBe("ok");
  });

  test("the ticker starts with a waiting ping", () => {
    setLinkWatchStatus("open");
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
    setLinkWatchStatus("open");
    roundTrip(30);
    ping();
    vi.advanceTimersByTime(600);
    pong();
    expect(vi.getTimerCount()).toBe(0);

    // A retired socket's pings no longer wait either.
    ping();
    vi.advanceTimersByTime(600);
    watchLinkProbe.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(linkHealth.waitMs).toBe(0);
  });

  test("a socket that has never answered runs no ticker and counts no wait", () => {
    setLinkWatchStatus("open");
    ping();
    vi.advanceTimersByTime(30_000);
    expect(linkHealth.state).toBe("unknown");
    expect(linkHealth.waitMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the last 60 samples, a miss among them", () => {
    expect(LINK_SAMPLE_CAP).toBe(60);
    setLinkWatchStatus("open");
    const t0 = Date.now();
    for (let i = 0; i < 70; i += 1) {
      roundTrip(30);
      vi.advanceTimersByTime(2_970);
    }
    expect(linkHealth.samples).toHaveLength(60);
    expect(linkHealth.samples[0]).toEqual({ at: t0 + 10 * 3_000, rttMs: 30 });
    expect(linkHealth.samples[59]).toEqual({ at: t0 + 69 * 3_000, rttMs: 30 });

    // A ping the socket never answers takes a place as a miss at the retire.
    ping();
    vi.advanceTimersByTime(15_000);
    watchLinkProbe.reset();
    expect(linkHealth.samples).toHaveLength(60);
    expect(linkHealth.samples[59]).toEqual({ at: t0 + 70 * 3_000, rttMs: null });
    expect(linkHealth.samples[0]).toEqual({ at: t0 + 11 * 3_000, rttMs: 30 });
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

  test("a link that goes quiet reads ok, slow, stalled, then down with its misses", () => {
    // The store's wiring: the window's probe, and each status reported.
    const handle = openWatch(
      () => {},
      (status) => setLinkWatchStatus(status),
      undefined,
      undefined,
      undefined,
      watchLinkProbe,
    );
    try {
      const t0 = Date.now();
      const s0 = FakeSocket.instances[0];
      s0.open();
      expect(linkHealth.state).toBe("unknown");

      vi.advanceTimersByTime(40); // the ping the socket sent as it opened, 40 ms out
      s0.pong();
      expect(linkHealth.state).toBe("ok");
      expect(linkHealth.rttMs).toBe(40);

      vi.advanceTimersByTime(19_960); // the first heartbeat's ping, never answered
      vi.advanceTimersByTime(999);
      expect(linkHealth.state).toBe("ok");
      vi.advanceTimersByTime(1);
      expect(linkHealth.state).toBe("slow");
      vi.advanceTimersByTime(3_000);
      expect(linkHealth.state).toBe("stalled");
      expect(linkLabel(linkHealth.state, linkHealth.rttMs, linkHealth.waitMs)).toBe("stalled 4 s");

      // The read deadline retires the socket 45 s after its last frame.
      vi.advanceTimersByTime(21_040);
      expect(s0.readyState).toBe(FakeSocket.CLOSED);
      expect(linkHealth.state).toBe("down");
      expect(linkHealth.samples).toEqual([
        { at: t0, rttMs: 40 },
        { at: t0 + 20_000, rttMs: null },
        { at: t0 + 40_000, rttMs: null },
      ]);
      expect(linkHealth.rttMs).toBe(40);

      vi.advanceTimersByTime(500);
      FakeSocket.instances[1].open();
      expect(linkHealth.state).toBe("down");
    } finally {
      handle.close();
    }
  });

  test("a slow link reads slow a round trip after it connects", () => {
    const handle = openWatch(
      () => {},
      (status) => setLinkWatchStatus(status),
      undefined,
      undefined,
      undefined,
      watchLinkProbe,
    );
    try {
      const s0 = FakeSocket.instances[0];
      s0.open();
      // The open's ping waits in `unknown`: nothing counts it as overdue.
      vi.advanceTimersByTime(1_200);
      expect(linkHealth.state).toBe("unknown");
      expect(linkHealth.waitMs).toBe(0);
      s0.pong();
      expect(linkHealth.state).toBe("slow");
      expect(linkHealth.since).toBe(Date.now());
      expect(linkLabel(linkHealth.state, linkHealth.rttMs, linkHealth.waitMs)).toBe("1.2 s");
    } finally {
      handle.close();
    }
  });
});

describe("linkLabel", () => {
  test.each<[string, Parameters<typeof linkLabel>, string]>([
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
    expect(linkLabel(...args)).toBe(label);
  });

  test("a duration is in milliseconds under a second and in seconds from there", () => {
    expect(formatLinkMs(0)).toBe("0 ms");
    expect(formatLinkMs(999)).toBe("999 ms");
    expect(formatLinkMs(1_000)).toBe("1.0 s");
    expect(formatLinkMs(12_340)).toBe("12.3 s");
  });
});

describe("linkIsRemote", () => {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };

  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
    window.history.replaceState(null, "", "/");
  });

  test("a browser page on a loopback host is local, whatever its library", () => {
    expect(isLoopbackHost(window.location.hostname)).toBe(true);
    expect(linkIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=lib-abc123");
    expect(linkIsRemote()).toBe(false);
  });

  test("a desktop window is remote when its library is not the local one", () => {
    tauri.__TAURI_INTERNALS__ = {};
    expect(linkIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=local");
    expect(linkIsRemote()).toBe(false);
    window.history.replaceState(null, "", "/?lib=lib-abc123");
    expect(linkIsRemote()).toBe(true);
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
