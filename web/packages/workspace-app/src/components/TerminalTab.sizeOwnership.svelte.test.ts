// @vitest-environment jsdom
//
// A hidden parser follows the PTY without publishing a grid. A reveal
// measures its own host and publishes once, independently of keyboard focus.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const measurement = vi.hoisted(() => ({
  grid: { cols: 132, rows: 41 } as { cols: number; rows: number } | null,
  fits: 0,
  wake: null as (() => void) | null,
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const { FakeTerminal } = await import("../__tests__/terminalTab");
  // The inherited resize calls every onResize handler synchronously, as
  // both renderers do. Each case also proves a shown fit reaches the socket.
  class GhosttyTerminal extends FakeTerminal {
    renderer = { getMetrics: () => ({ width: 8, height: 16 }) };
    buffer = { active: {}, alternate: {} };
    hasMouseTracking() { return false; }
    hasFocusEvents() { return false; }
  }
  return {
    ...(await importOriginal<typeof import("../terminal/backend")>()),
    loadGhosttyKit: async () => ({ ghostty: {}, Terminal: GhosttyTerminal }),
  };
});
vi.mock("../terminal/ghosttyCompat", () => ({
  clearGhosttyRecycledGrid() {},
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));
vi.mock("../terminal/ghosttyViewport", () => ({
  GhosttyViewportController: class {
    write() {}
    dispose() {}
  },
}));
vi.mock("../terminal/resize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/resize")>();
  return {
    ...actual,
    proposeGhosttyDimensions: () => measurement.grid,
    runTerminalFit: (...args: Parameters<typeof actual.runTerminalFit>) => {
      measurement.fits += 1;
      return actual.runTerminalFit(...args);
    },
  };
});
vi.mock("../wakeGap", () => ({
  installWakeGapDetector: (callback: () => void) => {
    measurement.wake = callback;
    return () => { measurement.wake = null; };
  },
}));

import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { dockTerminal, terminalLayer, terminalPlacements } from "../state/terminalDock.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";
import {
  attach, installTerminalDom, receive, resetTerminals, resizeObservers,
  seatTerminals, sentFrames, terminalTab, TERMINAL_PANE, TerminalSocket, xterm,
} from "../__tests__/terminalTab";

installTerminalDom();
const disposals: Array<() => void> = [];
const frames = (socket: TerminalSocket) => sentFrames(socket).filter((f) => f.type === "resize");
const gridFrame = (cols: number, rows: number) => ({ type: "resize", cols, rows });

function hostGrid(cols: number, rows: number) {
  measurement.grid = { cols, rows };
  xterm.fit.size = { cols, rows };
}

async function settled() {
  await vi.advanceTimersByTimeAsync(400);
  await tick();
}

async function mounted(active = true, sessionId?: string) {
  const [tab] = seatTerminals([terminalTab({ terminalSessionId: sessionId })]);
  const props = $state({ tab: tab!, paneId: TERMINAL_PANE, side: "a" as "a" | "b", active, focused: false });
  const layer = document.createElement("div");
  const target = document.createElement("div");
  document.body.append(layer);
  disposals.push(terminalLayer(TERMINAL_PANE)(layer)!);
  disposals.push($effect.root(() => dockTerminal(tab!.id, () => props.paneId)(target)));
  const component = mount(TerminalTab, { target, props });
  disposals.push(() => { void unmount(component); });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  await tick();
  return { props, target, tab: tab!, term: xterm.terminals.at(-1)!, socket: TerminalSocket.all[0]! };
}

async function shown() {
  const result = await mounted();
  await attach(result.socket);
  await receive(result.socket, { type: "ready", cols: 132, rows: 41 });
  await settled();
  result.socket.sent.splice(0);
  return result;
}

async function visibility(props: { active: boolean }, active: boolean) {
  props.active = active;
  flushSync();
  await tick();
}

function cleanup() {
  for (const dispose of disposals.splice(0).reverse()) dispose();
  flushSync();
  resetTerminals();
}

