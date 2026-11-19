// @vitest-environment jsdom

// The watcher times every ping against its pong and takes its cadence from
// the result: it pings once as its socket opens, and a page in front of the
// user after its first pong pings every 3 s. Remote pages use a 15 s read
// deadline there; local pages keep 45 s.
// A wake probe's deadline follows the latest round-trip time. Driven with
// fake timers, an injected socket and a page whose focus and visibility the
// test sets.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConnectionProbe, CONNECTION_MAX_RTT_MS, type ConnectionProbe } from "./connectionProbe";
import {
  openWatch,
  setSocketFactory,
  WS_FAST_PING_MS,
  WS_FAST_READ_DEADLINE_MS,
  WS_PROBE_DEADLINE_MAX_MS,
  WS_PROBE_DEADLINE_MS,
  WS_PROBE_DEADLINE_RTT_FACTOR,
  WS_READ_DEADLINE_MS,
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

/// Open a watcher and its first socket, which pings as it opens.
function watch(remote: boolean, connection?: ConnectionProbe): { s: FakeSocket; handle: WatchSocket } {
  const handle = openWatch(() => {}, undefined, undefined, undefined, undefined, connection, { remote });
  handles.push(handle);
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  s.open();
  return { s, handle };
}

/// Answer the ping a socket sent as it opened, `rttMs` after the open, which
/// is what makes it a socket that has answered a ping.
function answerOpenPing(s: FakeSocket, rttMs = 40): void {
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

  test("a socket pings as it opens, and so does its redial", () => {
    const { s } = watch(true);
    expect(pingCount(s)).toBe(1);
    s.close();
    vi.advanceTimersByTime(500);
    const s1 = FakeSocket.instances[1];
    expect(pingCount(s1)).toBe(0);
    s1.open();
    expect(pingCount(s1)).toBe(1);
  });

  test("the open's ping leaves ahead of the frames the owner sends as the socket opens", () => {
    const handle: WatchSocket = openWatch(
      () => {},
      undefined,
      () => handle.send({ type: "sub", dir: "" }),
    );
    handles.push(handle);
    const s = FakeSocket.instances[0];
    s.open();
    expect(s.sent).toEqual([PING, '{"type":"sub","dir":""}']);
  });

  test("a socket that has not answered keeps 20 s and 45 s in front of the user", () => {
    page({ focused: true });
    const { s } = watch(true);
    vi.advanceTimersByTime(19_999);
    expect(pingCount(s)).toBe(1); // only the open's
    vi.advanceTimersByTime(1);
    expect(pingCount(s)).toBe(2);
    vi.advanceTimersByTime(20_000);
    expect(pingCount(s)).toBe(3);
    vi.advanceTimersByTime(4_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("gaining focus does not move a socket that has not answered off them", () => {
    const { s } = watch(true);
    vi.advanceTimersByTime(5_000);
    page({ focused: true });
    // The pings sent for the open and for the focus are not the heartbeat's.
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
    const { s } = watch(true);
    const base = pingCount(s);
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    expect(pingCount(s) - base).toBe(1);
    // A focus event on a page already in front, as when focus comes back
    // from a frame inside it, sends none.
    window.dispatchEvent(new Event("focus"));
    expect(pingCount(s) - base).toBe(1);
    page({ focused: false });
    expect(pingCount(s) - base).toBe(1);
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    expect(pingCount(s) - base).toBe(2);
  });

  test("a focused page that becomes visible again sends one too", () => {
    page({ focused: true, visible: false });
    const { s } = watch(true);
    const base = pingCount(s);
    vi.advanceTimersByTime(1_000);
    page({ visible: true });
    expect(pingCount(s) - base).toBe(1);
    page({ visible: false });
    expect(pingCount(s) - base).toBe(1);
  });

  test("an answered socket in front of the user is pinged every 3 s", () => {
    const { s } = watch(true);
    answerOpenPing(s);
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

  test("the open's pong in front of the user starts the fast cadence", () => {
    page({ focused: true });
    const { s } = watch(true);
    answerOpenPing(s);
    const base = pingCount(s);
    vi.advanceTimersByTime(2_999);
    expect(pingCount(s) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s) - base).toBe(1);
  });

  test("a local focused page pings every 3 s but keeps the 45 s read deadline", () => {
    page({ focused: true });
    const connection = createConnectionProbe();
    const { s } = watch(false, connection);
    answerOpenPing(s);
    expect(connection.rttMs).toBe(40);
    vi.advanceTimersByTime(2_999);
    expect(pingCount(s)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pingCount(s)).toBe(2);
    vi.advanceTimersByTime(41_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("focus shortens a remote pending ping's deadline when 15 s beats its old due time", () => {
    const { s } = watch(true);
    answerOpenPing(s);
    vi.advanceTimersByTime(20_000); // heartbeat ping waits
    vi.advanceTimersByTime(5_000);
    page({ focused: true }); // the new 15 s deadline is earlier than the old 45 s due time
    expect(pingCount(s)).toBe(3);
    vi.advanceTimersByTime(14_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a first pong shortens the remote deadline with a focus ping still waiting", () => {
    const { s } = watch(true);
    vi.advanceTimersByTime(5_000);
    page({ focused: true }); // the focus ping waits behind the open ping
    expect(pingCount(s)).toBe(2);
    s.pong();
    vi.advanceTimersByTime(3_000);
    expect(pingCount(s)).toBe(3);
    vi.advanceTimersByTime(11_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a pending ping keeps its read deadline through repeated blur and focus changes", () => {
    page({ focused: true });
    const { s } = watch(true);
    answerOpenPing(s);
    vi.advanceTimersByTime(3_000);
    expect(pingCount(s)).toBe(2);
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(2_000);
      page({ focused: false });
      page({ focused: true });
    }
    vi.advanceTimersByTime(1_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a counted ping also keeps its deadline through a cadence change", () => {
    page({ focused: true });
    const connection = createConnectionProbe();
    const { s } = watch(true, connection);
    answerOpenPing(s);
    vi.advanceTimersByTime(3_000);
    connection.forgetTimings();
    expect(connection.hasPendingPing).toBe(true);
    page({ focused: false });
    page({ focused: true });
    vi.advanceTimersByTime(11_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a frame after a pending-ping cadence change refreshes the deadline", () => {
    page({ focused: true });
    const { s } = watch(true);
    answerOpenPing(s);
    vi.advanceTimersByTime(3_000);
    page({ focused: false });
    vi.advanceTimersByTime(1_000);
    s.message(EVENT);
    vi.advanceTimersByTime(44_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a focus ping sent with no earlier wait may start the fast deadline", () => {
    const { s } = watch(true);
    answerOpenPing(s);
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    expect(pingCount(s)).toBe(2);
    vi.advanceTimersByTime(14_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("on the fast cadence a silent socket is retired 15 s after its last frame", () => {
    const { s } = watch(true);
    answerOpenPing(s);
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
    const { s } = watch(true);
    answerOpenPing(s); // the pong lands 40 ms after the open
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
    const { s } = watch(true);
    answerOpenPing(s);
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

  test("a redialed socket starts on the fast pair before it answers", () => {
    page({ focused: true });
    const { s } = watch(true);
    answerOpenPing(s);
    s.close();
    vi.advanceTimersByTime(500);
    const s1 = FakeSocket.instances[1];
    s1.open();
    // This socket has answered nothing yet, but the page has had a pong.
    const base = pingCount(s1);
    vi.advanceTimersByTime(2_999);
    expect(pingCount(s1) - base).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pingCount(s1) - base).toBe(1);
    vi.advanceTimersByTime(11_999);
    expect(s1.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s1.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a page's first pong keeps later sockets on the fast pair from open", () => {
    page({ focused: true });
    const { s } = watch(true);
    answerOpenPing(s);
    s.close();
    vi.advanceTimersByTime(500);
    const redial = FakeSocket.instances[1];
    redial.open();
    expect(pingCount(redial)).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(pingCount(redial)).toBe(2);
    vi.advanceTimersByTime(12_000);
    expect(redial.readyState).toBe(FakeSocket.CLOSED);
  });

  test("a local redial pings fast from open but retains the 45 s deadline", () => {
    page({ focused: true });
    const { s } = watch(false);
    answerOpenPing(s);
    s.close();
    vi.advanceTimersByTime(500);
    const redial = FakeSocket.instances[1];
    redial.open();
    expect(pingCount(redial)).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(pingCount(redial)).toBe(2);
    vi.advanceTimersByTime(41_999);
    expect(redial.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(redial.readyState).toBe(FakeSocket.CLOSED);
  });

  test("reports deadline and close losses with the last inbound frame", () => {
    const drops: Array<{ reason: string; lastFrameAt: number | null } | undefined> = [];
    const handle = openWatch(() => {}, (status, _attempt, drop) => {
      if (status === "reconnecting") drops.push(drop);
    });
    handles.push(handle);
    const first = FakeSocket.instances[0];
    first.open();
    first.pong();
    const contact = Date.now();
    vi.advanceTimersByTime(45_000);
    expect(drops).toEqual([{ reason: "deadline", lastFrameAt: contact }]);
    vi.advanceTimersByTime(500);
    const redial = FakeSocket.instances[1];
    redial.open();
    redial.message(EVENT);
    const nextContact = Date.now();
    redial.close();
    expect(drops.at(-1)).toEqual({ reason: "closed", lastFrameAt: nextContact });
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

  test("a wake probe expiry reports deadline loss and the last frame time", () => {
    const drops: Array<{ reason: string; lastFrameAt: number | null } | undefined> = [];
    const handle = openWatch(() => {}, (status, _attempt, drop) => {
      if (status === "reconnecting") drops.push(drop);
    });
    handles.push(handle);
    const socket = FakeSocket.instances[0];
    socket.open();
    answerOpenPing(socket);
    const contact = Date.now();
    handle.probe();
    vi.advanceTimersByTime(WS_PROBE_DEADLINE_MS);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(drops).toEqual([{ reason: "deadline", lastFrameAt: contact }]);
  });

  test.each<[string, number, number]>([
    ["the floor", 100, 3_000],
    ["four round trips", 1_500, 6_000],
    ["the cap", 5_000, 10_000],
  ])("is %s after a %i ms round trip: %i ms", (_what, rttMs, deadlineMs) => {
    const { s, handle } = watch(true);
    answerOpenPing(s, rttMs);
    handle.probe();
    vi.advanceTimersByTime(deadlineMs - 1);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });

  test("follows the latest round trip, not an earlier one", () => {
    const { s, handle } = watch(true);
    answerOpenPing(s, 5_000);
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
    const { s, handle } = watch(true);
    answerOpenPing(s);
    handle.probe();
    vi.advanceTimersByTime(1_000);
    page({ focused: true });
    vi.advanceTimersByTime(1_999);
    expect(s.readyState).toBe(FakeSocket.OPEN);
    vi.advanceTimersByTime(1);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
  });
});

describe("watcher connection probe", () => {
  test("times open, heartbeat, focus and probe pings alike", () => {
    const connection = createConnectionProbe();
    const { s, handle } = watch(true, connection);
    vi.advanceTimersByTime(40); // the open's ping
    s.pong();
    expect(connection.answered).toBe(true);
    expect(connection.rttMs).toBe(40);
    vi.advanceTimersByTime(19_960); // the heartbeat's ping
    vi.advanceTimersByTime(55);
    s.pong();
    expect(connection.rttMs).toBe(55);
    page({ focused: true }); // the focus ping
    vi.advanceTimersByTime(70);
    s.pong();
    expect(connection.rttMs).toBe(70);
    handle.probe(); // the probe's ping
    vi.advanceTimersByTime(25);
    s.pong();
    expect(connection.rttMs).toBe(25);
  });

  test("reports every inbound frame as contact", () => {
    const connection = createConnectionProbe();
    const { s } = watch(true, connection);
    const t0 = Date.now();
    expect(connection.lastFrameAt).toBeNull();
    vi.advanceTimersByTime(5_000);
    s.message(EVENT);
    expect(connection.lastFrameAt).toBe(t0 + 5_000);
    vi.advanceTimersByTime(250);
    s.message("not json");
    expect(connection.lastFrameAt).toBe(t0 + 5_250);
  });

  test("a retired socket's waiting pings leave with it", () => {
    const connection = createConnectionProbe();
    const { s } = watch(true, connection);
    answerOpenPing(s);
    // Silent from here: the heartbeat pings twice before the deadline.
    vi.advanceTimersByTime(45_000);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
    expect(connection.answered).toBe(false);
    expect(connection.hasPendingPing).toBe(false);
    expect(connection.rttMs).toBeNull();
  });

  test("a pong delivered inside the send still finds its ping", () => {
    const connection = createConnectionProbe();
    handles.push(openWatch(() => {}, undefined, undefined, undefined, undefined, connection));
    const s = FakeSocket.instances[0];
    s.answersInPlace = true;
    s.open();
    expect(connection.rttMs).toBe(0);
    expect(connection.answered).toBe(true);
    expect(connection.hasPendingPing).toBe(false);
  });

  test("a ping in flight across a sleep is not timed", () => {
    // Capture the onWake the transport hands the detector, then fire it to
    // model a wake without fighting the fake-timer/Date coupling.
    let onWake: () => void = () => {};
    vi.spyOn(wakeGap, "installWakeGapDetector").mockImplementation((cb: () => void) => {
      onWake = cb;
      return () => {};
    });
    const connection = createConnectionProbe();
    const { s } = watch(true, connection);
    answerOpenPing(s);
    vi.advanceTimersByTime(19_960); // the heartbeat's ping leaves
    vi.advanceTimersByTime(2_000); // and is still unanswered at the wake
    onWake();
    vi.advanceTimersByTime(30);
    s.pong(); // the sleeping ping's pong
    expect(connection.rttMs).toBe(40);
    s.pong(); // the wake probe's
    expect(connection.rttMs).toBe(30);
  });

  test("the longest round trip the probe times is the ordinary read deadline", () => {
    expect(CONNECTION_MAX_RTT_MS).toBe(WS_READ_DEADLINE_MS);
  });

  test("a pong that lands after a clock jump the wake detector has not seen yet is not timed", () => {
    const connection = createConnectionProbe();
    const { s, handle } = watch(true, connection);
    const t0 = Date.now();
    answerOpenPing(s);
    vi.advanceTimersByTime(19_960); // the heartbeat's ping leaves
    // The machine sleeps an hour: the clock moves and no timer runs, the wake
    // detector's included.
    vi.setSystemTime(t0 + 20_000 + 3_600_000);
    s.pong();
    expect(connection.rttMs).toBe(40);
    expect(connection.answered).toBe(true);
    expect(connection.hasPendingPing).toBe(false);

    // The pairing held: the next pong is the next ping's own.
    handle.probe();
    vi.advanceTimersByTime(25);
    s.pong();
    expect(connection.rttMs).toBe(25);
  });
});
