// @vitest-environment jsdom
//
// A mouse report in the X10 encoding reaches the PTY byte for byte and, as
// the user's input, the broadcast group. TerminalTab is mounted on the shared
// fixture's widget: the program's output, mouse mode 1000 among it, is parsed
// by its core, a press on its canvas is reported by its own mouse encoder,
// which hands X10 and SGR reports to `onData` like any other input, and a
// wheel over it is reported by chan's wheel handler, which the widget asks
// before it scrolls. The grid is 220 columns wide, so a column's X10
// character can be above 127.

import { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import TerminalTab from "./TerminalTab.svelte";
import {
  broadcastTerminalInput,
  registerTerminalInputSink,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import { ghosttyCellMetrics, mountGhosttyTerminal, typeInGhostty } from "../__tests__/ghosttyTab";
import { modelPointerCapture, mousePointer } from "../__tests__/pointer";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  resizeObservers,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

/// A left-button press in the one-based cell (151, 4), as its X10 report:
/// CSI M, then the button, the column and the row, each one character whose
/// code is the value plus 32.
const REPORT = `\x1b[M${String.fromCharCode(32 + 0, 32 + 151, 32 + 4)}`;

const cleanups: Array<() => void> = [];
/// What chan's wheel handler answered the widget for each wheel event:
/// true when chan took the event and the widget must not scroll.
const wheelClaims: boolean[] = [];

beforeEach(() => {
  // Records the answers of the handler TerminalTab attaches, through the
  // widget's own hook.
  const attachWheel = Terminal.prototype.attachCustomWheelEventHandler;
  vi.spyOn(Terminal.prototype, "attachCustomWheelEventHandler").mockImplementation(function (
    this: Terminal,
    handler?: (event: WheelEvent) => boolean,
  ) {
    return attachWheel.call(
      this,
      handler &&
        ((event: WheelEvent) => {
          const claimed = handler(event);
          wheelClaims.push(claimed);
          return claimed;
        }),
    );
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  resetTerminals();
  vi.restoreAllMocks();
  wheelClaims.splice(0);
  __testSetStandalonePreferences(null);
});

/// A mounted terminal of 220 by 24 cells in a broadcast group with an
/// unmounted member, whose sink records what reaches it, after the program
/// turned on mouse tracking.
async function attached() {
  __testSetStandalonePreferences(terminalPreferences());
  const [tab, member] = seatTerminals([
    terminalTab({ broadcastEnabled: true }),
    terminalTab({ id: "term-2", broadcastEnabled: true }),
  ]);
  const received: Array<[string, boolean | undefined]> = [];
  cleanups.push(registerTerminalInputSink(member!.id, (data, binary) => received.push([data, binary])));
  const { target, term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-1" });
  await receive(socket, { type: "ready", cols: 220, rows: 24 });
  // A host that holds 220 by 24 of the terminal's cells, fitted.
  const host = target.querySelector<HTMLElement>(".terminal-host")!;
  const cell = ghosttyCellMetrics(term);
  Object.defineProperty(host, "clientWidth", { configurable: true, value: 220 * cell.width });
  Object.defineProperty(host, "clientHeight", { configurable: true, value: 24 * cell.height });
  for (const observer of resizeObservers) observer.callback();
  await vi.waitFor(() => expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 220, rows: 24 }));
  // VT200 tracking with the default encoding, which is X10's.
  await output(socket, "\x1b[?1000h");
  socket.sent.splice(0);
  return { term, socket, member: member as TerminalTabState, received };
}

function inputFrames(socket: TerminalSocket): Array<Record<string, unknown>> {
  return sentFrames(socket).filter((f) => f.type === "input" || f.type === "broadcast-input");
}

function pings(socket: TerminalSocket): number {
  return sentFrames(socket).filter((frame) => frame.type === "ping").length;
}

/// The terminal's canvas, laid out at the window's origin.
function canvasOf(term: Terminal): HTMLCanvasElement {
  const canvas = term.element?.querySelector("canvas");
  if (!canvas) throw new Error("the terminal has no canvas");
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1760, 384);
  return canvas;
}

/// A left-button press in the middle of the one-based cell (151, 4), as the
/// pointer event the widget reads presses from.
function press(term: Terminal): void {
  const cell = ghosttyCellMetrics(term);
  const canvas = canvasOf(term);
  modelPointerCapture(canvas);
  mousePointer(canvas, "pointerdown", { clientX: 150.5 * cell.width, clientY: 3.5 * cell.height });
}

/// A wheel over the canvas laid out as 8 by 16 pixel cells: the one-based
/// cell (151, 4), down one line unless `delta` says otherwise. Returns
/// whether chan's handler took it.
function wheel(term: Terminal, delta: WheelEventInit = { deltaY: 1, deltaMode: 1 }): boolean {
  const asked = wheelClaims.length;
  canvasOf(term).dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 1204, clientY: 56, ...delta }),
  );
  expect(wheelClaims.length, "the widget asked chan's wheel handler once").toBe(asked + 1);
  return wheelClaims.at(-1)!;
}

describe("an X10 mouse report", () => {
  test("holds a character above 127, so UTF-8 would change its bytes", () => {
    expect([...REPORT].map((c) => c.charCodeAt(0))).toEqual([0x1b, 0x5b, 0x4d, 32, 183, 36]);
  });

  test("reaches this PTY as bytes and the group as the user's input", async () => {
    const { term, socket, received } = await attached();
    press(term);

    expect(inputFrames(socket)).toEqual([
      { type: "input", data: REPORT, binary: true },
      { type: "broadcast-input", data: REPORT, binary: true },
    ]);
    expect(received).toEqual([[REPORT, true]]);
  });

  test("from a member reaches this PTY as bytes", async () => {
    const { socket, member } = await attached();
    broadcastTerminalInput(member, REPORT, true);

    expect(inputFrames(socket)).toEqual([{ type: "input", data: REPORT, binary: true }]);
  });
});

