import { VtTerminal } from "./ghosttyVt";

// ghostty-web's paste path, cleaned and brought level with xterm.js.
//
// ghostty-web frames a paste in ESC[200~ and ESC[201~ while the program asked
// for bracketed paste and sends the text otherwise unchanged, so a text that
// holds ESC[201~ ends the bracket early and the rest is typed as keys, and a
// line feed reaches the program where xterm.js sends a carriage return. Its
// paste listener also returns on empty text and sends nothing, where xterm.js
// pastes the empty string, which under bracketed paste is the pair ESC[200~
// ESC[201~ an agent CLI takes as its cue to read a clipboard image itself.
//
// chan pastes into a ghostty terminal through `pasteIntoGhostty`: line ends as
// xterm.js converts them, then the core's own paste encoder, which turns the
// control bytes that could end the bracket or act as keys into spaces and
// frames the text per mode 2004. It answers a native paste and a
// `beforeinput` paste first, from capture listeners on the terminal tab, which
// run before ghostty-web's listeners on its container and textarea; the
// menu's Paste row calls it directly.
//
// The bare Ctrl+V that ghostty-web would drop with its paste chords is
// keyboard input, sent by ghosttyKeys.ts like every other key.

/// The slice of ghostty-web's Terminal a paste needs.
export type GhosttyPasteTerminal = {
  readonly wasmTerm?: unknown;
  hasBracketedPaste(): boolean;
  paste(text: string): void;
  input(data: string, wasUserInput?: boolean): void;
  clearSelection?(): void;
};

/// A paste's line ends as xterm.js sends them (`prepareTextForTerminal`):
/// each `\r\n` and `\n` becomes `\r`, the byte Enter sends, with or without
/// bracketed paste.
export function pasteLineEnds(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

/// Paste `text` into a ghostty terminal: line ends as xterm.js converts them,
/// then the core's paste encoder (`VtTerminal.encodePaste`), sent as the
/// user's input, so ghostty-web's own framing is never reached. An empty
/// text is an empty bracketed paste under bracketed paste, and nothing
/// otherwise. A terminal over another core pastes through ghostty-web's own
/// paste, line ends converted.
export function pasteIntoGhostty(term: GhosttyPasteTerminal, text: string): void {
  const lines = pasteLineEnds(text);
  const core = term.wasmTerm;
  if (!(core instanceof VtTerminal)) {
    if (lines || term.hasBracketedPaste()) term.paste(lines);
    return;
  }
  const data = core.encodePaste(lines);
  if (data) term.input(data, true);
}

/// A native paste on a ghostty terminal, taken from ghostty-web and pasted
/// cleaned, an empty one included. The selection is cleared first, as
/// ghostty-web's input path clears it. The event is stopped so ghostty-web's
/// own listener neither sends it again nor warns. Returns whether chan took
/// the event: a paste with no clipboard data, or one before the terminal is
/// open, is left alone.
export function handleGhosttyPaste(e: ClipboardEvent, term: GhosttyPasteTerminal | null): boolean {
  const data = e.clipboardData;
  if (!data || !term) return false;
  e.preventDefault();
  e.stopPropagation();
  term.clearSelection?.();
  pasteIntoGhostty(term, data.getData("text/plain"));
  return true;
}

/// A paste a browser delivers as an `insertFromPaste` input with no paste
/// event before it (a mobile keyboard's clipboard), which ghostty-web would
/// frame unclean from its textarea: taken and pasted as `handleGhosttyPaste`
/// pastes. Any other input is left to ghostty-web.
export function handleGhosttyPasteInput(e: InputEvent, term: GhosttyPasteTerminal | null): boolean {
  if (e.inputType !== "insertFromPaste" || !term) return false;
  e.preventDefault();
  e.stopPropagation();
  term.clearSelection?.();
  pasteIntoGhostty(term, e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
  return true;
}
