// @vitest-environment jsdom

// The watcher times every ping against its pong and takes its cadence from
// the result: a socket that has answered a ping, on a page in front of the
// user, is pinged every 3 s and retired after 15 s of silence, and every other
// socket keeps 20 s and 45 s. A wake probe's deadline follows the latest
// round-trip time. Driven with fake timers, an injected socket and a page
// whose focus and visibility the test sets.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLinkProbe, type LinkProbe, type LinkSample } from "./linkProbe";
import {
  openWatch,
  setSocketFactory,
  WS_FAST_PING_MS,
  WS_FAST_READ_DEADLINE_MS,
  WS_PROBE_DEADLINE_MAX_MS,
  WS_PROBE_DEADLINE_MS,
  WS_PROBE_DEADLINE_RTT_FACTOR,
  type WatchSocket,
} from "./transport";
import * as wakeGap from "../wakeGap";

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';
const EVENT = '{"type":"windowset","windows":[]}';

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  /// Answer a ping inside `send`, as the demo's socket does.
  answersInPlace = false;
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
  pong(): void {
    this.message(PONG);
  }
  send(d: string): void {
    this.sent.push(d);
    if (this.answersInPlace && d === PING) this.pong();
  }
  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const pingCount = (s: FakeSocket) => s.sent.filter((x) => x === PING).length;

let focused = false;
let visible = true;

/// Set the page's focus and visibility, firing the events a browser fires.
function page(next: { focused?: boolean; visible?: boolean }): void {
  const before = { focused, visible };
  focused = next.focused ?? focused;
  visible = next.visible ?? visible;
  if (visible !== before.visible) document.dispatchEvent(new Event("visibilitychange"));
  if (focused !== before.focused) window.dispatchEvent(new Event(focused ? "focus" : "blur"));
}

const handles: WatchSocket[] = [];

/// Open a watcher and its first socket.
function watch(link?: LinkProbe): { s: FakeSocket; handle: WatchSocket } {
  const handle = openWatch(() => {}, undefined, undefined, undefined, undefined, link);
  handles.push(handle);
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  s.open();
  return { s, handle };
}

