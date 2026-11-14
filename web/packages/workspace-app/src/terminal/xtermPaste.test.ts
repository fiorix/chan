// @vitest-environment jsdom
//
// The xterm.js paste's copy of the ghostty core's paste encoder byte set:
// read off the core over every ASCII byte, checked against the fixture the
// server's copy is pinned to, and the bytes a real xterm.js paste sends with
// it, the same as a ghostty terminal's for every ASCII byte.

import { readFileSync } from "node:fs";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { GhosttyVt, VtTerminal } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { pasteIntoGhostty, type GhosttyPasteTerminal } from "./ghosttyPaste";
import { cleanPasteText, handleXtermPaste, PASTE_REPLACED_BYTES, pasteIntoXterm } from "./xtermPaste";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
/// The set the server's submit encoding is pinned to (chan-shell submit.rs).
const FIXTURE = "../../../fixtures/paste-encoder/replaced-bytes.json";

let vendored: WebAssembly.Module;
let Terminal: typeof XtermTerminal;
const opened: XtermTerminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 8 }),
    fillRect() {},
    clearRect() {},
    fillText() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (window as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  ({ Terminal } = await import("@xterm/xterm"));
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
});

/// The vendored core, with bracketed paste on when `bracketed`.
async function core(bracketed: boolean): Promise<VtTerminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const terminal: unknown = vt.createTerminal(40, 6);
  if (!(terminal instanceof VtTerminal)) throw new Error("not chan's binding");
  if (bracketed) terminal.write("\x1b[?2004h");
  expect(terminal.hasBracketedPaste()).toBe(bracketed);
  return terminal;
}

/// What a ghostty terminal over `terminal` sends for a paste of `text`.
function ghosttySends(terminal: VtTerminal, text: string): string[] {
  const sent: string[] = [];
  const term: GhosttyPasteTerminal = {
    wasmTerm: terminal,
    hasBracketedPaste: () => terminal.hasBracketedPaste(),
    paste: () => {
      throw new Error("the core's encoder is the path");
    },
    input: (data) => void sent.push(data),
  };
  pasteIntoGhostty(term, text);
  return sent;
}

/// A real xterm.js terminal, opened, with bracketed paste on when
/// `bracketed`; `sent` is every string it hands the program.
async function xterm(bracketed: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 6 });
  term.open(host);
  opened.push(term);
  if (bracketed) await new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve));
  expect(term.modes.bracketedPasteMode).toBe(bracketed);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  return { term, sent };
}

describe.each([
  { mode: "under bracketed paste", bracketed: true },
  { mode: "without bracketed paste", bracketed: false },
])("$mode", ({ bracketed }) => {
  test("the set is the bytes the core's encodePaste turns into a space, over every ASCII byte", async () => {
    const terminal = await core(bracketed);
    const replaced: number[] = [];
    for (let byte = 0; byte < 0x80; byte++) {
      const ch = String.fromCharCode(byte);
      const encoded = terminal.encodePaste(`a${ch}z`);
      const body = bracketed ? encoded.slice("\x1b[200~".length, -"\x1b[201~".length) : encoded;
      if (ch !== " " && body === "a z") replaced.push(byte);
    }
    expect(replaced).toEqual([...PASTE_REPLACED_BYTES]);
  });

  test("an xterm.js paste sends what a ghostty paste sends, for every ASCII byte", async () => {
    const terminal = await core(bracketed);
    const { term, sent } = await xterm(bracketed);
    const differ: string[] = [];
    for (let byte = 0; byte < 0x80; byte++) {
      const text = `a${String.fromCharCode(byte)}z`;
      sent.splice(0);
      pasteIntoXterm(term, text);
      const ghostty = ghosttySends(terminal, text);
      if (JSON.stringify(sent) !== JSON.stringify(ghostty)) {
        differ.push(`0x${byte.toString(16)}: xterm.js ${JSON.stringify(sent)}, ghostty ${JSON.stringify(ghostty)}`);
      }
    }
    expect(differ).toEqual([]);
  });
});

test("the fixture the server's copy is pinned to holds the same set", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { replaced: string[] };
  expect(fixture.replaced.map((hex) => Number.parseInt(hex, 16))).toEqual([...PASTE_REPLACED_BYTES]);
});

test("cleaning keeps line ends, tabs and text outside ASCII as they are", () => {
  const text = "héllo 世界 🙂 é \u{e0b0}\r\n\t\x07line";
  expect(cleanPasteText(text)).toBe(text);
  expect(cleanPasteText("\x1b[201~\x00\x7f")).toBe(" [201~  ");
});

test("a native paste with no clipboard data, or before the terminal is open, is left to xterm.js", async () => {
  const { term } = await xterm(true);
  const noData = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(noData, "clipboardData", { value: null });
  expect(handleXtermPaste(noData, term)).toBe(false);
  expect(noData.defaultPrevented).toBe(false);
  const early = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(early, "clipboardData", { value: { getData: () => "text" } });
  expect(handleXtermPaste(early, null)).toBe(false);
  expect(early.defaultPrevented).toBe(false);
});
