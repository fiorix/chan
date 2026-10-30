// @vitest-environment jsdom
//
// A mouse report in the X10 encoding reaches the PTY byte for byte and, as
// the user's input, the broadcast group. TerminalTab is mounted over the
// stand-in xterm with a real xterm.js behind it: the program's output, mouse
// mode 1000 among it, is parsed by the real terminal, and a click is reported
// by the real terminal's mouse service, which encodes it as X10 and hands it
// to `onBinary` with no user-input mark.

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, test, vi } from "vitest";

/// What xterm.js's mouse service takes: a zero-based cell, a button and an action.
type Click = { col: number; row: number; x: number; y: number; button: number; action: number };

vi.mock("@xterm/xterm", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const { FakeTerminal } = await import("../__tests__/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      /// A click the real terminal reports while the next write is still being parsed.
      clickDuringWrite: Click | null = null;
      /// Whether that write was still unparsed when the click was reported.
      clickedWhileParsing: boolean | null = null;
      constructor(options: Record<string, unknown>) {
        super(options);
        // Wide enough for a column whose X10 character is above 127.
        this.model = new Terminal({ allowProposedApi: true, cols: 220, rows: 24 });
        this.model.onData((data) => this.type(data));
        this.model.onBinary((data) => this.binary(data));
      }
      get _core(): unknown {
        return (this.model as unknown as { _core: unknown })._core;
      }
      /// Report a click through the real terminal's mouse service; whether it
      /// made a report.
      click(e: Click): boolean {
        const core = this._core as { coreMouseService: { triggerMouseEvent(e: Click): boolean } };
        return core.coreMouseService.triggerMouseEvent(e);
      }
      write(data: string | Uint8Array, done?: () => void): void {
        this.writtenRaw.push(data);
        this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        let parsing = true;
        this.model.write(data, () => {
          parsing = false;
          done?.();
        });
        const click = this.clickDuringWrite;
        this.clickDuringWrite = null;
        if (click !== null) {
          this.clickedWhileParsing = parsing;
          if (!this.click(click)) throw new Error("the mouse service made no report");
        }
      }
      dispose(): void {
        this.model.dispose();
        super.dispose();
      }
    },
  };
});
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

vi.mock("../terminal/backend", async (importOriginal) => {
  const { FakeTerminal } = await import("../__tests__/xterm");
  class GhosttyTerminal extends FakeTerminal {
    cols = 220;
    sgr = false;
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    renderer = { getMetrics: () => ({ width: 8, height: 16 }) };
    buffer = { active: {}, alternate: {} };
    attachCustomWheelEventHandler(handler?: (e: WheelEvent) => boolean): void {
      this.wheelHandler = handler ?? null;
    }
    hasMouseTracking() {
      return true;
    }
    hasFocusEvents() {
      return false;
    }
    getMode(mode: number, fallback: boolean) {
      return mode === 1006 ? this.sgr : fallback;
    }
  }
  return {
    ...(await importOriginal<typeof import("../terminal/backend")>()),
    loadGhosttyKit: async () => ({ instantiate: async () => ({}), Terminal: GhosttyTerminal }),
  };
});
vi.mock("../terminal/ghosttyCompat", () => ({
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));
vi.mock("../terminal/ghosttyViewport", () => ({
  GhosttyViewportController: class {
    constructor(private term: { write(bytes: Uint8Array): void }) {}
    // ghostty-web parses synchronously; a report emitted inside write sees
    // the component's live-write origin until write returns.
    write(bytes: Uint8Array) {
      this.term.write(bytes);
    }
    handleWheel() {
      return false;
    }
    dispose() {}
  },
}));
vi.mock("../terminal/osc52Bridge", () => ({
  Osc52Bridge: class {
    push() {}
  },
}));
vi.mock("../terminal/resize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/resize")>()),
  proposeGhosttyDimensions: () => ({ cols: 220, rows: 24 }),
}));

