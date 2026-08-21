// List-editing keybinds for the WYSIWYG editor.
//
// All commands operate on the markdown source via regex on the
// current line. We do NOT consult the syntax tree: the user's intent
// while typing is "I'm on a line that LOOKS like a list item", which
// the prefix regex captures faithfully even when @lezer/markdown
// hasn't reparsed yet (e.g. the line above just changed).
//
// The matchers here are intentionally permissive about the marker
// character. Bullet lists accept `-`, `*`, `+`. Ordered lists accept
// any run of digits followed by `.` or `)`. Task lists are detected
// as a bullet item whose content starts with `[ ]` / `[x]` / `[X]`.

import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { enclosingFence } from "./format";

/// Anchored at line start. Captures:
///   1: leading whitespace (indent)
///   2: marker (`-` / `*` / `+` / `123.` / `123)`)
///   3: trailing whitespace after the marker (always present per CommonMark)
///   4: optional task box (`[ ]` / `[x]` / `[X]`)
///   5: trailing whitespace after the task box
const LIST_PREFIX_RE =
  /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\])?([ \t]*)/;

interface ListPrefix {
  indent: string;
  marker: string;
  markerSpace: string;
  taskBox: string | null;
  taskSpace: string;
  /// Length of the full prefix in chars (indent + marker + spaces +
  /// optional task box + trailing spaces).
  length: number;
  /// True when marker is a digit run.
  ordered: boolean;
  /// Parsed digit value when `ordered`, else null.
  number: number | null;
}

export function parseListPrefix(text: string): ListPrefix | null {
  const m = LIST_PREFIX_RE.exec(text);
  if (!m) return null;
  const [whole, indent, marker, markerSpace, taskBox, taskSpace] = m;
  const ordered = /^\d/.test(marker);
  return {
    indent,
    marker,
    markerSpace,
    taskBox: taskBox ?? null,
    taskSpace: taskSpace ?? "",
    length: whole.length,
    ordered,
    number: ordered ? parseInt(marker, 10) : null,
  };
}

/// Build the next marker for the same list. Bullets keep their char;
/// ordered lists increment the number and reuse the original
/// separator (`.` or `)`); task lists start fresh as `[ ]` regardless
/// of the source line's checked state.
function nextPrefix(prev: ListPrefix): string {
  let marker = prev.marker;
  if (prev.ordered && prev.number !== null) {
    const sep = prev.marker.endsWith(")") ? ")" : ".";
    marker = `${prev.number + 1}${sep}`;
  }
  const task = prev.taskBox ? `[ ]${prev.taskSpace || " "}` : "";
  return `${prev.indent}${marker}${prev.markerSpace}${task}`;
}

/// Enter on a list line.
///   - Empty item (no content after the prefix) at any caret position
///     on that line → strip the prefix entirely. This is how the user
///     exits the list: hit Enter on a blank bullet.
///   - Non-empty item, caret at or past the end of the prefix → split:
///     the text after the caret becomes the next item (a fresh marker
///     on the next line, caret after it). At end of line that is a
///     plain new item; mid-item it is how a long item is broken into
///     several (caret after a word, Enter), and the split swallows the
///     whitespace around the caret so neither half keeps a stray gap.
///   - Caret inside the prefix (the indent, the marker, a task box) →
///     fall through (default newline), so Enter ahead of an item still
///     just moves the item down a line.
export function continueListOnEnter(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  const prefix = parseListPrefix(line.text);
  if (!prefix) return false;
  // A list-shaped line inside a fenced code block (`- name:` in YAML, a
  // numbered shell snippet) is code, not a list: leave Enter to the default
  // newline so the block never grows bullets or renumbers itself.
  if (enclosingFence(view.state, sel.head)) return false;
  const content = line.text.slice(prefix.length);
  if (content.length === 0) {
    // Blank bullet - exit the list. Replace the whole line with
    // empty text and drop the caret at line.from.
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
    });
    return true;
  }
  const prefixEnd = line.from + prefix.length;
  if (sel.head < prefixEnd) return false;
  let from = sel.head;
  let to = sel.head;
  if (sel.head < line.to) {
    // Mid-item split: the gap around the caret belongs to neither half.
    // Never eat into the prefix itself (a caret right after `- ` leaves
    // an empty item above and moves the whole content down).
    while (from > prefixEnd && /[ \t]/.test(line.text[from - 1 - line.from])) from--;
    while (to < line.to && /[ \t]/.test(line.text[to - line.from])) to++;
  }
  const insert = `\n${nextPrefix(prefix)}`;
  const changes: { from: number; to: number; insert: string }[] = [{ from, to, insert }];
  if (prefix.ordered && prefix.number !== null) {
    appendOrderedRenumber(view.state, line.number, prefix, changes);
  }
  view.dispatch({
    changes,
    selection: { anchor: from + insert.length },
  });
  return true;
}

