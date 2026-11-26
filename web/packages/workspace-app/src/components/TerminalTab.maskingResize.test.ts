// @vitest-environment jsdom
//
// With secret masking on, a change of the terminal's width reflows every
// wrapped line, so the masks must follow. The masker rescans the rows on
// screen at the next frame after the widget reports a resize, with no
// request from the tab; the software canvas reads the masks it paints.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import type { Terminal } from "@chan/ghostty-web-ng";
import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

import { ghosttyCellMetrics, installSoftwareCanvas, mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import type { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

installTerminalDom();

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Mask = { x: number; width: number };

/// The runs of the secret-mask colour on one row of the canvas, read at each
/// cell's centre.
function maskedSpans(context: SoftwareCanvasContext, term: Terminal, row: number): Mask[] {
  const { width, height } = ghosttyCellMetrics(term);
  const spans: Mask[] = [];
  for (let x = 0; x < term.cols; x++) {
    const pixel = context.pixelAt((x + 0.5) * width, (row + 0.5) * height);
    if (pixel.r !== 0x6c || pixel.g !== 0x6c || pixel.b !== 0x70 || pixel.a !== 1) continue;
    const previous = spans.at(-1);
    if (previous && previous.x + previous.width === x) previous.width += 1;
    else spans.push({ x, width: 1 });
  }
  return spans;
}

async function maskedTerminal() {
  for (const [name, size] of [["clientWidth", 640], ["clientHeight", 456]] as const) {
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)?.get;
    vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("terminal-host") ? size : (own?.call(this) ?? 0);
    });
  }
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: true }));
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return mounted;
}

describe("a width change with secret masking on", () => {
  test("re-masks a wrapped secret on one row when widened and on two when narrowed back", async () => {
    const canvas = installSoftwareCanvas();
    const { term } = await maskedTerminal();
    // 100 columns of NAME=value: at 80 columns the value wraps onto a
    // second row. The line ends so the cursor sits below the value.
    await output(TerminalSocket.all.at(-1)!, `API_TOKEN=${"abcdefghij".repeat(9)}\r\n`);
    const rows = () => {
      // A rescan that moves a span on a row the frame did not repaint asks
      // for a full repaint, which is the next frame.
      canvas.frame();
      canvas.frame();
      const context = canvas.context(term.element!);
      return [0, 1].map((row) => maskedSpans(context, term, row));
    };
    const wrapped = [[{ x: 10, width: 70 }], [{ x: 0, width: 20 }]];
    expect(rows(), "wrapped over two rows at 80 columns").toEqual(wrapped);

    // The height is held: a height change alone rescans the masks, so the
    // steps would pass without the width triggers they test.
    const fitted = term.rows;
    expect([term.cols, fitted], "the grid the host fits").toEqual([80, 20]);
    term.resize(120, fitted);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(`API_TOKEN=${"abcdefghij".repeat(9)}`);
    expect(rows(), "on one row at 120 columns").toEqual([[{ x: 10, width: 90 }], []]);

    term.resize(80, fitted);
    expect(rows(), "on two rows again at 80 columns").toEqual(wrapped);
  });
});
