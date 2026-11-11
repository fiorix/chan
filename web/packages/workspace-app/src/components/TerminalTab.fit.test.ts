// @vitest-environment jsdom
//
// How a terminal's grid follows its pane: the mount fits before it dials, a
// resize fits at once and again once the resize settles, and every new size
// reaches the PTY. A TerminalTab is mounted over the stand-in xterm, whose
// fit addon counts its runs; the resize observer the component made is
// triggered by hand.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  resizeObservers,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

/// Past the trailing fit's 120ms settle.
const SETTLED = 170;

const ownCancelFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  resetTerminals();
  globalThis.cancelAnimationFrame = ownCancelFrame;
});

/// Hold the page's animation frames until the test runs them, as a hidden
/// page holds them until its window comes back. `resetTerminals` puts the
/// harness's synchronous frame back.
function holdFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
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
  const result = await mountTerminal(TerminalTab, tab!, props);
  return { ...result, socket: TerminalSocket.all.at(-1)! };
}

function resizeFrames(socket: TerminalSocket): unknown[] {
  return sentFrames(socket).filter((f) => f.type === "resize");
}

describe("the fit", () => {
  test("runs once, measured, before the terminal dials", async () => {
    xterm.fit.size = { cols: 132, rows: 41 };
    const { socket } = await mounted();
    expect(xterm.fit.calls).toBe(1);
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
    await mounted();
    const before = xterm.fit.calls;
    const observer = resizeObservers.at(-1)!;
    observer.callback();
    observer.callback();
    observer.callback();
    expect(xterm.fit.calls - before, "one leading fit per observed resize").toBe(3);

    await new Promise((r) => setTimeout(r, SETTLED));
    expect(xterm.fit.calls - before, "one trailing fit after the last").toBe(4);
  });
});

// A window off-screen gets no animation frame, so the fits its resizes ask
// for wait for the frame in which it comes back.
describe("the fit while frames are held", () => {
  test("many resizes wait as one fit, which reads the host's size when it runs", async () => {
    const { socket } = await mounted();
    await attach(socket);
    const frames = holdFrames();
    const before = xterm.fit.calls;
    const observer = resizeObservers.at(-1)!;
    for (let resized = 0; resized < 500; resized++) observer.callback();
    expect(frames.pending(), "one frame however many resizes").toBe(1);

    xterm.fit.size = { cols: 120, rows: 40 };
    frames.run();
    expect(xterm.fit.calls - before, "one fit in the frame back").toBe(1);
    expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 120, rows: 40 });

    observer.callback();
    expect(frames.pending(), "a resize after the frame ran asks for another").toBe(1);
  });

  test("a fit still waiting for its frame is cancelled at teardown", async () => {
    await mounted();
    const frames = holdFrames();
    resizeObservers.at(-1)!.callback();
    expect(frames.pending()).toBe(1);

    resetTerminals();
    expect(frames.pending(), "nothing waits for a frame after teardown").toBe(0);
  });
});

describe("the PTY's size", () => {
  test("is sent when the socket opens and whenever xterm resizes", async () => {
    xterm.fit.size = { cols: 80, rows: 24 };
    const { term, socket } = await mounted();
    await attach(socket);
    expect(resizeFrames(socket)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    for (const handler of term.resizeHandlers) handler({ cols: 100, rows: 30 });
    expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  // The renderer's grid before a fit measured it is xterm's default, which
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

    xterm.fit.size = { cols: 80, rows: 24 };
    observer.callback();
    observer.callback();

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
