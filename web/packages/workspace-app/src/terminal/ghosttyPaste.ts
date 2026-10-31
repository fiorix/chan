// ghostty-web's paste path, brought level with xterm.js.
//
// A native paste whose clipboard carries no text (an image, a file) still
// reaches the program under xterm.js: it pastes the empty string, which under
// bracketed paste is the pair ESC[200~ ESC[201~, and an agent CLI takes that
// empty paste as its cue to read the clipboard image itself. ghostty-web's
// paste listener returns on empty text and sends nothing. chan answers the
// paste first, from a capture listener on the terminal tab, which runs before
// ghostty-web's bubble listeners on its container and textarea.
//
// The bare Ctrl+V that ghostty-web would drop with its paste chords is
// keyboard input, sent by ghosttyKeys.ts like every other key.

/// The slice of ghostty-web's Terminal an empty paste needs.
export type GhosttyPasteTerminal = {
  hasBracketedPaste(): boolean;
  paste(text: string): void;
};

/// A native paste with no text on the clipboard, answered as xterm.js answers
/// it: the empty paste reaches the program, bracketed when the program asked
/// for bracketed paste, and nothing at all otherwise, since an empty plain
/// paste carries no byte. The event is stopped so ghostty-web's own listener
/// does not warn and drop it. A paste that carries text is left to ghostty-web;
/// the answer says whether chan took the event.
export function handleGhosttyEmptyPaste(
  e: ClipboardEvent,
  term: GhosttyPasteTerminal | null,
): boolean {
  const data = e.clipboardData;
  if (!data || data.getData("text/plain") !== "") return false;
  e.preventDefault();
  e.stopPropagation();
  if (term?.hasBracketedPaste()) term.paste("");
  return true;
}
