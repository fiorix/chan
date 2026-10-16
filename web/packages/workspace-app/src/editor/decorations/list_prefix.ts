// Keeps the caret off a list item's hidden prefix.
//
// The block handlers hide an item's indent, marker and gap and register
// them as one atomic range, which covers caret motion, deletion and pointer
// selection. Other paths place the selection without consulting atomic
// ranges: Home on an indented item stops after the indent, a space typed at
// the line start leaves the caret after it, inside the indent it just made,
// and a restored or programmatic selection can name any offset. A caret
// strictly inside the hidden prefix has no text node of its own in the DOM,
// and the browser then inserts typed characters beside whichever neighbour
// it picks and reads the caret back in front of them. This filter moves such
// a selection to the prefix's edge: forward to the text start when the
// caret came from the line start or before (a typed space, a restore from
// the document start), back to the line start when it came from the text
// (Home), and a non-empty range grows to cover the prefix whole.
//
// The geometry is the list commands' prefix regex, confirmed against the
// syntax tree so a list-shaped line that is not an item (code in a fence, a
// lazy continuation) is left alone, as the decorations leave it.

import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state";
import { parsedListItemAt } from "../commands/list";

export interface Span {
  from: number;
  to: number;
}

/// The hidden spans the caret never rests inside on the item line at `pos`:
/// the indent, marker and gap as one span for a bullet or ordered item; for a
/// task, the prefix before the box and the gap after it (the box itself is a
/// widget the caret may stop beside). Empty when the line is not the first
/// line of a parsed list item.
export function listPrefixSpans(state: EditorState, pos: number): Span[] {
  const item = parsedListItemAt(state, pos);
  if (!item) return [];
  const { line, prefix } = item;
  const head = line.from + prefix.indent.length + prefix.marker.length + prefix.markerSpace.length;
  if (!prefix.taskBox) return [{ from: line.from, to: line.from + prefix.length }];
  const spans = [{ from: line.from, to: head }];
  const boxEnd = head + prefix.taskBox.length;
  if (prefix.taskSpace.length > 0) spans.push({ from: boxEnd, to: boxEnd + prefix.taskSpace.length });
  return spans;
}

function spanInside(spans: Span[], pos: number): Span | null {
  return spans.find((s) => pos > s.from && pos < s.to) ?? null;
}

/// Where an empty selection strictly inside `span` goes, given where its head
/// was before the transaction (in the new document's coordinates).
function edgeFor(span: Span, pos: number, before: number): number {
  if (before <= span.from) return span.to;
  if (before >= span.to) return span.from;
  return pos - span.from < span.to - pos ? span.from : span.to;
}

function moveOffPrefix(state: EditorState, range: SelectionRange, before: number): SelectionRange | null {
  if (range.empty) {
    const span = spanInside(listPrefixSpans(state, range.head), range.head);
    if (!span) return null;
    return EditorSelection.cursor(edgeFor(span, range.head, before));
  }
  const fromSpan = spanInside(listPrefixSpans(state, range.from), range.from);
  const toSpan = spanInside(listPrefixSpans(state, range.to), range.to);
  if (!fromSpan && !toSpan) return null;
  const from = fromSpan ? fromSpan.from : range.from;
  const to = toSpan ? toSpan.to : range.to;
  return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
}

function filter(tr: Transaction) {
  if (!tr.selection && !tr.docChanged) return tr;
  const sel = tr.newSelection;
  if (sel.ranges.length !== 1) return tr;
  const before = tr.changes.mapPos(tr.startState.selection.main.head, -1);
  const moved = moveOffPrefix(tr.state, sel.main, before);
  if (!moved) return tr;
  return [tr, { selection: EditorSelection.create([moved]), sequential: true }];
}

export function listPrefixCaret(): Extension {
  return EditorState.transactionFilter.of(filter);
}
