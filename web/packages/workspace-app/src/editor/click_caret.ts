// Place pointer carets after hidden closing marks and handle row blank space.
//
// The WYSIWYG editor caps `.cm-editor` to a centered page width and
// pads `.cm-content` (60px at the bottom), so a click to the right of a
// short line, in a row's empty trailing space, or below the last line
// misses every glyph box. CodeMirror's default mouse handling hit-tests
// precisely there and, finding nothing, leaves the caret where it was -
// the click reads as "dead". We resolve those clicks to the nearest
// document position so the caret follows the pointer (a past-EOL click
// lands at the end of that row's text).
//
// CodeMirror owns glyph mousedown and drag selection. Its pointer selection
// transaction is filtered only when empty and inside a hidden closing tail.
// This module starts the pointer hold for the presses CodeMirror handles and
// ends it at the release for every press, a widget's own included. Until
// then every reveal test reads the pre-press selection
// (`decorations/selection.ts`), so a one-pixel move cannot re-hit text
// displaced by revealed marks or by a widget swapped for its source.

import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { hiddenClosingTail } from "./decorations/marks";
import {
  endHold,
  pointerHold,
  selectionForReveal,
  selectionInRange,
  startHold,
} from "./decorations/selection";

/// Map a pointer caret across every hidden closing tail it touches.
export function afterHiddenClosingTail(
  state: EditorState,
  pos: number,
  reveal = selectionForReveal(state),
): number {
  const tree = syntaxTree(state);
  for (;;) {
    let next = pos;
    tree.iterate({
      from: pos,
      to: Math.min(pos + 1, state.doc.length),
      enter(node) {
        if (selectionInRange(reveal, node.from, node.to)) return;
        const tail = hiddenClosingTail(node, state);
        if (tail && tail.from <= pos && pos < tail.to && tail.to > next) next = tail.to;
      },
    });
    if (next === pos) return pos;
    pos = next;
  }
}

const pointerSelectionFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent("select.pointer") || !tr.selection) return tr;
  const { main, ranges } = tr.selection;
  if (!main.empty || ranges.length !== 1) return tr;
  const next = afterHiddenClosingTail(tr.startState, main.head);
  return next === main.head ? tr : [tr, { selection: EditorSelection.single(next) }];
});

const startPointerObservation = EditorView.domEventObservers({
  mousedown(event, view) {
    if (event.button === 0) view.dispatch({ effects: startHold.of({ reveal: view.state.selection, scroll: false }) });
  },
});

const endPointerObservation = ViewPlugin.fromClass(
  class {
    private doc: Document;
    private win: Window | null;
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      this.doc = view.dom.ownerDocument;
      this.win = this.doc.defaultView;
      this.doc.addEventListener("mouseup", this.end);
      this.doc.addEventListener("mousemove", this.endOnButtonlessMove);
      this.doc.addEventListener("dragstart", this.end);
      this.win?.addEventListener("blur", this.end);
      view.dom.addEventListener("blur", this.end, true);
    }

    private end = () => {
      const held = this.view.state.field(pointerHold);
      if (held) this.view.dispatch({ effects: endHold.of(), scrollIntoView: held.scroll });
    };

    private endOnButtonlessMove = (event: MouseEvent) => {
      if (event.buttons === 0) this.end();
    };

    destroy() {
      this.doc.removeEventListener("mouseup", this.end);
      this.doc.removeEventListener("mousemove", this.endOnButtonlessMove);
      this.doc.removeEventListener("dragstart", this.end);
      this.win?.removeEventListener("blur", this.end);
      this.view.dom.removeEventListener("blur", this.end, true);
    }
  },
);

export function clickToPlaceCaret(): Extension {
  return [pointerHold, pointerSelectionFilter, startPointerObservation, endPointerObservation, EditorView.domEventHandlers({
    mousedown(event, view) {
      // Plain primary single-clicks only. Modified clicks (shift to
      // extend, alt for rectangular select), multi-clicks (word / line
      // select), and non-primary buttons fall through to CM6's defaults.
      if (event.button !== 0 || event.detail > 1) return false;
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
        return false;
      }
      const coords = { x: event.clientX, y: event.clientY };
      // A precise hit belongs to CodeMirror's pointer selection handler.
      if (view.posAtCoords(coords) !== null) return false;
      // No precise hit: the click is in a row's blank space. The
      // non-precise resolve never returns null for an in-editor point
      // and already snaps a past-EOL click to that line's text end.
      const near = view.posAtCoords(coords, false);
      if (near === null) return false;
      event.preventDefault();
      // The pointer transaction filter maps this placement once.
      view.dispatch({
        selection: { anchor: near },
        annotations: Transaction.userEvent.of("select.pointer.blank"),
      });
      view.focus();
      return true;
    },
  })];
}
