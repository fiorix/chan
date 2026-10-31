// ghostty-web's paste path, brought level with xterm.js.
//
// Two things xterm.js does that ghostty-web does not, each of which a program
// in the terminal relies on to take an image from the clipboard:
//
// - A native paste whose clipboard carries no text (an image, a file) still
//   reaches the program. xterm.js pastes the empty string, which under
//   bracketed paste is the pair ESC[200~ ESC[201~, and an agent CLI takes that
//   empty paste as its cue to read the clipboard image itself. ghostty-web's
//   paste listener returns on empty text and sends nothing.
// - A bare Ctrl+V is terminal input, the byte 0x16, on every OS: chan's paste
//   chord is Cmd+V on macOS and Ctrl+Shift+V elsewhere. ghostty-web's keydown
//   returns early on any Ctrl+V or Cmd+V, so the byte never leaves the page.
//
// Both are handled by chan before ghostty-web sees the event: the key through
// the custom key handler ghostty-web consults first, the paste through a
// capture listener on the terminal tab, which runs before ghostty-web's bubble
// listeners on its container and textarea.

/// The slice of ghostty-web's Terminal an empty paste needs.
export type GhosttyPasteTerminal = {
  hasBracketedPaste(): boolean;
  paste(text: string): void;
};

/// A bare Ctrl+V: the control character, never a paste chord, on every OS.
export function isBareControlV(e: KeyboardEvent): boolean {
  return (
    e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v"
  );
}

/// Send Ctrl+V as the byte xterm.js would, before ghostty-web's keydown drops
/// it. Same contract as handleGhosttyShiftEnter: false when chan consumed the
/// key (the custom handler wrapper then tells ghostty-web to skip it and the
/// browser's paste default is prevented), true to let every other key flow.
export function handleGhosttyControlV(
  e: KeyboardEvent,
  sendInput: (data: string) => void,
): boolean {
  if (e.type !== "keydown" || !isBareControlV(e)) return true;
  sendInput("\x16");
  e.preventDefault();
  return false;
}

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