describe("text input", () => {
  test("goes out in frames without the binary field", async () => {
    const { term, socket, member, received } = await attached();
    typeInGhostty(term, "k");
    broadcastTerminalInput(member, "m");

    const raw = socket.sent.filter((s) => /^\{"type":"(input|broadcast-input)"/.test(s));
    expect(raw).toEqual([
      '{"type":"input","data":"k"}',
      '{"type":"broadcast-input","data":"k"}',
      '{"type":"input","data":"m"}',
    ]);
    expect(received.map(([data]) => data)).toEqual(["k"]);
    expect(received.some(([, binary]) => binary)).toBe(false);
  });
});

describe("a ghostty mouse report", () => {
  test("an X10 mouse report from onData does not arm a connection probe", async () => {
    const { term, socket } = await attached();
    vi.useFakeTimers();
    typeInGhostty(term, REPORT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(0);
  });

  test("an X10 wheel report does not arm a connection probe", async () => {
    const { term, socket } = await attached();
    vi.useFakeTimers();
    expect(wheel(term)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inputFrames(socket), "the wheel was reported").toHaveLength(2);
    expect(pings(socket)).toBe(0);
  });

  test("typed ghostty data arms a connection probe", async () => {
    const { term, socket } = await attached();
    vi.useFakeTimers();
    typeInGhostty(term, "x");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("sends a wide X10 wheel report as bytes to the PTY and group", async () => {
    const { term, socket, received } = await attached();
    const report = `\x1b[M${String.fromCharCode(32 + 65, 32 + 151, 32 + 4)}`;
    expect(wheel(term)).toBe(true);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: report, binary: true },
      { type: "broadcast-input", data: report, binary: true },
    ]);
    expect.soft(received).toEqual([[report, true]]);
  });

  test("a trackpad delta under a row is claimed and sends no report", async () => {
    const { term, socket, received } = await attached();
    expect(wheel(term, { deltaY: 1 })).toBe(true);
    expect.soft(inputFrames(socket)).toEqual([]);
    expect.soft(received).toEqual([]);
  });

  test("sends an SGR wheel report as text to the PTY and group", async () => {
    const { term, socket, received } = await attached();
    await output(socket, "\x1b[?1006h");
    expect(wheel(term)).toBe(true);
    const report = "\x1b[<65;151;4M";
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: report },
      { type: "broadcast-input", data: report },
    ]);
    expect.soft(received).toEqual([[report, false]]);
  });

  test("sends a wide X10 press from onData as bytes to the PTY and group", async () => {
    const { term, socket, received } = await attached();
    typeInGhostty(term, REPORT);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: REPORT, binary: true },
      { type: "broadcast-input", data: REPORT, binary: true },
    ]);
    expect.soft(received).toEqual([[REPORT, true]]);
  });

  // A chunk shaped like a report with more bytes after it is typed input,
  // whatever its shape: text to the PTY and group, and an input the
  // connection probe waits on.
  test.each(["z", "\n"])("keeps a four-character X10 payload ending %j as typed text", async (extra) => {
    const { term, socket, received } = await attached();
    vi.useFakeTimers();
    const chunk = REPORT + extra;
    typeInGhostty(term, chunk);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: chunk },
      { type: "broadcast-input", data: chunk },
    ]);
    expect.soft(received).toEqual([[chunk, false]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test.each(["z", "\n"])("keeps an SGR report with more bytes, ending %j, as typed text", async (extra) => {
    const { term, socket, received } = await attached();
    vi.useFakeTimers();
    const chunk = "\x1b[<0;151;4M" + extra;
    typeInGhostty(term, chunk);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: chunk },
      { type: "broadcast-input", data: chunk },
    ]);
    expect.soft(received).toEqual([[chunk, false]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  // The tab reads a chunk's shape before it reads whether a PTY write is
  // being parsed. Whatever the widget emits inside a live write is otherwise
  // the core's reply to that write, which goes to this PTY alone and as text.
  test.each([
    ["an X10", "", REPORT, true],
    ["an SGR", "\x1b[?1006h", "\x1b[<0;151;4M", false],
  ] as const)("%s report emitted while a PTY write is being parsed is still the user's", async (_name, mode, report, binary) => {
    const { term, socket, received } = await attached();
    if (mode) await output(socket, mode);
    socket.sent.splice(0);
    // The widget reports a change from inside the write that made it, which
    // is inside the tab's live write.
    const change = term.onChange(() => {
      change.dispose();
      typeInGhostty(term, report);
    });
    await output(socket, "x");
    const frame = binary ? { data: report, binary } : { data: report };
    expect(inputFrames(socket)).toEqual([
      { type: "input", ...frame },
      { type: "broadcast-input", ...frame },
    ]);
    expect(received).toEqual([[report, binary]]);

    // The control: a reply the core makes to a write, from inside that
    // write, stays this PTY's own.
    socket.sent.splice(0);
    received.splice(0);
    await output(socket, "\x1b[5n");
    expect(inputFrames(socket)).toEqual([{ type: "input", data: "\x1b[0n" }]);
    expect(received).toEqual([]);
  });

  test("keeps an X10-shaped chunk above U+00FF as text", async () => {
    const { term, socket, received } = await attached();
    const chunk = "\x1b[M \u0100$";
    typeInGhostty(term, chunk);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: chunk },
      { type: "broadcast-input", data: chunk },
    ]);
    expect.soft(received).toEqual([[chunk, false]]);
  });
});
