// Selection helpers used by the decoration walker and the widget providers.
//
// Two visibility primitives, per design.md spec #4:
//
//   selectionInRange(sel, from, to)
//     true if any selection range touches [from, to]. Boundary equality
//     counts as intersection - a caret AT the edge of the range reveals
//     it. The inline marks (bold, italic, strike, code), external links
//     and autolinks pass their OUTER token range, and the wikilink,
//     date, table and diagram widgets pass the range they replace.
//
//   lineIntersect(state, from, to, sel)
//     true if any selection range's line span overlaps the line span of
//     [from, to]. A heading's `#` prefix uses this so it doesn't flicker
//     on/off as the caret crosses the prefix mid-line; a code fence and
//     a page-break line use it to show their source while the caret is
//     on any of their lines.
//
// Both are pure functions, cheap enough to run per token (no allocations
// beyond the line objects `state.doc.lineAt` returns).
//
// The selection they test is `selectionForReveal`: while the primary button
// is held it is the selection from before the press, so nothing a reveal
// test decides moves under a pressed pointer, and the release shows what the
// press selected. `click_caret.ts` starts the hold for the presses CodeMirror
// handles and ends it at the release; a widget that handles its own press
// starts it through `pointerPress`.

import {
  EditorSelection,
  type EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export function selectionInRange(
  sel: EditorSelection,
  from: number,
  to: number,
): boolean {
  for (const r of sel.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

export function lineIntersect(
  state: EditorState,
  from: number,
  to: number,
  sel: EditorSelection,
): boolean {
  const tokenLineStart = state.doc.lineAt(from).from;
  const tokenLineEnd = state.doc.lineAt(to).to;
  for (const r of sel.ranges) {
    const selLineStart = state.doc.lineAt(r.from).from;
    const selLineEnd = state.doc.lineAt(r.to).to;
    if (selLineStart <= tokenLineEnd && selLineEnd >= tokenLineStart) {
      return true;
    }
  }
  return false;
}

/// A held press: the reveal selection from before it, and whether its
/// release scrolls the caret into view.
export type PointerHold = { reveal: EditorSelection; scroll: boolean };

export const startHold = StateEffect.define<PointerHold>();
export const endHold = StateEffect.define<void>();

export const pointerHold = StateField.define<PointerHold | null>({
  create: () => null,
  update(held, tr) {
    for (const effect of tr.effects) {
      if (effect.is(startHold)) return effect.value;
      if (effect.is(endHold)) return null;
    }
    // A document or non-pointer selection replaces the press context. A peer
    // edit during the press ends the hold rather than mapping that context.
    return held && (tr.docChanged || tr.selection) && !tr.isUserEvent("select.pointer") ? null : held;
  },
});

/// Selection used by every reveal test and by the walker's pointer mapping.
export function selectionForReveal(state: EditorState): EditorSelection {
  return state.field(pointerHold, false)?.reveal ?? state.selection;
}

/// Place a widget press's caret as a pointer selection under a hold, so the
/// widget stays drawn while the button is held and shows its source at the
/// release. The caller prevents the press's default, so CodeMirror's mouse
/// selection never starts and motion during the press selects nothing.
/// `scroll` brings the caret into view at the release, for a caret that can
/// land outside the widget's box once its source shows.
export function pointerPress(view: EditorView, anchor: number, scroll = false): void {
  // Focus first, as CodeMirror's own mouse selection does: a view without
  // focus does not write the new caret into the DOM selection, and the
  // focus would then read the old DOM selection back as a selection of its
  // own, which ends the hold.
  view.focus();
  view.dispatch({
    effects: startHold.of({ reveal: view.state.selection, scroll }),
    selection: EditorSelection.cursor(anchor),
    userEvent: "select.pointer",
  });
}
