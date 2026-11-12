// @vitest-environment jsdom
//
// Pasting into a ghostty terminal. ghostty-web's Terminal is opened over the
// binding on the vendored core, with its own paste listeners on its container
// and textarea, inside a tab element that carries chan's capture listeners
// the way TerminalTab's root does; what the terminal hands the program is
// what its onData fires.

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import {
  handleGhosttyPaste,
  handleGhosttyPasteInput,
  pasteIntoGhostty,
  pasteLineEnds,
  type GhosttyPasteTerminal,
} from "./ghosttyPaste";
import { GhosttyVt, VtTerminal } from "@chan/ghostty-web-ng/vt";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";

/// A text that would end its own bracket, colour the screen, interrupt the
/// shell, erase its line and delete a character, with CRLF and LF line ends
/// and a tab.
const HOSTILE = "echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred\x1b[0m'\tdone\x03\x15\x7f\nlast";
/// The same text as chan pastes it: each of those bytes a space, the tab
/// kept, every line end a carriage return.
const CLEANED = "echo one [201~; echo two\rprintf ' [31mred [0m'\tdone   \rlast";

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// A ghostty-web terminal on the vendored core, opened in a host inside a tab
/// element with chan's capture listeners on it; `sent` is every string the
/// terminal handed the program. With `bracketed`, the program asked for
/// bracketed paste (DECSET 2004).
async function openTerminal(bracketed: boolean) {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: 40, rows: 6, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const tab = document.createElement("div");
  const host = document.createElement("div");
  tab.append(host);
  document.body.append(tab);
  tab.addEventListener("paste", (e) => void handleGhosttyPaste(e as ClipboardEvent, term), true);
  tab.addEventListener("beforeinput", (e) => void handleGhosttyPasteInput(e as InputEvent, term), true);
  term.open(host);
  opened.push(term);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  if (bracketed) term.write("\x1b[?2004h");
  expect(term.hasBracketedPaste(), "the program's bracketed paste mode").toBe(bracketed);
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("ghostty-web opened no textarea");
  return { term, host, textarea, sent };
}

/// A paste event as the browser delivers it, with the clipboard's plain text
/// stood in: jsdom builds no ClipboardEvent or DataTransfer of its own.
function pasteEvent(text: string | null): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: text === null ? null : { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return event;
}

function framed(text: string, bracketed: boolean): string {
  return bracketed ? OPEN + text + CLOSE : text;
}