describe.each(["xterm", "ghostty"] as const)("%s size ownership", (backend) => {
  beforeEach(async () => {
    vi.useFakeTimers();
    __testSetStandalonePreferences(terminalPreferences({ ghostty: backend === "ghostty", font_size: 15 }));
    hostGrid(132, 41);
    measurement.fits = 0;

    const control = await shown();
    expect("renderer" in control.term, "the selected backend's stand-in is running").toBe(backend === "ghostty");
    hostGrid(101, 33);
    resizeObservers.at(-1)!.callback();
    await settled();
    expect(frames(control.socket), "positive control: a shown fit sends through onResize")
      .toContainEqual(gridFrame(101, 33));
    cleanup();
    hostGrid(132, 41);
    measurement.fits = 0;
  });

  afterEach(() => {
    cleanup();
    __testSetStandalonePreferences(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("hidden host changes do not fit or publish through queued frame, trailing and retry callbacks", async () => {
    const { props, socket } = await shown();
    const pending: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback) => (pending.push(callback), pending.length);
    window.dispatchEvent(new Event("pageshow"));
    resizeObservers.at(-1)!.callback();
    await visibility(props, false);
    const before = measurement.fits;
    hostGrid(100, 30);
    resizeObservers.at(-1)!.callback();
    for (const callback of pending.splice(0)) callback(0);
    await settled();
    for (const callback of pending.splice(0)) callback(400);
    expect(measurement.fits, "hidden callbacks do not run a local fit").toBe(before);
    expect(frames(socket), "hidden callbacks publish no grid").toEqual([]);
  });

  test("hidden adoption consumes crossed broadcasts without an echo", async () => {
    const { props, term, socket } = await shown();
    await visibility(props, false);
    for (const [cols, rows] of [[100, 30], [120, 40], [100, 30], [120, 40]]) {
      await receive(socket, gridFrame(cols!, rows!));
      expect([term.cols, term.rows], "the hidden parser follows the delivered size").toEqual([cols, rows]);
      expect(frames(socket), "an adoption must not echo").toEqual([]);
    }
  });

  test("a hidden fit trigger after adoption neither fits nor sends the host grid", async () => {
    const { props, term, socket } = await shown();
    await visibility(props, false);
    await receive(socket, gridFrame(100, 30));
    socket.sent.splice(0);
    const before = measurement.fits;
    resizeObservers.at(-1)!.callback();
    window.dispatchEvent(new Event("focus"));
    await settled();
    expect(measurement.fits, "adoption cannot be followed by a hidden local fit").toBe(before);
    expect([term.cols, term.rows]).toEqual([100, 30]);
    expect(frames(socket)).toEqual([]);
  });

  test("a shown broadcast is remembered and adopted silently on hiding", async () => {
    const { props, term, socket } = await shown();
    await receive(socket, gridFrame(100, 30));
    expect([term.cols, term.rows], "shown view keeps its own fit").toEqual([132, 41]);
    await visibility(props, false);
    expect([term.cols, term.rows], "hiding adopts the last broadcast").toEqual([100, 30]);
    expect(frames(socket)).toEqual([]);
  });

  test.each([false, true])("a hidden mount measures before the dial, with reattach=%s", async (reattach) => {
    const { term, socket } = await mounted(false, reattach ? "existing-session" : undefined);
    expect([term.cols, term.rows], "the hidden mount measures its host before dialing").toEqual([132, 41]);
    expect(measurement.fits, "exactly the mount fit").toBe(1);
    const query = new URL(socket.url, "http://chan.test").searchParams;
    expect([query.get("cols"), query.get("rows")], "a hidden dial carries its measured candidate")
      .toEqual(["132", "41"]);
    expect(query.get("size_if_unset"), "a hidden reattach may only size an unsized PTY")
      .toBe(reattach ? "true" : null);
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await settled();
    expect(frames(socket), "a hidden open and ready publish nothing").toEqual([]);
    expect(measurement.fits, "ready and its retries do not fit a hidden renderer").toBe(1);
  });

  test.each([false, true])("a shown dial declares an unconditional size, with reattach=%s", async (reattach) => {
    const { socket } = await mounted(true, reattach ? "existing-session" : undefined);
    const query = new URL(socket.url, "http://chan.test").searchParams;
    expect([query.get("cols"), query.get("rows")]).toEqual(["132", "41"]);
    expect(query.get("size_if_unset"), "a shown dial may replace a previously sized PTY").toBeNull();
  });

  test.each([false, true])("a reveal publishes once even with renderer and last send equal=%s", async (equal) => {
    const { props, term, socket } = await shown();
    await visibility(props, false);
    if (!equal) hostGrid(100, 30);
    await visibility(props, true);
    await settled();
    const expected = equal ? [132, 41] : [100, 30];
    expect([term.cols, term.rows]).toEqual(expected);
    expect(frames(socket), "one measured publication is owed on reveal").toEqual([gridFrame(expected[0]!, expected[1]!)]);
  });

  test("an unmeasurable reveal waits for the first measured fit", async () => {
    const { props, socket } = await shown();
    await visibility(props, false);
    measurement.grid = null;
    xterm.fit.size = null;
    await visibility(props, true);
    await settled();
    expect(frames(socket), "an unmeasured reveal sends nothing").toEqual([]);
    hostGrid(132, 41);
    resizeObservers.at(-1)!.callback();
    await settled();
    expect(frames(socket), "the reveal stays owed until the host can be measured").toEqual([gridFrame(132, 41)]);
  });

  test("a reveal while connecting waits for open and sends exactly once", async () => {
    TerminalSocket.connecting = true;
    const { props, socket } = await mounted(false, "existing-session");
    hostGrid(100, 30);
    await visibility(props, true);
    await settled();
    expect(frames(socket), "nothing before open").toEqual([]);
    socket.open();
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await settled();
    expect(frames(socket), "open satisfies the pending reveal once").toEqual([gridFrame(100, 30)]);
  });

  test("open during a reveal waits for its queued measurement", async () => {
    TerminalSocket.connecting = true;
    const { props, socket } = await mounted(false, "existing-session");
    const pending: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback) => (pending.push(callback), pending.length);
    hostGrid(100, 30);
    props.focused = true;
    await visibility(props, true);
    socket.open();
    expect(frames(socket), "open cannot publish the grid from before the reveal").toEqual([]);
    for (const callback of pending.splice(0)) callback(0);
    await settled();
    for (const callback of pending.splice(0)) callback(400);
    expect(frames(socket), "focus and reveal share one measured publication").toEqual([gridFrame(100, 30)]);
  });

  test("recovery, focus, page show, visibility and wake do not count as reveals", async () => {
    const { props, socket } = await shown();
    await visibility(props, false);
    await receive(socket, gridFrame(100, 30));
    socket.sent.splice(0);
    await visibility(props, true);
    await settled();
    expect(frames(socket)).toEqual([gridFrame(132, 41)]);
    for (const type of ["focus", "pageshow"]) {
      window.dispatchEvent(new Event(type));
      await settled();
    }
    for (const focused of [true, false]) {
      props.focused = focused;
      flushSync();
      await settled();
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await receive(socket, { type: "ready", cols: 100, rows: 30 });
    resizeObservers.at(-1)!.callback();
    await settled();
    // A connecting socket makes wake's reconnect branch inapplicable; the
    // next open exposes a reveal spuriously left pending by that callback.
    socket.readyState = 0;
    measurement.wake!();
    await settled();
    socket.readyState = TerminalSocket.OPEN;
    resizeObservers.at(-1)!.callback();
    await settled();
    expect(frames(socket), "recovery is not another publication").toEqual([gridFrame(132, 41)]);
  });

  test("a new socket has no record of the preceding socket's sent grid", async () => {
    const { socket } = await shown();
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    const next = TerminalSocket.all.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    await receive(next, { type: "ready", cols: 132, rows: 41 });
    await settled();
    expect(frames(next), "the first measured grid belongs to this socket").toEqual([gridFrame(132, 41)]);
  });

  test("a moved shown terminal publishes even at the same grid", async () => {
    const { props, socket } = await shown();
    const layer = document.createElement("div");
    document.body.append(layer);
    disposals.push(terminalLayer("moved-pane")(layer)!);
    props.paneId = "moved-pane";
    flushSync();
    await settled();
    expect(frames(socket), "a move owes one measured publication").toEqual([gridFrame(132, 41)]);
  });

  test.each(["tab switch", "pane flip", "Hybrid Nav"])("%s hides then reveals the terminal", async (cause) => {
    const { props, tab, socket } = await shown();
    const pane = layout.nodes[TERMINAL_PANE] as LeafNode;
    if (cause === "tab switch") pane.activeTabId = null;
    if (cause === "pane flip") pane.side = "b";
    const hidden = terminalPlacements(layout, cause === "Hybrid Nav").find((p) => p.tab.id === tab.id)!;
    expect(hidden.active).toBe(false);
    await visibility(props, hidden.active);
    pane.activeTabId = tab.id;
    pane.side = "a";
    const shownAgain = terminalPlacements(layout, false).find((p) => p.tab.id === tab.id)!;
    await visibility(props, shownAgain.active);
    await settled();
    expect(frames(socket), "placement reveal owes one measured publication").toEqual([gridFrame(132, 41)]);
  });
});