import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import type { FakeTerminal } from "../__tests__/xterm";
import TerminalTab from "./TerminalTab.svelte";
import {
  broadcastTerminalInput,
  registerTerminalInputSink,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

type RealBacked = {
  model: Terminal;
  clickDuringWrite: Click | null;
  clickedWhileParsing: boolean | null;
  click(e: Click): boolean;
  type(data: string): void;
};

/// A left-button press in the zero-based cell (150, 3). The mouse service
/// moves the event's cell to one-based in place, so each report takes a fresh
/// event.
const click = (): Click => ({ col: 150, row: 3, x: 0, y: 0, button: 0, action: 1 });
/// Its X10 report: CSI M, then the button, the one-based column and the
/// one-based row, each one character whose code is the value plus 32.
const REPORT = `\x1b[M${String.fromCharCode(32 + 0, 32 + 151, 32 + 4)}`;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetTerminals();
  __testSetStandalonePreferences(null);
});

/// A mounted terminal in a broadcast group with an unmounted member, whose
/// sink records what reaches it, after the program turned on mouse tracking.
async function attached() {
  const [tab, member] = seatTerminals([
    terminalTab({ broadcastEnabled: true }),
    terminalTab({ id: "term-2", broadcastEnabled: true }),
  ]);
  const received: Array<[string, boolean | undefined]> = [];
  cleanups.push(registerTerminalInputSink(member!.id, (data, binary) => received.push([data, binary])));
  const { term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-1" });
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  const real = term as unknown as RealBacked;
  await parsed(real);
  // VT200 tracking with the default encoding, which is X10's.
  await output(socket, "\x1b[?1000h");
  await parsed(real);
  socket.sent.splice(0);
  return { term: real, socket, member: member as TerminalTabState, received };
}

/// Wait until the real terminal has parsed everything written to it.
function parsed(term: RealBacked): Promise<void> {
  return new Promise((resolve) => term.model.write("", resolve));
}

function inputFrames(socket: TerminalSocket): Array<Record<string, unknown>> {
  return sentFrames(socket).filter((f) => f.type === "input" || f.type === "broadcast-input");
}

describe("an X10 mouse report", () => {
  test("holds a character above 127, so UTF-8 would change its bytes", () => {
    expect([...REPORT].map((c) => c.charCodeAt(0))).toEqual([0x1b, 0x5b, 0x4d, 32, 183, 36]);
  });

  test("reaches this PTY as bytes and the group as the user's input", async () => {
    const { term, socket, received } = await attached();
    expect(term.click(click())).toBe(true);

    expect(inputFrames(socket)).toEqual([
      { type: "input", data: REPORT, binary: true },
      { type: "broadcast-input", data: REPORT, binary: true },
    ]);
    expect(received).toEqual([[REPORT, true]]);
  });

  test("reaches the group when made while the terminal's output is parsed", async () => {
    const { term, socket, received } = await attached();
    term.clickDuringWrite = click();
    await output(socket, "steady output\r\n");
    await parsed(term);

    expect(term.clickedWhileParsing).toBe(true);
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
    term.type("k");
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

type GhosttyStandIn = FakeTerminal & {
  sgr: boolean;
  wheelHandler: ((e: WheelEvent) => boolean) | null;
};

async function attachedGhostty() {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
  const [tab, member] = seatTerminals([
    terminalTab({ broadcastEnabled: true }),
    terminalTab({ id: "term-2", broadcastEnabled: true }),
  ]);
  const received: Array<[string, boolean | undefined]> = [];
  cleanups.push(registerTerminalInputSink(member!.id, (data, binary) => received.push([data, binary])));
  const { term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-1" });
  await receive(socket, { type: "ready", cols: 220, rows: 24 });
  const ghostty = term as GhosttyStandIn;
  expect(ghostty.wheelHandler).toBeTypeOf("function");
  socket.sent.splice(0);
  return { term: ghostty, socket, received };
}

/// An 8x16 cell grid: one-based column 151, row 4, down one line unless
/// `delta` says otherwise.
function wheel(term: GhosttyStandIn, delta: WheelEventInit = { deltaY: 1, deltaMode: 1 }): void {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1760, 384);
  let claimed = false;
  canvas.addEventListener("wheel", (event) => {
    claimed = term.wheelHandler!(event);
  });
  canvas.dispatchEvent(new WheelEvent("wheel", { clientX: 1204, clientY: 56, ...delta }));
  expect(claimed).toBe(true);
}

describe("a ghostty mouse report", () => {
  test("sends a wide X10 wheel report as bytes to the PTY and group", async () => {
    const { term, socket, received } = await attachedGhostty();
    const report = `\x1b[M${String.fromCharCode(32 + 65, 32 + 151, 32 + 4)}`;
    wheel(term);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: report, binary: true },
      { type: "broadcast-input", data: report, binary: true },
    ]);
    expect.soft(received).toEqual([[report, true]]);
  });

  test("a trackpad delta under a row is claimed and sends no report", async () => {
    const { term, socket, received } = await attachedGhostty();
    wheel(term, { deltaY: 1 });
    expect.soft(inputFrames(socket)).toEqual([]);
    expect.soft(received).toEqual([]);
  });

  test("sends an SGR wheel report as text to the PTY and group", async () => {
    const { term, socket, received } = await attachedGhostty();
    term.sgr = true;
    wheel(term);
    const report = "\x1b[<65;151;4M";
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: report },
      { type: "broadcast-input", data: report },
    ]);
    expect.soft(received).toEqual([[report, false]]);
  });

  test("sends a wide X10 press from onData as bytes to the PTY and group", async () => {
    const { term, socket, received } = await attachedGhostty();
    term.type(REPORT);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: REPORT, binary: true },
      { type: "broadcast-input", data: REPORT, binary: true },
    ]);
    expect.soft(received).toEqual([[REPORT, true]]);
  });

  test("sends an X10 press during a live write to the PTY and group", async () => {
    const { term, socket, received } = await attachedGhostty();
    term.replyDuringWrite = REPORT;
    await output(socket, "steady output\r\n");
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: REPORT, binary: true },
      { type: "broadcast-input", data: REPORT, binary: true },
    ]);
    expect.soft(received).toEqual([[REPORT, true]]);
  });

  test("sends an SGR press during a live write as text to the PTY and group", async () => {
    const { term, socket, received } = await attachedGhostty();
    const report = "\x1b[<0;151;4M";
    term.replyDuringWrite = report;
    await output(socket, "steady output\r\n");
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: report },
      { type: "broadcast-input", data: report },
    ]);
    expect.soft(received).toEqual([[report, false]]);
  });

  test("keeps a four-character X10 payload as text at this PTY during a live write", async () => {
    const { term, socket, received } = await attachedGhostty();
    for (const extra of ["z", "\n"]) {
      const chunk = REPORT + extra;
      term.replyDuringWrite = chunk;
      await output(socket, "steady output\r\n");
      expect.soft(inputFrames(socket)).toEqual([{ type: "input", data: chunk }]);
      expect.soft(received).toEqual([]);
      socket.sent.splice(0);
    }
  });

  test("keeps an SGR report with more bytes as text at this PTY during a live write", async () => {
    const { term, socket, received } = await attachedGhostty();
    for (const extra of ["z", "\n"]) {
      const chunk = "\x1b[<0;151;4M" + extra;
      term.replyDuringWrite = chunk;
      await output(socket, "steady output\r\n");
      expect.soft(inputFrames(socket)).toEqual([{ type: "input", data: chunk }]);
      expect.soft(received).toEqual([]);
      socket.sent.splice(0);
    }
  });

  test("keeps an X10-shaped chunk above U+00FF as text", async () => {
    const { term, socket, received } = await attachedGhostty();
    const chunk = "\x1b[M \u0100$";
    term.type(chunk);
    expect.soft(inputFrames(socket)).toEqual([
      { type: "input", data: chunk },
      { type: "broadcast-input", data: chunk },
    ]);
    expect.soft(received).toEqual([[chunk, false]]);
  });
});