describe.each([
  { mode: "under bracketed paste", bracketed: true },
  { mode: "without bracketed paste", bracketed: false },
])("a paste into a ghostty terminal $mode is cleaned on every path", ({ bracketed }) => {
  test("the paste chord's native paste reaches the program once, cleaned, and ghostty-web's listener is not reached", async () => {
    const { textarea, sent } = await openTerminal(bracketed);
    const event = pasteEvent(HOSTILE);
    textarea.dispatchEvent(event);
    expect(sent).toEqual([framed(CLEANED, bracketed)]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("the menu's Paste row sends the same bytes as the chord", async () => {
    const { term, sent } = await openTerminal(bracketed);
    pasteIntoGhostty(term, HOSTILE);
    expect(sent).toEqual([framed(CLEANED, bracketed)]);
  });

  test("a paste delivered as an insertFromPaste input with no paste event sends the same bytes once", async () => {
    const { textarea, sent } = await openTerminal(bracketed);
    const event = new InputEvent("beforeinput", {
      inputType: "insertFromPaste",
      data: HOSTILE,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    expect(sent).toEqual([framed(CLEANED, bracketed)]);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("pasting into a ghostty terminal", () => {
  test("line ends reach the program as xterm.js sends them: CRLF, LF and CR each a CR", async () => {
    expect(pasteLineEnds("a\r\nb\nc\rd\n")).toBe("a\rb\rc\rd\r");
    const { term, sent } = await openTerminal(true);
    pasteIntoGhostty(term, "a\r\nb\nc\rd");
    expect(sent).toEqual([`${OPEN}a\rb\rc\rd${CLOSE}`]);
  });

  test("text outside ASCII and every character a paste keeps reach the program as they are", async () => {
    const text = "héllo 世界 🙂 é \u{e0b0} \t\x07\x1a?";
    const { term, sent } = await openTerminal(true);
    pasteIntoGhostty(term, text);
    // Ctrl+Z (0x1a) is the one byte here the encoder replaces.
    expect(sent).toEqual([`${OPEN}héllo 世界 🙂 é \u{e0b0} \t\x07 ?${CLOSE}`]);
  });

  test("a paste clears the selection first, as ghostty-web's input path does", async () => {
    const { term, textarea } = await openTerminal(true);
    term.write("selected text");
    term.select(0, 0, 8);
    expect(term.hasSelection()).toBe(true);
    textarea.dispatchEvent(pasteEvent("x"));
    expect(term.hasSelection()).toBe(false);
  });

  test("an empty paste is an empty bracketed paste under bracketed paste, which ghostty-web would drop", async () => {
    const { textarea, sent } = await openTerminal(true);
    const event = pasteEvent("");
    textarea.dispatchEvent(event);
    expect(sent).toEqual([OPEN + CLOSE]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("without bracketed paste an empty paste sends nothing and is still taken from ghostty-web", async () => {
    const warn = vi.spyOn(console, "warn");
    const { textarea, sent } = await openTerminal(false);
    const event = pasteEvent("");
    textarea.dispatchEvent(event);
    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(warn, "ghostty-web's own listener warns of an empty clipboard").not.toHaveBeenCalled();
  });

  test("a paste with no clipboard data, or before the terminal is open, is left alone", async () => {
    const { term } = await openTerminal(true);
    const noData = pasteEvent(null);
    expect(handleGhosttyPaste(noData, term)).toBe(false);
    expect(noData.defaultPrevented).toBe(false);
    const early = pasteEvent("text");
    expect(handleGhosttyPaste(early, null)).toBe(false);
    expect(early.defaultPrevented).toBe(false);
    const input = new InputEvent("beforeinput", { inputType: "insertFromPaste", data: "text", cancelable: true });
    expect(handleGhosttyPasteInput(input, null)).toBe(false);
    expect(input.defaultPrevented).toBe(false);
  });

  test("any other input is left to ghostty-web", async () => {
    const { textarea, sent } = await openTerminal(true);
    const event = new InputEvent("beforeinput", { inputType: "insertText", data: "a", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    // ghostty-web types it itself.
    expect(sent).toEqual(["a"]);
  });

  test("a terminal over another core pastes through ghostty-web's own paste, line ends converted", () => {
    const pastes: string[] = [];
    const term: GhosttyPasteTerminal = {
      wasmTerm: {},
      hasBracketedPaste: () => false,
      paste: (text) => void pastes.push(text),
      input: () => {
        throw new Error("input is the binding's path");
      },
    };
    pasteIntoGhostty(term, "a\nb");
    pasteIntoGhostty(term, "");
    expect(pastes).toEqual(["a\rb"]);
  });
});

describe("the core's paste encoder, native Ghostty's", () => {
  /// NUL, ENQ, EOT, BS, DEL, ESC and the tty's control characters. CR, LF
  /// and TAB are not among them: the encoder keeps every line end.
  const REPLACED = [0x00, 0x03, 0x04, 0x05, 0x08, 0x0f, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x1a, 0x1b, 0x1c, 0x7f];

  async function core(): Promise<VtTerminal> {
    const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
    const terminal: unknown = vt.createTerminal(40, 6);
    if (!(terminal instanceof VtTerminal)) throw new Error("not chan's binding");
    return terminal;
  }

  test("replaces NUL, BS, ENQ, EOT, ESC, DEL and the ten tty control characters with a space, and keeps every other byte", async () => {
    const terminal = await core();
    terminal.write("\x1b[?2004h");
    for (let byte = 0; byte < 0x80; byte++) {
      const ch = String.fromCharCode(byte);
      const want = REPLACED.includes(byte) ? " " : ch;
      expect(terminal.encodePaste(`a${ch}z`), `byte 0x${byte.toString(16)}`).toBe(`${OPEN}a${want}z${CLOSE}`);
    }
    for (const kept of ["\r", "\n", "\t"]) expect(REPLACED).not.toContain(kept.charCodeAt(0));
  });

  test("keeps a text's line ends under bracketed paste and turns each line feed into a carriage return without it", async () => {
    const terminal = await core();
    expect(terminal.encodePaste("a\nb\r\nc")).toBe("a\rb\r\rc");
    expect(terminal.encodePaste("")).toBe("");
    terminal.write("\x1b[?2004h");
    expect(terminal.encodePaste("a\nb\r\nc")).toBe(`${OPEN}a\nb\r\nc${CLOSE}`);
    expect(terminal.encodePaste("")).toBe(OPEN + CLOSE);
  });
});
