export type TerminalClipboardChordOptions = {
  os: string;
  copySelection: () => void;
};

// These chords cannot use the registry's `Mod` token: on Linux/Windows,
// Mod+C becomes the shell's SIGINT. macOS uses bare Cmd+C/V; every other OS
// uses Ctrl+Shift+C/V so bare Ctrl+C/V remain terminal input.
export function isTerminalCopyChord(e: KeyboardEvent, os: string): boolean {
  if (e.key.toLowerCase() !== "c") return false;
  if (os === "mac") {
    return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  }
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

export function isTerminalPasteChord(e: KeyboardEvent, os: string): boolean {
  if (e.key.toLowerCase() !== "v") return false;
  if (os === "mac") {
    return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  }
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

/// Resolve a terminal clipboard chord on keydown. Copy owns the action and
/// suppresses the browser default. Paste deliberately preserves that default
/// so the browser delivers gesture-backed clipboard data to the terminal's
/// native paste listener without a WKWebView permission prompt.
export function handleTerminalClipboardChord(
  e: KeyboardEvent,
  options: TerminalClipboardChordOptions,
): boolean {
  if (e.type !== "keydown") return false;
  if (isTerminalCopyChord(e, options.os)) {
    e.preventDefault();
    options.copySelection();
    return true;
  }
  return isTerminalPasteChord(e, options.os);
}
