// @vitest-environment jsdom
//
// A mounted ghostty terminal at a device pixel ratio of 2: after the
// host resets the canvas behind the page's back, the next host resume
// repaints at full scale with the grid unchanged and sends no size to
// the PTY.
vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});

import TerminalTab from "./TerminalTab.svelte";
import { tick, unmount } from "svelte";
import type { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  attachGhostty, compileGhosttyCore, ghosttyLineText, installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom, output, resetTerminals, seatTerminals, sentFrames, terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

installTerminalDom();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

let canvas: ReturnType<typeof installSoftwareCanvas>;

beforeEach(() => {
  vi.useFakeTimers();
  canvas = installSoftwareCanvas();
  vi.stubGlobal("devicePixelRatio", 2);
  // A zero-size jsdom host is deliberately refused by the PTY size publisher.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 640 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 384 : 0;
  });
  __testSetStandalonePreferences(terminalPreferences());
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  resetTerminals();
  ghostty.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mounted: Record<string, unknown>[] = [];

async function attached() {
  const [tab] = seatTerminals([terminalTab()]);
  const mountedTab = mountGhostty(TerminalTab, tab!);
  mounted.push(mountedTab.component as Record<string, unknown>);
  const { host, socket, term } = await attachGhostty(ghostty, mountedTab);
  await output(socket, `${"x".repeat(80)}\r\n`.repeat(24));
  canvas.frame();
  expect(ghosttyLineText(term, 0)?.slice(0, 4)).toBe("xxxx");
  return { host, socket, term };
}

describe("a host resume after a canvas state reset at ratio 2", () => {
  test("repaints at full scale with the grid unchanged and no PTY resize", async () => {
    const { host, socket, term } = await attached();
    const { width, height } = term.renderer!.getMetrics();
    const cols = term.cols;
    const rows = term.rows;
    // Device pixels of a cell centre: the backing store is measured in
    // them, and the read must not depend on the drawing transform.
    const at = (column: number, row: number) => ({ x: (column + 0.5) * width * 2, y: (row + 0.5) * height * 2 });
    const context = canvas.context(host);
    const ink = (column: number, row: number) => context.pixelAtDevice(at(column, row).x, at(column, row).y).a;
    expect(ink(cols - 1, rows - 1), "the baseline paints the last cell").toBeGreaterThan(0);
    // The host reset: the bitmap goes transparent and the state goes
    // default, the page not told.
    context.reset();
    socket.sent.splice(0);
    window.dispatchEvent(new Event("pageshow"));
    await tick();
    await vi.advanceTimersByTimeAsync(300);
    canvas.frame();
    expect(ink(cols - 1, rows - 1), "the recovery paints the last cell at full scale").toBeGreaterThan(0);
    expect(term.cols, "no grid change").toBe(cols);
    expect(term.rows, "no grid change").toBe(rows);
    expect(
      sentFrames(socket).filter((frame) => frame.type === "resize"),
      "no size published to the PTY",
    ).toEqual([]);
  });
});
