// @vitest-environment jsdom
//
// A key typed while PTY output is still being parsed reaches the broadcast
// group; a reply the parser writes in the meantime reaches this PTY alone.
// TerminalTab is mounted over the stand-in xterm with a real xterm.js behind
// it: every write is parsed by the real terminal, and the stand-in exposes
// the real terminal's internals, so its own mark on user input, fired before
// each `onData` it hands over, is what the component reads.

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const { FakeTerminal } = await import("../__tests__/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      /// A key the user types while the next write is still being parsed.
      keyDuringWrite: string | null = null;
      /// Whether that write was still unparsed when the key was typed.
      keyTypedWhileParsing: boolean | null = null;
      /// How many writes were unparsed when that key was typed, its own included.
      writesPendingAtKey: number | null = null;
      unparsed = 0;
      constructor(options: Record<string, unknown>) {
        super(options);
        this.model = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
        this.model.onData((data) => this.type(data));
      }
      get _core(): unknown {
        return (this.model as unknown as { _core: unknown })._core;
      }
      write(data: string | Uint8Array, done?: () => void): void {
        this.writtenRaw.push(data);
        this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        let parsing = true;
        this.unparsed += 1;
        this.model.write(data, () => {
          parsing = false;
          this.unparsed -= 1;
          done?.();
        });
        const key = this.keyDuringWrite;
        this.keyDuringWrite = null;
        if (key !== null) {
          this.keyTypedWhileParsing = parsing;
          this.writesPendingAtKey = this.unparsed;
          this.model.input(key);
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

import TerminalTab from "./TerminalTab.svelte";
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

type RealBacked = { model: Terminal; keyDuringWrite: string | null; keyTypedWhileParsing: boolean | null; writesPendingAtKey: number | null };

afterEach(() => {
  resetTerminals();
});

async function attached() {
  const [tab] = seatTerminals([terminalTab({ broadcastEnabled: true })]);
  const { term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-1" });
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  // The session prelude writes a reset of the program's input modes as a
  // replay. Parse it first, so the output a test sends is the one write
  // pending, and a live one.
  await parsed(term as unknown as RealBacked);
  socket.sent.splice(0);
  return { term: term as unknown as RealBacked, socket };
}

/// Wait until the real terminal has parsed everything written to it.
function parsed(term: RealBacked): Promise<void> {
  return new Promise((resolve) => term.model.write("", resolve));
}

function frames(socket: TerminalSocket, type: string): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === type)
    .map((f) => f.data);
}

describe("a terminal in a broadcast group, while its output is being parsed", () => {
  test("sends a key the user types to the group", async () => {
    const { term, socket } = await attached();
    term.keyDuringWrite = "k";
    await output(socket, "steady output\r\n");
    await parsed(term);

    expect(term.keyTypedWhileParsing).toBe(true);
    expect(term.writesPendingAtKey).toBe(1);
    expect(frames(socket, "input")).toEqual(["k"]);
    expect(frames(socket, "broadcast-input")).toEqual(["k"]);
  });

  test("sends the parser's reply to this PTY alone", async () => {
    const { term, socket } = await attached();
    await output(socket, "\x1b[6n");
    await parsed(term);

    const sent = frames(socket, "input");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\x1b\[\d+;\d+R$/);
    expect(frames(socket, "broadcast-input")).toEqual([]);
  });
});
