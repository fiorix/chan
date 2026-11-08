// The chords chan-desktop's macOS menubar binds to the window or to the
// application rather than to the page under it.
//
// WKWebView offers a Command chord to the page before AppKit matches it
// against the menubar, and a page that cancels the keydown leaves AppKit
// nothing to match, so the menu item never runs. A full-window cover cancels
// every key aimed at the app behind it; it lets these keep their default
// (App.svelte's window key handler), which keeps the Computers launcher, a new
// window, hiding and quitting reachable from a window that is reconnecting or
// locked. Off macOS the desktop's key bridge claims the window-level chords
// (Ctrl+Shift+P, Ctrl+Shift+N, Ctrl+Q) before the page sees them, and a
// browser tab has no chan menubar, so neither needs the exception.

import { shortcutLetter, type ShortcutKeyEvent } from "@chan/web-shared/keyboard";

export type MenubarChord = {
  /// The menubar item the chord runs.
  item: string;
  /// The layout-resolved letter, as `shortcutLetter` names it.
  letter: string;
  shift: boolean;
  option: boolean;
};

/// Toggle Launcher, New Window and Quit Chan are chan's own items
/// (`install_app_menu` in desktop/src-tauri/src/main.rs); Hide, Hide Others
/// and Minimize come from Tauri's default macOS menubar. Edit's items act on
/// the page and New Terminal and Close Window reach the page as commands, so
/// none of them is listed: a cover blocks them as it blocks the app's chords.
export const MAC_MENUBAR_WINDOW_CHORDS: readonly MenubarChord[] = [
  { item: "Toggle Launcher", letter: "P", shift: false, option: false },
  { item: "New Window", letter: "N", shift: true, option: false },
  { item: "Quit Chan", letter: "Q", shift: false, option: false },
  { item: "Hide", letter: "H", shift: false, option: false },
  { item: "Hide Others", letter: "H", shift: false, option: true },
  { item: "Minimize", letter: "M", shift: false, option: false },
];

export type MenubarChordEvent = ShortcutKeyEvent &
  Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">;

/// True when `e` is one of those chords and the page runs in chan-desktop on
/// macOS (`macDesktop`), the one place the menubar exists.
export function isMenubarWindowChord(e: MenubarChordEvent, macDesktop: boolean): boolean {
  if (!macDesktop || !e.metaKey || e.ctrlKey) return false;
  const letter = shortcutLetter(e);
  return MAC_MENUBAR_WINDOW_CHORDS.some(
    (chord) => chord.letter === letter && chord.shift === e.shiftKey && chord.option === e.altKey,
  );
}
