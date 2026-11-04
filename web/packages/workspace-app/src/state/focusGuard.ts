// The two signals under which this page must not move focus to a terminal:
// a survey modal over it, and the window's Computers launcher shown over the
// page. TerminalTab's refocus paths and the command launcher's post-run
// restore read them through one function so they cannot drift.

import { surveyFor, type SurveySlot } from "./survey.svelte";

/// chan-desktop marks the page's root while the window's Computers launcher
/// is shown over it (launcher_transition.js hostCovered). The launcher is a
/// second webview holding the keyboard; a focus change in this page would
/// move the window's first responder back here and leave the launcher deaf.
export function launcherShownOverWindow(): boolean {
  return document.documentElement.hasAttribute("data-launcher-shown");
}

/// Whether a refocus of the terminal in `slot` is refused: a survey is modal
/// over that terminal, or the Computers launcher holds the keyboard over the
/// window. Once the survey clears or the launcher hides, the same refocus
/// legitimately restores the terminal.
export function refocusRefused(slot: SurveySlot): boolean {
  return surveyFor(slot) !== null || launcherShownOverWindow();
}
