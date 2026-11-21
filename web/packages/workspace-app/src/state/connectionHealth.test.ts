// @vitest-environment jsdom

// The window's connection: an outage from the loss of an open watcher until
// a later socket answers a ping, which the cover and the close prompt read.
// Driven with fake timers, reporting to the probe what the watcher would.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openWatch, setSocketFactory } from "../api/transport";
import {
  isLoopbackHost,
  connectionHealth,
  connectionIsRemote,
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

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
});

afterEach(() => {
  resetConnectionHealthForTests();
  vi.useRealTimers();
});

describe("the window's connection outage", () => {
  test("starts only once the watcher has been open and ends at a later socket's first pong", () => {
    // A page whose first dial fails has lost nothing yet.
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("reconnecting");
    expect(connectionHealth.outage).toBeNull();
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    expect(connectionHealth.watcherOpen).toBe(true);
    expect(connectionHealth.outage).toBeNull();

    vi.advanceTimersByTime(1_000);
    setConnectionWatchStatus("reconnecting");
    const wentDown = Date.now();
    expect(connectionHealth.watcherOpen).toBe(false);
    expect(connectionHealth.outage).toEqual({ startedAt: wentDown, coverAt: wentDown });
    expect(connectionHealth.outageEpoch).toBe(1);

    vi.advanceTimersByTime(700);
    setConnectionWatchStatus("connecting");
    // The redialed socket has answered nothing yet.
    setConnectionWatchStatus("open");
    expect(connectionHealth.watcherOpen).toBe(true);
    expect(connectionHealth.outage?.startedAt).toBe(wentDown);
    expect(connectionHealth.outageEpoch).toBe(1);
    ping();
    pong();
    expect(connectionHealth.outage).toBeNull();
    expect(connectionHealth.outageEpoch).toBe(2);
  });

  test("keeps the first cover deadline through failed redials", () => {
    setConnectionWatchStatus("open");
    ping();
    pong();
    const contact = Date.now();
    vi.advanceTimersByTime(15_000);
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting", { reason: "deadline", lastFrameAt: contact });
    const outage = connectionHealth.outage;
    expect(outage).toEqual({ startedAt: Date.now(), coverAt: contact + 45_000 });
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    ping();
    vi.advanceTimersByTime(1_000);
    expect(connectionHealth.outage).toBe(outage);
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting", { reason: "closed", lastFrameAt: null });
    expect(connectionHealth.outage).toBe(outage);
    expect(connectionHealth.outageEpoch).toBe(1);
    setConnectionWatchStatus("connecting");
    setConnectionWatchStatus("open");
    ping();
    pong();
    expect(connectionHealth.outage).toBeNull();
    expect(connectionHealth.outageEpoch).toBe(2);
  });

  test("a frame that is not a pong does not end it", () => {
    setConnectionWatchStatus("open");
    ping();
    pong();
    watchConnectionProbe.reset();
    setConnectionWatchStatus("reconnecting");
    setConnectionWatchStatus("open");
    watchConnectionProbe.frameReceived();
    expect(connectionHealth.outage).not.toBeNull();
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

  test("a socket gone quiet opens an outage due 45 s after its last frame, which a later pong ends", () => {
    // The store's wiring: the window's probe, and each status reported.
    const handle = openWatch(
      () => {},
      (status, _attempt, drop) => setConnectionWatchStatus(status, drop),
      undefined,
      undefined,
      undefined,
      watchConnectionProbe,
    );
    try {
      const s0 = FakeSocket.instances[0];
      s0.open();
      vi.advanceTimersByTime(40); // the ping the socket sent as it opened, 40 ms out
      s0.pong();
      const contact = Date.now();
      expect(connectionHealth.outage).toBeNull();

      // The read deadline retires the socket 45 s after its last frame.
      vi.advanceTimersByTime(45_000);
      expect(s0.readyState).toBe(FakeSocket.CLOSED);
      expect(connectionHealth.outage).toEqual({ startedAt: Date.now(), coverAt: contact + 45_000 });

      vi.advanceTimersByTime(500);
      const s1 = FakeSocket.instances[1];
      s1.open();
      expect(connectionHealth.outage).not.toBeNull();
      s1.pong();
      expect(connectionHealth.outage).toBeNull();
    } finally {
      handle.close();
    }
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
