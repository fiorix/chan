// @vitest-environment jsdom
//
// Pasting into an xterm.js terminal. TerminalTab is mounted over the stand-in
// xterm with a real xterm.js opened in its host, so a native paste meets
// xterm.js's own paste listeners on its textarea and element, and the menu's
// Paste row reaches xterm.js's own paste; what the PTY is sent is the
// socket's input frames. Both paths must send the bytes a ghostty terminal
// sends for the same text (ghosttyPaste.test.ts): the core's paste encoder
// set as spaces, every line end a CR, framed under bracketed paste.

import type { Terminal } from "@xterm/xterm";
import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 8 }),
    fillRect() {},
    clearRect() {},
    fillText() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const { FakeTerminal } = await import("../__tests__/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      constructor(options: Record<string, unknown>) {
        super(options);
        this.model = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
        this.model.onData((data) => this.type(data));
      }
      get _core(): unknown {
        return (this.model as unknown as { _core: unknown })._core;
      }
      open(element: HTMLElement): void {
        super.open(element);
        this.model.open(element);
      }
      attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
        super.attachCustomKeyEventHandler(handler);
        this.model.attachCustomKeyEventHandler(handler);
      }
      paste(data: string): void {
        super.paste(data);
        this.model.paste(data);
      }
      focus(): void {
        this.focusCount += 1;
        this.model.focus();
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

import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
/// ghosttyPaste.test.ts's text: it would end its own bracket, colour the
/// screen, interrupt the shell, erase its line and delete a character, with
/// CRLF and LF line ends and a tab; and the same text as a ghostty terminal
/// pastes it.
const HOSTILE = "echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred\x1b[0m'\tdone\x03\x15\x7f\nlast";
const CLEANED = "echo one [201~; echo two\rprintf ' [31mred [0m'\tdone   \rlast";

const clipboard = {
  writeText: vi.fn(async (_text: string) => {}),
  readText: vi.fn(async () => ""),
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  clipboard.readText.mockReset();
  clipboard.readText.mockResolvedValue("");
});

type Model = { model: Terminal };

/// A mounted xterm.js terminal whose program asked for bracketed paste when
/// `bracketed`, with nothing sent yet.
async function attached(bracketed: boolean) {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: false }));
  const [tab] = seatTerminals([terminalTab()]);
  const { target, term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  const { model } = term as unknown as Model;
  if (bracketed) await new Promise<void>((resolve) => model.write("\x1b[?2004h", resolve));
  expect(model.modes.bracketedPasteMode, "the program's bracketed paste mode").toBe(bracketed);
  const textarea = target.querySelector<HTMLTextAreaElement>(".terminal-host textarea");
  if (!textarea) throw new Error("xterm.js opened no textarea in the host");
  socket.sent.splice(0);
  return { target, socket, textarea };
}

function inputs(socket: TerminalSocket): unknown[] {
  return sentFrames(socket)
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data);
}

/// A paste event as the browser delivers it, with the clipboard's plain text
/// stood in: jsdom builds no ClipboardEvent or DataTransfer of its own.
function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return event;
}

function framed(text: string, bracketed: boolean): string {
  return bracketed ? OPEN + text + CLOSE : text;
}

describe.each([
  { mode: "under bracketed paste", bracketed: true },
  { mode: "without bracketed paste", bracketed: false },
])("a paste into an xterm.js terminal $mode sends a ghostty terminal's bytes", ({ bracketed }) => {
  test("the paste chord's native paste reaches the program once, cleaned", async () => {
    const { textarea, socket } = await attached(bracketed);
    const event = pasteEvent(HOSTILE);
    textarea.dispatchEvent(event);
    await tick();
    expect(inputs(socket)).toEqual([framed(CLEANED, bracketed)]);
    expect(event.defaultPrevented, "the browser leaves xterm.js's textarea empty").toBe(true);
  });

  test("the menu's Paste row sends the same bytes as the chord", async () => {
    const { target, socket } = await attached(bracketed);
    clipboard.readText.mockResolvedValue(HOSTILE);
    await openBodyMenu(target);
    menuRow("Paste").click();
    await vi.waitFor(() => expect(inputs(socket)).toEqual([framed(CLEANED, bracketed)]));
  });
});

test("an empty native paste under bracketed paste is still the empty bracketed paste an agent reads an image by", async () => {
  const { textarea, socket } = await attached(true);
  textarea.dispatchEvent(pasteEvent(""));
  await tick();
  expect(inputs(socket)).toEqual([OPEN + CLOSE]);
});
