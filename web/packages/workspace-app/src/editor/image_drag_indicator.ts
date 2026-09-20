// Live source-row indicator for the image drag-to-move. While
// a rendered image atom is dragged to reposition it, this shows WHERE
// its `![](src)` will land: a drop-line across the top of the target
// source line (the insert point moveImageSource uses) plus a
// pointer-following badge naming the row (line N + its text). Torn down
// on drop / dragend / dragleave.
//
// The source range is captured at dragstart (beginImageDrag) because
// dragover can't read the IMAGE_MOVE_MIME payload (getData is protected
// during dragover); the range is what lets dragover tell a real move
// from a drop back onto the image's own row ("stays here").

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

interface DragTarget {
  linePos: number; // target line `from` (the insert point)
  lineNo: number; // 1-based line number
  text: string; // target line text, for the badge snippet
  x: number; // pointer clientX
  y: number; // pointer clientY
  noop: boolean; // dropping here is a no-op (the image's own row)
}

interface DragState {
  source: { from: number; to: number };
  target: DragTarget | null;
}

const setDragState = StateEffect.define<DragState | null>();

const dragField = StateField.define<DragState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDragState)) return e.value;
    // The drop mutates the doc; tear the indicator down with it so a
    // successful move never leaves a stale line behind.
    if (value && tr.docChanged) return null;
    return value;
  },
});

const dropLine = Decoration.line({ class: "cm-md-image-drop-line" });
const dropLineNoop = Decoration.line({
  class: "cm-md-image-drop-line cm-md-image-drop-noop",
});

const dropDecorations = EditorView.decorations.compute([dragField], (state) => {
  const s = state.field(dragField);
  if (!s?.target) return Decoration.none;
  const deco = s.target.noop ? dropLineNoop : dropLine;
  return Decoration.set([deco.range(s.target.linePos)]);
});

const SNIPPET_MAX = 40;
export function rowSnippet(text: string): string {
  const t = text.trim();
  if (!t) return "(empty line)";
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX)}…` : t;
}

const dropBadge = ViewPlugin.fromClass(
  class {
    el: HTMLElement | null = null;
    update(u: ViewUpdate): void {
      const target = u.state.field(dragField)?.target ?? null;
      if (!target) {
        this.el?.remove();
        this.el = null;
        return;
      }
      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "cm-md-image-drop-badge";
        document.body.appendChild(this.el);
      }
      this.el.textContent = target.noop
        ? "stays here"
        : `line ${target.lineNo} · ${rowSnippet(target.text)}`;
      this.el.classList.toggle("cm-md-image-drop-badge-noop", target.noop);
      // Offset from the pointer so the cursor never sits on the badge.
      this.el.style.left = `${target.x + 14}px`;
      this.el.style.top = `${target.y + 16}px`;
    }
    destroy(): void {
      this.el?.remove();
    }
  },
);

export const imageDragIndicator: Extension = [
  dragField,
  dropDecorations,
  dropBadge,
];

/// Record the dragged image's source range so dragover can tell a real
/// move from a drop back onto the same row. Called from the image
/// widget's dragstart.
export function startImageDragIndicator(
  view: EditorView,
  source: { from: number; to: number },
): void {
  view.dispatch({ effects: setDragState.of({ source, target: null }) });
}

/// Resolve the target source line under the pointer and refresh the
/// indicator. Called from the editor's dragover while an image move is
/// in flight; `x`/`y` are the pointer's clientX/clientY.
export function updateImageDropTarget(
  view: EditorView,
  x: number,
  y: number,
): void {
  const state = view.state.field(dragField, false);
  if (!state) return;
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return;
  const line = view.state.doc.lineAt(pos);
  const srcLine = view.state.doc.lineAt(state.source.from);
  const target: DragTarget = {
    linePos: line.from,
    lineNo: line.number,
    text: line.text,
    x,
    y,
    noop: line.from === srcLine.from,
  };
  const prev = state.target;
  if (
    prev &&
    prev.linePos === target.linePos &&
    prev.x === target.x &&
    prev.y === target.y &&
    prev.noop === target.noop
  ) {
    return; // nothing the user can see changed; skip the transaction
  }
  view.dispatch({ effects: setDragState.of({ source: state.source, target }) });
}

/// Hide the indicator but keep the captured source range, so a drag
/// that leaves and re-enters the editor re-arms on the next dragover.
/// Called on dragleave out of the editor.
/// The source range of a move this view started and still holds, or
/// null. Both checks a drop needs, in one value: only the view that
/// armed the drag has this state, and it clears on any document change,
/// so offsets the document has outrun are gone with it.
export function imageDragSource(
  view: EditorView,
): { from: number; to: number } | null {
  return view.state.field(dragField, false)?.source ?? null;
}

export function hideImageDropTarget(view: EditorView): void {
  const state = view.state.field(dragField, false);
  if (state?.target) {
    view.dispatch({
      effects: setDragState.of({ source: state.source, target: null }),
    });
  }
}

/// Tear the indicator down completely. Called on drop / dragend.
export function clearImageDragIndicator(view: EditorView): void {
  if (view.state.field(dragField, false)) {
    view.dispatch({ effects: setDragState.of(null) });
  }
}
