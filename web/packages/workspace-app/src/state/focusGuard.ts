// Terminal refocus, its Rich Prompt composer's focus and the command
// launcher's focus return share the same keyboard owners so none of them can
// take focus from a dialog or another webview.

import { modalDialogOpen } from "./store.svelte";
import { surveyFor, type SurveySlot } from "./survey.svelte";

/// The attribute chan-desktop sets on the page's root while the window's
/// Computers launcher is shown over it (launcher_transition.js hostCovered).
export const LAUNCHER_SHOWN_ATTR = "data-launcher-shown";

/// Whether the window's Computers launcher is shown over this page. The
/// launcher is a second webview holding the keyboard; a focus change in this
/// page would move the window's first responder back here and leave the
/// launcher deaf.
export function launcherShownOverWindow(): boolean {
  return document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR);
}

/// Whether a refocus of the terminal in `slot`, or of its Rich Prompt
/// composer, is refused: a modal dialog is open, a survey covers that
/// terminal, or the Computers launcher holds the keyboard over the window.
/// Once those owners release the keyboard, the same refocus legitimately
/// restores the terminal or its composer.
export function refocusRefused(slot: SurveySlot): boolean {
  return surveyFor(slot) !== null || launcherShownOverWindow() || modalDialogOpen();
}
