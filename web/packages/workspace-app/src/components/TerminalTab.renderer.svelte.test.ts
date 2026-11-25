// @vitest-environment jsdom
//
// Repaint requests reach the widget's canvas across focus and host-resume
// signals. The software context records full row clears, independently of
// the widget's renderer representation.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

import { mountGhosttyTerminal, openedGhostty } from "../__tests__/ghosttyTab";
import type { Terminal } from "@chan/ghostty-web-ng";

installTerminalDom();

const components: Array<Record<string, unknown>> = [];

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component);
  resetTerminals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mounted() {
  const [tab] = seatTerminals([terminalTab()]);
  const result = await mountGhosttyTerminal(TerminalTab, tab!);
  return { ...result, socket: TerminalSocket.all.at(-1)! };
}

function watchRows(term: Terminal) {
  const canvas = term.element!.querySelector("canvas")!;
  const context = canvas.getContext("2d")!;
  const clears = vi.spyOn(context, "clearRect");
  const metrics = term.getMetrics()!;
  const width = metrics.width * term.cols;
  const height = metrics.height;
  return {
    clear: () => clears.mockClear(),
    fullPasses: () => clears.mock.calls.filter(([x, y, w, h]) =>
      x === 0 && y === (term.rows - 1) * height && w === width && h === height).length,
    expectEveryRow() {
      for (let row = 0; row < term.rows; row++) {
        expect(clears.mock.calls, `row ${row} repainted`).toContainEqual([0, row * height, width, height]);
      }
    },
  };
}

// Each repaint runs on the next frame and once the page's fonts are ready.
// Fonts that never finish loading leave the frame alone to repaint, so the
// second pass proves the frame path by itself.
describe.each([
  ["once the fonts are ready", false],
  ["while the fonts are still loading", true],
])("the repaints %s", (_when, fontsLoading) => {
  let fontsReady: PropertyDescriptor | undefined;
  beforeEach(() => {
    if (!fontsLoading) return;
    fontsReady = Object.getOwnPropertyDescriptor(document.fonts, "ready");
    Object.defineProperty(document.fonts, "ready", { configurable: true, value: new Promise(() => {}) });
  });
  afterEach(() => {
    if (fontsReady) Object.defineProperty(document.fonts, "ready", fontsReady);
    fontsReady = undefined;
  });

  test("gaining and losing focus repaints every row", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const props = $state({ tab: tab!, paneId: TERMINAL_PANE, side: "a" as const, active: true, focused: false });
    const target = document.createElement("div");
    document.body.append(target);
    components.push(mount(TerminalTab, { target, props }));
    const term = await openedGhostty(target);
    await vi.advanceTimersByTimeAsync(400);

    const paints = watchRows(term);
    for (const focused of [true, false]) {
      paints.clear();
      props.focused = focused;
      flushSync();
      await tick();
      await vi.advanceTimersByTimeAsync(16);
      paints.expectEveryRow();
    }
  });

  test("a host resume repaints at once and again 50 and 250ms later", async () => {
    const { term } = await mounted();
    await vi.advanceTimersByTimeAsync(400);
    const paints = watchRows(term);

    window.dispatchEvent(new Event("pageshow"));
    await tick();
    await vi.advanceTimersByTimeAsync(16);
    const atOnce = paints.fullPasses();
    expect(atOnce).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(paints.fullPasses()).toBe(atOnce * 3);
  });

  test("the ready frame repaints", async () => {
    const { term, socket } = await mounted();
    await attach(socket);
    await vi.advanceTimersByTimeAsync(400);
    const paints = watchRows(term);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await tick();
    await vi.advanceTimersByTimeAsync(16);
    paints.expectEveryRow();
  });
});

describe("PTY output", () => {
  test("reaches the widget as bytes, so multi-byte glyphs arrive intact", async () => {
    const { term, socket } = await mounted();
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    const write = vi.spyOn(term, "write");
    await output(socket, "héllo ✓");

    const raw = write.mock.calls.at(-1)?.[0];
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(raw as Uint8Array)).toBe("héllo ✓");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("héllo ✓");
  });
});