/// Shift the ordered-list tail below `lineNumber` up by one so a freshly
/// inserted item does not duplicate the next marker (…N, N+1[new], N+1,
/// N+2… becomes …N, N+1, N+2, N+3…). The renumber edits are appended to
/// the caller's `changes` so the insert + renumber land in ONE dispatch
/// (one undo). Walks the contiguous run of same-indent ordered siblings,
/// reusing each line's own `.`/`)` separator, and steps over a SINGLE
/// blank line between items so a LOOSE (blank-separated) list renumbers
/// too. It stops at the first line that is not a same-indent ordered item
/// continuing the +1 sequence, or at two blank lines in a row (which end
/// a CommonMark list), so a deliberately non-contiguous tail, a nested
/// sublist, or a separate following list is left intact. This matches
/// @codemirror/lang-markdown's renumberList (the rich-prompt Enter path)
/// for tight and single-blank loose ordered lists; the two can still
/// diverge on exotic multi-blank / nested-block boundaries that only the
/// full parse tree resolves.
function appendOrderedRenumber(
  state: EditorState,
  lineNumber: number,
  prefix: ListPrefix,
  changes: { from: number; to: number; insert: string }[],
): void {
  let prev = prefix.number!;
  let n = lineNumber + 1;
  while (n <= state.doc.lines) {
    let line = state.doc.line(n);
    if (line.text.trim() === "") {
      // A single blank line separates the items of a loose list; step
      // over it. Two or more blanks in a row end the list (CommonMark),
      // and so does a trailing blank, so stop there.
      if (n + 1 > state.doc.lines || state.doc.line(n + 1).text.trim() === "") {
        break;
      }
      n += 1;
      line = state.doc.line(n);
    }
    const tp = parseListPrefix(line.text);
    if (!tp || !tp.ordered || tp.number === null) break;
    if (tp.indent !== prefix.indent) break;
    if (tp.number !== prev + 1) break;
    const markerStart = line.from + tp.indent.length;
    const digits = tp.marker.length - 1; // marker = digit run + 1 separator
    changes.push({
      from: markerStart,
      to: markerStart + digits,
      insert: String(prev + 2),
    });
    prev = tp.number;
    n += 1;
  }
}

/// Tab on a list line nests the item one level: the line lands exactly on the
/// content column of the nearest list line above at the same or shallower
/// indent (its previous sibling). When the selection covers multiple lines and
/// any of them is a list item, every list line in the range shifts by the same
/// delta. Returns false when no touched line is a list item so the caret falls
/// through to CM6's default; on a list line the key is ALWAYS consumed, even
/// when there is nothing to nest under, so Tab never dumps an indent character
/// into a list line.
export function indentListItem(view: EditorView): boolean {
  return shiftListLines(view, +1);
}

/// Shift-Tab outdents one level: back to the own indent of the nearest list
/// line above at a strictly shallower indent (the parent), or to column 0 when
/// no parent exists. Same line-range rule as indentListItem. Always consumed
/// on a list line (Shift-Tab must never escape the editor into surrounding
/// chrome); a top-level item stays put, since leaving a list is
/// Enter-on-an-empty-bullet, not outdent.
export function outdentListItem(view: EditorView): boolean {
  const changed = shiftListLines(view, -1);
  return changed || true;
}

/// Scan the list context ABOVE `lineNumber` for the first line `visit` accepts,
/// stepping over deeper list lines (nested subtrees between this line and its
/// sibling) and a single blank (a loose list). A non-list line or two blanks
/// in a row end the list per CommonMark, and the scan with them.
function scanListAbove(
  state: EditorState,
  lineNumber: number,
  visit: (p: ListPrefix) => number | null,
): number | null {
  let blanks = 0;
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") {
      blanks += 1;
      if (blanks >= 2) return null;
      continue;
    }
    blanks = 0;
    const p = parseListPrefix(text);
    if (!p) return null;
    const hit = visit(p);
    if (hit !== null) return hit;
  }
  return null;
}

