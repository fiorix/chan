import type { Terminal } from "@xterm/xterm";

// xterm.js's paste path, cleaned to the bytes a ghostty terminal sends.
//
// xterm.js pastes (`paste` in its Clipboard.ts) by turning each line end into
// a carriage return and framing the text in ESC[200~ and ESC[201~ while the
// program asked for bracketed paste, and removes nothing: a text that holds
// ESC[201~ ends the bracket early and the rest reaches the program as keys,
// and a Ctrl+C or Ctrl+Z in it reaches the tty's line discipline. The ghostty
// core's paste encoder turns those bytes into spaces first (ghosttyPaste.ts).
// An xterm.js terminal loads no ghostty core, so this module keeps the
// encoder's byte set and cleans the text before xterm.js's own paste frames
// it, leaving xterm.js unpatched. xtermPaste.test.ts pins the set to the
// core's `encodePaste` and to `fixtures/paste-encoder/`, the fixture the
// server's copy of the set is checked against.
//
// Every paste into an xterm.js terminal comes here: the chord's native paste,
// taken by a capture listener on the terminal tab before xterm.js's listeners
// on its textarea and element; the menu's Paste row; and the Linux desktop's
// middle click (primarySelection.ts).

/// The bytes the core's paste encoder replaces with a space: NUL, ENQ, EOT,
/// BS, ESC, DEL and the tty's control characters (Ctrl+C, Ctrl+O, Ctrl+Q,
/// Ctrl+R, Ctrl+S, Ctrl+U, Ctrl+V, Ctrl+W, Ctrl+Z, Ctrl+\). Tab, line feed
/// and carriage return are not among them, so a pasted text keeps its lines.
export const PASTE_REPLACED_BYTES: readonly number[] = [
  0x00, 0x03, 0x04, 0x05, 0x08, 0x0f, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x1a, 0x1b, 0x1c, 0x7f,
];

const REPLACED = new RegExp(
  `[${PASTE_REPLACED_BYTES.map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")}]`,
  "g",
);

/// `text` with each byte of `PASTE_REPLACED_BYTES` a space.
export function cleanPasteText(text: string): string {
  return text.replace(REPLACED, " ");
}

/// The slice of xterm.js's Terminal a paste needs.
export type XtermPasteTerminal = Pick<Terminal, "paste">;

/// Paste `text` into an xterm.js terminal: cleaned, then through xterm.js's
/// own paste, which turns each line end into a carriage return and frames the
/// text per mode 2004.
export function pasteIntoXterm(term: XtermPasteTerminal, text: string): void {
  term.paste(cleanPasteText(text));
}

/// A native paste on an xterm.js terminal, taken from xterm.js and pasted
/// cleaned, an empty one included. The event is stopped so xterm.js's own
/// listeners do not send it again, and its default prevented so the browser
/// does not leave the text in xterm.js's textarea. Returns whether chan took
/// the event: a paste with no clipboard data, or one before the terminal is
/// open, is left alone.
export function handleXtermPaste(e: ClipboardEvent, term: XtermPasteTerminal | null): boolean {
  const data = e.clipboardData;
  if (!data || !term) return false;
  e.preventDefault();
  e.stopPropagation();
  pasteIntoXterm(term, data.getData("text/plain"));
  return true;
}