/// Run a freshly opened socket to its first heartbeat and answer it `rttMs`
/// later, which is what makes the socket one that has answered a ping.
function answerFirstHeartbeat(s: FakeSocket, rttMs = 40): void {
  vi.advanceTimersByTime(20_000);
  vi.advanceTimersByTime(rttMs);
  s.pong();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  focused = false;
  visible = true;
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  vi.stubGlobal("WebSocket", FakeSocket); // provides WebSocket.OPEN to the transport
  setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  setSocketFactory(null);
  // The own properties shadow jsdom's; removing them puts jsdom's back.
  delete (document as unknown as Record<string, unknown>).hasFocus;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("watcher cadence", () => {
  test("the cadence constants are the contract's", () => {
    expect([WS_FAST_PING_MS, WS_FAST_READ_DEADLINE_MS]).toEqual([3_000, 15_000]);
  });

  test("a socket that has not answered keeps 20 s and 45 s in front of the user", () => {
    page({ focused: true });
    const { s } = watch();
    vi.advanceTimersByTime(19_999);
    expect(pingCount(s)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s)).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(pingCount(s)).toBe(2);
    vi.advanceTimersByTime(4_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("gaining focus does not move a socket that has not answered off them", () => {
    const { s } = watch();
    vi.advanceTimersByTime(5_000);
    page({ focused: true });
    // The ping sent for the focus is not the heartbeat's.
    const base = pingCount(s);
    vi.advanceTimersByTime(14_999);
    expect(pingCount(s) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s) - base).toBe(1);
    vi.advanceTimersByTime(24_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("gaining focus sends a ping at once", () => {
    const { s } = watch();
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    expect(pingCount(s)).toBe(1);
    // A focus event on a page already in front, as when focus comes back
    // from a frame inside it, sends none.
    window.dispatchEvent(new Event("focus"));
    expect(pingCount(s)).toBe(1);
    page({ focused: false });
    expect(pingCount(s)).toBe(1);
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    expect(pingCount(s)).toBe(2);
  });

  test("a focused page that becomes visible again sends one too", () => {
    page({ focused: true, visible: false });
    const { s } = watch();
    vi.advanceTimersByTime(1_000);
    page({ visible: true });
    expect(pingCount(s)).toBe(1);
    page({ visible: false });
    expect(pingCount(s)).toBe(1);
  });

  test("an answered socket in front of the user is pinged every 3 s", () => {
    const { s } = watch();
    answerFirstHeartbeat(s);
    page({ focused: true });
    s.pong();
    const base = pingCount(s);
    for (let i = 1; i <= 4; i += 1) {
      vi.advanceTimersByTime(2_999);
      expect(pingCount(s) - base).toBe(i - 1);
      vi.advanceTimersByTime(1);
      expect(pingCount(s) - base).toBe(i);
      s.pong();
    }
  });

  test("the first pong in front of the user starts the fast cadence", () => {
    page({ focused: true });
    const { s } = watch();
    answerFirstHeartbeat(s);
    const base = pingCount(s);
    vi.advanceTimersByTime(2_999);
    expect(pingCount(s) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s) - base).toBe(1);
  });

  test("on the fast cadence a silent socket is retired 15 s after its last frame", () => {
    const { s } = watch();
    answerFirstHeartbeat(s);
    page({ focused: true });
    vi.advanceTimersByTime(10_000);
    s.message(EVENT);
    vi.advanceTimersByTime(14_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test.each<[string, { focused: boolean; visible: boolean }]>([
    ["an unfocused", { focused: false, visible: true }],
    ["a hidden", { focused: true, visible: false }],
  ])("%s page keeps 20 s and 45 s on an answered socket", (_what, state) => {
    page(state);
    const { s } = watch();
    answerFirstHeartbeat(s); // the pong lands 20 040 ms after the open
    vi.advanceTimersByTime(19_959);
    expect(pingCount(s)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pingCount(s)).toBe(2);
    vi.advanceTimersByTime(25_039);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("losing focus returns an answered socket to 20 s and 45 s", () => {
    const { s } = watch();
    answerFirstHeartbeat(s);
    page({ focused: true });
    s.pong();
    vi.advanceTimersByTime(3_000);
    s.pong();
    page({ focused: false });
    const base = pingCount(s);
    vi.advanceTimersByTime(19_999);
    expect(pingCount(s) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s) - base).toBe(1);
    vi.advanceTimersByTime(24_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a redialed socket starts over on 20 s until it answers", () => {
    const { s } = watch();
    answerFirstHeartbeat(s);
    s.close();
    vi.advanceTimersByTime(500);
    const s1 = FakeSocket.instances[1];
    s1.open();
    // In front of the user, but this socket has answered nothing yet.
    page({ focused: true });
    const base = pingCount(s1);
    vi.advanceTimersByTime(19_999);
    expect(pingCount(s1) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s1) - base).toBe(1);
  });
});

describe("wake probe deadline", () => {
  test("the probe constants are the contract's", () => {
    expect([
      WS_PROBE_DEADLINE_MS,
      WS_PROBE_DEADLINE_RTT_FACTOR,
      WS_PROBE_DEADLINE_MAX_MS,
    ]).toEqual([3_000, 4, 10_000]);
  });

  test.each<[string, number, number]>([
    ["the floor", 100, 3_000],
    ["four round trips", 1_500, 6_000],
    ["the cap", 5_000, 10_000],
  ])("is %s after a %i ms round trip: %i ms", (_what, rttMs, deadlineMs) => {
    const { s, handle } = watch();
    answerFirstHeartbeat(s, rttMs);
    handle.probe();
    vi.advanceTimersByTime(deadlineMs - 1);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("follows the latest round trip, not an earlier one", () => {
    const { s, handle } = watch();
    answerFirstHeartbeat(s, 5_000);
    handle.probe();
    vi.advanceTimersByTime(100);
    s.pong(); // settles that probe with a 100 ms round trip
    vi.advanceTimersByTime(1_000);
    handle.probe();
    vi.advanceTimersByTime(2_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("keeps its own deadline through a cadence change", () => {
    const { s, handle } = watch();
    answerFirstHeartbeat(s);
    handle.probe();
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    vi.advanceTimersByTime(1_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });
});

describe("watcher link probe", () => {
  function sampled(): { link: LinkProbe; samples: LinkSample[] } {
    const samples: LinkSample[] = [];
    return { link: createLinkProbe({ onSample: (x) => samples.push(x) }), samples };
  }

  test("times heartbeat, focus and probe pings alike", () => {
    const { link, samples } = sampled();
    const { s, handle } = watch(link);
    const t0 = Date.now();
    vi.advanceTimersByTime(20_000); // the heartbeat's ping
    vi.advanceTimersByTime(40);
    s.pong();
    expect(link.answered).toBe(true);
    expect(link.rttMs).toBe(40);
    page({ focused: true }); // the focus ping
    vi.advanceTimersByTime(70);
    s.pong();
    handle.probe(); // the probe's ping
    vi.advanceTimersByTime(25);
    s.pong();
    expect(samples).toEqual([
      { at: t0 + 20_000, rttMs: 40 },
      { at: t0 + 20_040, rttMs: 70 },
      { at: t0 + 20_110, rttMs: 25 },
    ]);
  });

  test("reports every inbound frame as contact", () => {
    const { link } = sampled();
    const { s } = watch(link);
    const t0 = Date.now();
    expect(link.lastFrameAt).toBeNull();
    vi.advanceTimersByTime(5_000);
    s.message(EVENT);
    expect(link.lastFrameAt).toBe(t0 + 5_000);
    vi.advanceTimersByTime(250);
    s.message("not json");
    expect(link.lastFrameAt).toBe(t0 + 5_250);
  });

  test("a retired socket's waiting pings are misses", () => {
    const { link, samples } = sampled();
    const { s } = watch(link);
    const t0 = Date.now();
    answerFirstHeartbeat(s);
    // Silent from here: the heartbeat pings twice more before the deadline.
    vi.advanceTimersByTime(45_000);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
    expect(samples).toEqual([
      { at: t0 + 20_000, rttMs: 40 },
      { at: t0 + 40_000, rttMs: null },
      { at: t0 + 60_000, rttMs: null },
    ]);
    expect(link.answered).toBe(false);
  });

  test("a pong delivered inside the send still finds its ping", () => {
    const { link, samples } = sampled();
    const { s } = watch(link);
    const t0 = Date.now();
    s.answersInPlace = true;
    vi.advanceTimersByTime(20_000);
    expect(samples).toEqual([{ at: t0 + 20_000, rttMs: 0 }]);
    expect(link.answered).toBe(true);
    expect(link.oldestPingAt).toBeNull();
  });

  test("a ping in flight across a sleep is not timed", () => {
    // Capture the onWake the transport hands the detector, then fire it to
    // model a wake without fighting the fake-timer/Date coupling.
    let onWake: () => void = () => {};
    vi.spyOn(wakeGap, "installWakeGapDetector").mockImplementation((cb: () => void) => {
      onWake = cb;
      return () => {};
    });
    const { link, samples } = sampled();
    const { s } = watch(link);
    const t0 = Date.now();
    answerFirstHeartbeat(s);
    vi.advanceTimersByTime(19_960); // the next heartbeat's ping leaves
    vi.advanceTimersByTime(2_000); // and is still unanswered at the wake
    onWake();
    vi.advanceTimersByTime(30);
    s.pong(); // the sleeping ping's pong
    s.pong(); // the wake probe's
    expect(samples).toEqual([
      { at: t0 + 20_000, rttMs: 40 },
      { at: t0 + 42_000, rttMs: 30 },
    ]);
    expect(link.rttMs).toBe(30);
  });
});
