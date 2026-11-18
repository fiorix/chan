// Terminal refocus, its Rich Prompt composer's focus and the command
// launcher's focus return share the same keyboard owners so none of them can
// take focus from a dialog or another webview.

import { modalDialogOpen, topOverlay, type OverlayId } from "./store.svelte";
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

/// The launcher's mark as reactive state. The desktop sets the attribute, so
/// a MutationObserver keeps this in step: a derived value or effect that
/// read the rule while the launcher showed reads it again when it hides.
let launcherShown = $state(
  typeof document !== "undefined" &&
    document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR),
);
if (typeof document !== "undefined") {
  new MutationObserver(() => {
    launcherShown = document.documentElement.hasAttribute(LAUNCHER_SHOWN_ATTR);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [LAUNCHER_SHOWN_ATTR],
  });
}

/// One rule says who owns the keyboard over a terminal in `slot` and its
/// composer: a modal dialog, a survey over that terminal, a window-wide
/// survey, the Computers launcher while it is shown over the window, and an
/// overlay over the panes (the command launcher, Search, Settings). While
/// one of them owns the keyboard, neither the terminal nor its composer
/// takes focus by itself. Every owner is reactive state, so showing or
/// hiding one re-runs any derived value or effect that read the rule.
/// `except` names an overlay that does not count against its own return:
/// the command launcher's focus return reads the rule after it closed.
export function keyboardOwned(slot: SurveySlot, except?: OverlayId): boolean {
  if (modalDialogOpen()) return true;
  if (surveyFor(slot) !== null) return true;
  if (launcherShown) return true;
  const top = topOverlay();
  return top !== null && top !== except;
}

/// Whether a refocus of the terminal in `slot`, or of its Rich Prompt
/// composer, is refused: the shared rule, so once those owners release the
/// keyboard, the same refocus legitimately restores the terminal or its
/// composer.
export function refocusRefused(slot: SurveySlot): boolean {
  return keyboardOwned(slot);
}
