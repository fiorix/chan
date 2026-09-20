// May a widget write to this view?
//
// Read-only has two spellings in this editor and a widget has to answer
// both. `Wysiwyg.svelte` locks with `EditorView.editable`, which is what a
// read-mode document, a file whose write bit is off and the chat reply
// surface all reach; `RichPrompt.svelte` locks its composer with
// `EditorState.readOnly` and keeps `editable` true, because the caret must
// still move through a locked draft. A widget that checks one facet writes
// into the surfaces the other one locks.
//
// CodeMirror enforces neither against a programmatic `view.dispatch`:
// `EditorState.readOnly` is advisory, consulted by the default keymap and
// by input handling, not by dispatch. A widget that dispatches a document
// change therefore has to ask before it writes, which is what this
// predicate is for. Selection and effect dispatches are not writes and do
// not consult it: moving the caret inside a locked document is allowed.

import { EditorView } from "@codemirror/view";

/// True when a widget may dispatch a document change into `view`.
export function isWidgetWritable(view: EditorView): boolean {
  return !view.state.readOnly && view.state.facet(EditorView.editable);
}
