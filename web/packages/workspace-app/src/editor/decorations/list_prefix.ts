// Keeps the caret off a list item's prefix: an item's first caret position is
// the start of its text.
//
// The block handlers hide an item's indent, marker and gap and register them
// as one atomic range (a task's box sits between two such ranges), which
// covers caret motion, deletion and pointer selection but leaves the line
// start as a resting place in front of the glyph, where a typed character
// goes in front of the marker. Other paths place the selection without
// consulting atomic ranges at all: Home on an indented item stops after the
// indent, and a restored or programmatic selection can name any offset. A
// caret inside the hidden prefix has no text node of its own in the DOM, and
// the browser then types beside whichever neighbour it picks.
//
// This filter keeps every caret out of the item's region, from the line start
// to the text start, the task box included. A leftward key step from the text
// start leaves the line for the end of the line above, and stays on the
// document's first line; every other caret in the region (a click, a vertical
// landing, a restore, a typed change) goes to the text start. A range keeps
// the line start only when it takes the line whole (a triple-click, a drag or
// a selection that reaches past the line's end); otherwise its end goes to the
// text start, or, for a leftward step from it, to the end of the line above.
//
// Home and the line-start keys cannot be told from ArrowLeft by their
// transaction: from the text start of an unindented item each moves the head
// to the line start with userEvent `select`. So they are bound here, ahead of
// the default keymap, and put the caret at the text start themselves.
//
// The geometry is the list commands' prefix regex, confirmed against the
// syntax tree so a list-shaped line that is not an item (code in a fence, a
// lazy continuation) is left alone, as the decorations leave it.
//
// The tree is the parser's as far as it has reached, the one the decorations
// hide prefixes by, and a line past its end is no item yet. The parse that
// reaches more of the document arrives as a transaction with no selection and
// no change, so the filter places the selection on any transaction that
// changes the tree too: a caret that landed on a line before the parser did
// goes to the text start when the line becomes an item.

import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { parsedListItemAt } from "../commands/list";

export interface Span {
  from: number;
  to: number;
}

/// The region of the item line at `pos` where no caret rests: from the line
/// start to the start of the item's text, a task's box and the gap after it
/// included. Null when the line is not the first line of a parsed list item.
export function itemRegion(state: EditorState, pos: number): Span | null {
  const item = parsedListItemAt(state, pos);
  return item ? { from: item.line.from, to: item.line.from + item.prefix.length } : null;
}

function regionHolding(state: EditorState, pos: number): Span | null {
  const region = itemRegion(state, pos);
  return region && pos >= region.from && pos < region.to ? region : null;
}

/// Where a leftward step from `region`'s text start goes: the end of the line
/// above, or the text start itself on the document's first line.
function leftOf(region: Span): number {
  return region.from > 0 ? region.from - 1 : region.to;
}

/// True when a range from `region`'s line start to `other` takes the line
/// whole: past the line's end, or to the end of the document's last line.
function takesLine(state: EditorState, region: Span, other: number): boolean {
  const lineEnd = state.doc.lineAt(region.from).to;
  return other > lineEnd || (other === lineEnd && lineEnd === state.doc.length);
}

function placeRange(
  state: EditorState,
  range: SelectionRange,
  stepFromText: boolean,
): SelectionRange | null {
  const headRegion = regionHolding(state, range.head);
  if (range.empty) {
    if (!headRegion) return null;
    const pos = stepFromText ? leftOf(headRegion) : headRegion.to;
    // A vertical step carries its goal column through the moved caret.
    return EditorSelection.cursor(pos, range.assoc, range.bidiLevel ?? undefined, range.goalColumn);
  }
  const anchorRegion = regionHolding(state, range.anchor);
  if (!headRegion && !anchorRegion) return null;
  const anchor = anchorRegion ? endFor(state, anchorRegion, range.head) : range.anchor;
  let head = range.head;
  if (headRegion) head = stepFromText ? leftOf(headRegion) : endFor(state, headRegion, range.anchor);
  return EditorSelection.range(anchor, head);
}

/// Where a range end in `region` goes, given the range's other end: the line
/// start when the range takes the line whole, else the text start.
function endFor(state: EditorState, region: Span, other: number): number {
  return takesLine(state, region, other) ? region.from : region.to;
}

function filter(tr: Transaction) {
  if (!tr.selection && !tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) return tr;
  const sel = tr.newSelection;
  if (sel.ranges.length !== 1) return tr;
  const range = sel.main;
  // A keyboard step (not a pointer one) whose head left this item's text
  // start: ArrowLeft, a word or syntax step, Shift with each.
  const before = tr.changes.mapPos(tr.startState.selection.main.head, -1);
  const keyStep = tr.isUserEvent("select") && !tr.isUserEvent("select.pointer");
  const headRegion = regionHolding(tr.state, range.head);
  const stepFromText = keyStep && headRegion !== null && before === headRegion.to;
  const moved = placeRange(tr.state, range, stepFromText);
  if (!moved) return tr;
  return [tr, { selection: EditorSelection.create([moved]), sequential: true }];
}

/// Put the head at the text start of its item where a line-start key would
/// put it in the region. False off an item line, on a selection of more than
/// one range, and, for a visual boundary, on a wrapped item's later visual
/// line, so the default key runs there.
function toTextStart(view: EditorView, extend: boolean, visual: boolean): boolean {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  const region = itemRegion(state, range.head);
  if (!region) return false;
  if (visual && view.moveToLineBoundary(range, false).head > region.to) return false;
  view.dispatch({
    selection: extend ? EditorSelection.range(range.anchor, region.to) : EditorSelection.cursor(region.to),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/// Home and mac Cmd-ArrowLeft on an item line.
export const cursorItemLineBoundaryBackward = (view: EditorView) => toTextStart(view, false, true);
export const selectItemLineBoundaryBackward = (view: EditorView) => toTextStart(view, true, true);
/// mac Ctrl-a on an item line.
export const cursorItemLineStart = (view: EditorView) => toTextStart(view, false, false);
export const selectItemLineStart = (view: EditorView) => toTextStart(view, true, false);

const lineStartKeys = Prec.high(
  keymap.of([
    {
      key: "Home",
      run: cursorItemLineBoundaryBackward,
      shift: selectItemLineBoundaryBackward,
      preventDefault: true,
    },
    {
      mac: "Cmd-ArrowLeft",
      run: cursorItemLineBoundaryBackward,
      shift: selectItemLineBoundaryBackward,
      preventDefault: true,
    },
    { mac: "Ctrl-a", run: cursorItemLineStart, shift: selectItemLineStart, preventDefault: true },
  ]),
);

export function listPrefixCaret(): Extension {
  return [EditorState.transactionFilter.of(filter), lineStartKeys];
}