/// One valid indent step for the list lines in the selection.
///
/// Fixed-width steps are WRONG here: markdown only has two valid columns next
/// to a sibling, the sibling band (its own indent, give or take 3 spaces) and
/// the sibling's CONTENT column (nested under it). An ordered item indented
/// into the gap between them parses as lazy paragraph continuation of the item
/// above (only `1.` may interrupt a paragraph), silently dropping its list
/// rendering, which is exactly what blind 2-space steps produced under a
/// `1. ` marker (content column 3). So:
///   - Tab targets the reference sibling's content column
///     (indent + marker + gap), nesting in one press.
///   - Shift-Tab targets the parent's own indent (column 0 with no parent).
/// The FIRST list line in the range anchors the step; every other list line
/// shifts by the same delta (clamped to its available indent) so a selected
/// subtree keeps its shape.
function shiftListLines(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  let anchor: { lineNumber: number; prefix: ListPrefix } | null = null;
  for (let n = startLine.number; n <= endLine.number; n++) {
    const prefix = parseListPrefix(state.doc.line(n).text);
    if (prefix) {
      anchor = { lineNumber: n, prefix };
      break;
    }
  }
  if (!anchor) return false;
  const cur = anchor.prefix.indent.length;
  let target: number;
  if (dir === +1) {
    const nest = scanListAbove(state, anchor.lineNumber, (p) =>
      p.indent.length <= cur
        ? p.indent.length + p.marker.length + p.markerSpace.length
        : null,
    );
    // Nothing to nest under (first item of its level), or already at the
    // reference's content column (a first child): consumed no-op.
    if (nest === null || nest <= cur) return true;
    target = nest;
  } else {
    target =
      scanListAbove(state, anchor.lineNumber, (p) =>
        p.indent.length < cur ? p.indent.length : null,
      ) ?? 0;
    if (target >= cur) return true; // already outermost
  }
  const delta = target - cur;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    if (!parseListPrefix(line.text)) continue;
    if (delta > 0) {
      changes.push({ from: line.from, to: line.from, insert: " ".repeat(delta) });
    } else {
      // Strip up to -delta leading whitespace chars. Tabs count as one char
      // each - we don't try to expand them.
      let strip = 0;
      while (strip < -delta && (line.text[strip] === " " || line.text[strip] === "\t")) {
        strip++;
      }
      if (strip > 0) {
        changes.push({ from: line.from, to: line.from + strip, insert: "" });
      }
    }
  }
  if (changes.length === 0) return true;
  view.dispatch({ changes });
  return true;
}

export function listLineAt(state: EditorState, pos: number): {
  from: number;
  to: number;
  prefix: ListPrefix;
} | null {
  const line = state.doc.lineAt(pos);
  const prefix = parseListPrefix(line.text);
  return prefix ? { from: line.from, to: line.to, prefix } : null;
}

// There is no bullet caret-snap scaffolding (clampListCaretPosition,
// listAwareArrowDown/Up, listCaretGuard, isListEolClick): `*`/`+` markers
// render as real-width glyph widgets (blocks.ts BulletGlyphWidget), not a
// zero-width source char + CSS ::before glyph, so bullet lists get
// default CodeMirror cursor / click / arrow behavior - the same path
// hyphen and ordered lists use. Snap logic would only compensate for that
// decoupling. listLineAt above stays (consumed by the image-drop handler).

export function stripUnusedInlineImageSpaceOnEnter(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (!parseListPrefix(line.text)) return false;
  // An image paste drops the caret just after the `)` (before the inserted
  // separator space), not at EOL, so accept either the `)` boundary or true
  // EOL. Deleting the trailing space lands the caret at the new EOL so the
  // next keymap entry, continueListOnEnter, continues the list instead of
  // Enter falling through to a plain newline that breaks out of it.
  if (sel.head !== line.to && sel.head !== line.to - 1) return false;
  if (!/!\[[^\]\n]*\]\([^)]+#w=\d+\)[ \t]$/.test(line.text)) return false;
  const spacePos = line.to - 1;
  view.dispatch({
    changes: { from: spacePos, to: spacePos + 1, insert: "" },
    selection: { anchor: spacePos },
  });
  return false;
}

// (listCaretGuard / isListEolClick removed - see the note above
// stripUnusedInlineImageSpaceOnEnter. Bullet markers are real-width
// glyphs now, so the click path is plain CodeMirror.)
