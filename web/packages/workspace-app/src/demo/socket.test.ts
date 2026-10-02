// @vitest-environment jsdom

// The demo's sockets have no server behind them, so the socket itself answers
// the transport's heartbeat: a ping gets a pong, and a watch over the demo
// stays open however long a test runs.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openWatch, setSocketFactory, WS_READ_DEADLINE_MS } from "../api/transport";
import { demoSocketFactory } from "./socket";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setSocketFactory(null);
  vi.useRealTimers();
});

describe("the demo socket's heartbeat", () => {
  test("a ping is answered with a pong", () => {
    const socket = demoSocketFactory("ws://demo.local/ws");
    const frames: unknown[] = [];
    socket.onmessage = (ev) => frames.push(JSON.parse(ev.data as string));
    vi.advanceTimersByTime(0);
    expect(socket.readyState).toBe(1);

    socket.send(JSON.stringify({ type: "ping" }));

    expect(frames).toEqual([{ type: "pong" }]);
  });

  test("a watch over it is not redialled past the read deadline", () => {
    let dials = 0;
    setSocketFactory((url) => {
      dials += 1;
      return demoSocketFactory(url);
    });
    const statuses: string[] = [];
    const watch = openWatch(
      () => {},
      (status) => statuses.push(status),
    );

    for (let elapsed = 0; elapsed < WS_READ_DEADLINE_MS * 3; elapsed += 1000) {
      vi.advanceTimersByTime(1000);
    }

    expect(dials).toBe(1);
    expect(statuses).not.toContain("reconnecting");
    watch.close();
  });
});
