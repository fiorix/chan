/// A theme switch on a live ghostty terminal.
///
/// WHY: the widget's `setTheme` holds a copy of the theme, gives the live
/// core its new default colors and palette, swaps the colors the renderer
/// fills rows, the cursor and the selection with, and repaints, all without
/// rebuilding the terminal. The session, the screen and scrollback, the
/// selection, the scroll position and focus stay as they were, and colors
/// the program set itself stay over the new defaults. This module is the one
/// place the app switches a ghostty terminal's theme, so the tab has one call
/// for it and its tests one seam to read the theme a switch carried.

import type { ITheme, Terminal } from "@chan/ghostty-web-ng";

/// Switches `term` to `theme`. False when the terminal is not open: the
/// widget then only holds the theme, for `open()` to use.
export function applyGhosttyTheme(term: Terminal, theme: ITheme): boolean {
  term.setTheme(theme);
  return term.core !== undefined;
}
