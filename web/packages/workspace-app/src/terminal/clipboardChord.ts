import type { Command } from "../state/commands";
import { commandIdForChord } from "../state/keymapOverrides.svelte";
import { resolveEventChord } from "../state/shortcuts";
import type { TerminalBackend } from "./backend";

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

/// Whether `e` is the keydown of a chord the user assigned to the terminal's
/// Copy on this client: the key the window's handler runs that command for,
/// by the same lookup over the same `commands`. The built-in copy chord is
/// never one, even assigned again as itself: the terminal answers it and no
/// command runs.
export function isAssignedTerminalCopyChord(
  e: Event | undefined,
  commands: readonly Command[],
): boolean {
  if (!(e instanceof KeyboardEvent) || e.type !== "keydown") return false;
  const chord = resolveEventChord(e);
  return chord !== null && commandIdForChord(chord, commands) === "terminal.copy";
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

/// Convert a matched clipboard chord into the chan-level key-handler result
/// before TerminalTab applies Ghostty's inverted custom-handler contract.
/// Copy stays claimed on both backends. Native paste returns true only here so
/// Ghostty's inversion yields false and its own KeyV early-return runs without
/// calling preventDefault, matching xterm's native paste path.
export function terminalClipboardKeyHandlerResult(
  e: KeyboardEvent,
  os: string,
  backend: TerminalBackend,
): boolean {
  return backend === "ghostty" && isTerminalPasteChord(e, os);
}
