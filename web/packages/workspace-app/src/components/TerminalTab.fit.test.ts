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

afterEach(() => {
  resetTerminals();
});

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

describe("the PTY's size", () => {
  test("is sent when the socket opens and whenever xterm resizes", async () => {
    const { term, socket } = await mounted();
    await attach(socket);
    expect(resizeFrames(socket)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    for (const handler of term.resizeHandlers) handler({ cols: 100, rows: 30 });
    expect(resizeFrames(socket).at(-1)).toEqual({ type: "resize", cols: 100, rows: 30 });
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
