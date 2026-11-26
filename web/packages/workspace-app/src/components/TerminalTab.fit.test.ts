// @vitest-environment jsdom
//
// A mounted widget measures its host before dialing and on frame/trailing
// fits. The socket records the grid the real fitter publishes to the PTY.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  resizeObservers,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { runTerminalFit } from "../terminal/resize";

vi.mock("../terminal/resize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/resize")>();
  return { ...actual, runTerminalFit: vi.fn(actual.runTerminalFit) };
});

installTerminalDom();

let hostSize: { cols: number; rows: number } | null = null;
// The software canvas measures 8 by 19 CSS pixels before the 1.2 line height.
beforeEach(() => {
  vi.useFakeTimers();
  for (const [property, axis, cell] of [["clientWidth", "cols", 8], ["clientHeight", "rows", 19 * 1.2]] as const) {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, property)!.get!;
    vi.spyOn(Element.prototype, property, "get").mockImplementation(function (this: Element) {
      return this.classList.contains("terminal-host") ? (hostSize?.[axis] ?? 0) * cell : original.call(this);
    });
  }
  vi.mocked(runTerminalFit).mockClear();
});
const fits = () => vi.mocked(runTerminalFit).mock.calls.length;

/// Past the trailing fit's 120ms settle.
const SETTLED = 170;

const ownCancelFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  resetTerminals();
  globalThis.cancelAnimationFrame = ownCancelFrame;
  hostSize = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/// Hold the page's animation frames until the test runs them, as a hidden
/// page holds them until its window comes back. `resetTerminals` puts the
/// harness's task-based frame back.
function holdFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1_000_000;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const handle = next++;
    queue.set(handle, callback);
    return handle;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    queue.delete(handle);
  }) as typeof cancelAnimationFrame;
  return {
    pending: () => queue.size,
    run() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

async function mounted(props: { active?: boolean } = {}) {
  const [tab] = seatTerminals([terminalTab()]);
  const result = await mountGhosttyTerminal(TerminalTab, tab!, props);
  return { ...result, socket: TerminalSocket.all.at(-1)! };
}

function resizeFrames(socket: TerminalSocket): unknown[] {
  return sentFrames(socket).filter((f) => f.type === "resize");
}

describe("the fit", () => {
  test("runs once, measured, before the terminal dials", async () => {
    hostSize = { cols: 132, rows: 41 };
    const { socket } = await mounted();
    expect(fits()).toBe(1);
    const query = new URL(socket.url, "http://chan.test").searchParams;
    expect([query.get("cols"), query.get("rows")]).toEqual(["132", "41"]);
  });

  test("watches the terminal's host for size changes", async () => {
    const { target } = await mounted();
    const observer = resizeObservers.at(-1)!;
    expect(observer.targets).toHaveLength(1);
    expect(target.contains(observer.targets[0]!)).toBe(true);
  });

  test("a resize fits at once, then once more after the resizing settles", async () => {
    hostSize = { cols: 80, rows: 24 };
    const { term } = await mounted();
    const before = fits();
    const observer = resizeObservers.at(-1)!;
    for (let resize = 0; resize < 3; resize++) {
      hostSize = { cols: 81 + resize, rows: 25 + resize };
      observer.callback();
      await vi.advanceTimersByTimeAsync(16);
      expect({ cols: term.cols, rows: term.rows }).toEqual(hostSize);
    }
    expect(fits() - before, "one leading fit per observed resize").toBe(3);

    hostSize = { cols: 120, rows: 40 };
    await vi.advanceTimersByTimeAsync(SETTLED);
    expect(fits() - before, "one trailing fit after the last").toBe(4);
    expect({ cols: term.cols, rows: term.rows }, "the trailing fit reads the settled host").toEqual(hostSize);
  });
});

// A window off-screen gets no animation frame, so the fits its resizes ask
// for wait for the frame in which it comes back.
describe("the fit while frames are held", () => {
  test("many resizes wait as one fit, which reads the host's size when it runs", async () => {
    const { socket } = await mounted();
    await attach(socket);
    await vi.advanceTimersByTimeAsync(400);
    const frames = holdFrames();
    const before = fits();
    const observer = resizeObservers.at(-1)!;
    for (let resized = 0; resized < 500; resized++) observer.callback();
    expect(frames.pending(), "one frame however many resizes").toBe(1);

    hostSize = { cols: 120, rows: 40 };
    frames.run();
    expect(fits() - before, "one fit in the frame back").toBe(1);
    expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 120, rows: 40 });

    const afterPaint = frames.pending();
    observer.callback();
    expect(frames.pending(), "another fit beside the widget's resize paint").toBe(afterPaint + 1);
    frames.run();
    expect(fits() - before, "the next frame fits again").toBe(2);
  });

  test("a fit still waiting for its frame is cancelled at teardown", async () => {
    await mounted();
    await vi.advanceTimersByTimeAsync(400);
    const frames = holdFrames();
    resizeObservers.at(-1)!.callback();
    expect(frames.pending()).toBe(1);

    resetTerminals();
    expect(frames.pending(), "nothing waits for a frame after teardown").toBe(0);
  });
});

describe("the PTY's size", () => {
  test("is sent when the socket opens and whenever the widget resizes", async () => {
    hostSize = { cols: 80, rows: 24 };
    const { term, socket } = await mounted();
    await attach(socket);
    expect(resizeFrames(socket)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    term.resize(100, 30);
    expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  // The renderer's grid before a fit measured it is the widget's default, which
  // would size a live PTY that another client sized.
  test("is not sent when the socket opens before a fit measured the grid", async () => {
    const { socket } = await mounted();
    await attach(socket);
    expect(resizeFrames(socket)).toEqual([]);
  });

  test("is sent once the first fit measures it, even when it is the renderer's own", async () => {
    const { socket } = await mounted();
    await attach(socket);
    const before = resizeFrames(socket).length;
    const observer = resizeObservers.at(-1)!;

    hostSize = { cols: 80, rows: 24 };
    observer.callback();
    observer.callback();

    await vi.advanceTimersByTimeAsync(16);
    expect(resizeFrames(socket).slice(before)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  test("a size another view set is adopted by a hidden terminal only", async () => {
    const hidden = await mounted({ active: false });
    await attach(hidden.socket);
    await receive(hidden.socket, { type: "resize_other", cols: 120, rows: 40 });
    await tick();
    expect([hidden.term.cols, hidden.term.rows]).toEqual([120, 40]);

    resetTerminals();
    const shown = await mounted({ active: true });
    await attach(shown.socket);
    await receive(shown.socket, { type: "resize_other", cols: 120, rows: 40 });
    await tick();
    expect([shown.term.cols, shown.term.rows]).toEqual([80, 24]);
  });
});
