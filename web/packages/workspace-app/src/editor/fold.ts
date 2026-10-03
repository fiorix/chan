// Heading-aware folding: a custom gutter that ONLY shows chevrons on heading
// lines and folds the section under one.
//
// Per design.md spec #9: a line is a heading iff the lezer syntax tree resolves
// it to `ATXHeading1..6`, and such a heading folds end-of-line -> start of the
// next `ATXHeading{<=n}` (or doc end). Detection reads the tree, not a regex on
// raw line text, so a `#` inside a fenced block, a tilde fence, an indented
// fence, an inline code span, or frontmatter is never mistaken for a heading.
// Indented ATX headings (up to three leading spaces, CommonMark) fold, matching
// the tree; Setext headings are out of the fold gutter.
//
// Why a custom gutter instead of `foldGutter()`: @codemirror/lang-markdown adds
// `foldNodeProp` to many block types (paragraphs, blockquotes, tables, fenced
// code, ...). The default foldGutter renders a chevron for ANY line where
// `foldable(state, ...)` returns non-null, so every paragraph would get its
// own chevron. Filtering to "headings only" via foldGutter config isn't
// possible (no per-line callback), so this module renders the gutter itself
// and folds / unfolds via foldEffect / unfoldEffect.

import {
  codeFolding,
  ensureSyntaxTree,
  foldEffect,
  foldedRanges,
  syntaxTree,
  syntaxTreeAvailable,
  unfoldEffect,
} from "@codemirror/language";
import { type EditorState, type Extension } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";

// Force the parse through this budget when the forward walk leaves the lazily
// parsed viewport (matches the decoration walker's budget).
const PARSE_BUDGET_MS = 100;

/// The heading level encoded by an `ATXHeading1..6` node name, or 0.
function atxLevel(nodeName: string): number {
  const m = /^ATXHeading([1-6])$/.exec(nodeName);
  return m ? Number(m[1]) : 0;
}

/// The fold level of a syntax node: its ATX level, or 0 for a non-heading node
/// AND for an empty heading (the marker with no text, e.g. a bare `#`, which
/// lezer parses as an ATXHeading1 but has no section to fold under).
function nodeHeadingLevel(
  state: EditorState,
  node: { name: string; from: number; to: number },
): number {
  const lvl = atxLevel(node.name);
  if (!lvl) return 0;
  return /^#{1,6}[ \t]*$/.test(state.doc.sliceString(node.from, node.to)) ? 0 : lvl;
}

/// The heading level of the line containing `pos`, or 0 when it is not a
/// heading. A heading is a non-empty `ATXHeading1..6` node beginning on the
/// line; a `#` inside code or frontmatter resolves to a non-heading node and
/// returns 0. The lazy tree is enough here: callers ask only about visible
/// lines.
export function headingLevelAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  let level = 0;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (level) return false;
      if (atxLevel(node.name) && node.from >= line.from && node.from <= line.to) {
        level = nodeHeadingLevel(state, node);
        return false;
      }
      return undefined;
    },
  });
  return level;
}

/// The fold range for the heading on the line containing `pos`: end of the
/// heading line to the start of the next `ATXHeading` at the same or a shallower
/// level, else to document end. Null when `pos` is not on a heading line, or the
/// heading is the last line with nothing to fold. The forward scan runs to end
/// of document and can leave the lazily parsed region, so it forces the parse
/// through `budget` milliseconds (a non-positive budget answers from whatever
/// is already parsed, without forcing).
///
/// "incomplete" means the parse ran out of budget before covering the document
/// AND no terminator was found in the parsed prefix: whether a terminator
/// exists is unknown, so no range can be offered. Only a COMPLETE parse with
/// no terminator proves the heading owns the rest of the document and takes
/// the doc-end fallback - an incomplete parse must never take it, because
/// that range is indistinguishable from a real last-section fold and folding
/// it would swallow sections the parse simply had not reached yet. A
/// terminator found in the parsed prefix is trustworthy either way: the
/// parsed prefix of an incremental parse is exact.
export function headingFoldRange(
  state: EditorState,
  pos: number,
  budget: number = PARSE_BUDGET_MS,
): { from: number; to: number } | "incomplete" | null {
  const line = state.doc.lineAt(pos);
  const level = headingLevelAt(state, line.from);
  if (level === 0) return null;
  const forced =
    budget > 0 ? ensureSyntaxTree(state, state.doc.length, budget) : null;
  const tree = forced ?? syntaxTree(state);
  let foldTo: number | null = null;
  tree.iterate({
    enter(node) {
      if (foldTo !== null) return false;
      if (!atxLevel(node.name)) return undefined; // non-heading: descend
      const lvl = nodeHeadingLevel(state, node); // 0 for an empty heading
      if (lvl && node.from > line.from && lvl <= level) {
        foldTo = state.doc.lineAt(node.from).from - 1;
      }
      return false; // a heading node never has a foldable heading child
    },
  });
  // A heading followed at once by one of its level or higher owns no
  // section: its range would be empty.
  if (foldTo !== null) return foldTo > line.to ? { from: line.to, to: foldTo } : null;
  if (forced === null && !syntaxTreeAvailable(state, state.doc.length)) {
    return "incomplete";
  }
  const docEnd = state.doc.length;
  if (line.to >= docEnd) return null;
  return { from: line.to, to: docEnd };
}

/// Gutter marker classes. One DOM per fold state so CM6 can reuse.
class ChevronMarker extends GutterMarker {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(other: ChevronMarker): boolean {
    return this.folded === other.folded;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-fold-chevron";
    el.dataset.folded = this.folded ? "true" : "false";
    el.textContent = this.folded ? "▸" : "▾";
    return el;
  }
}
const CHEVRON_UNFOLDED = new ChevronMarker(false);
const CHEVRON_FOLDED = new ChevronMarker(true);

/// Find the existing fold range whose start is at the end of `line`.
/// Returns null when this heading isn't currently folded.
function findHeadingFold(
  view: import("@codemirror/view").EditorView,
  line: { from: number; to: number },
): { from: number; to: number } | null {
  const folded = foldedRanges(view.state);
  let hit: { from: number; to: number } | null = null;
  folded.between(line.to, line.to, (foldFrom, foldTo) => {
    hit = { from: foldFrom, to: foldTo };
    return false;
  });
  return hit;
}

/// Whether the heading on line `number` has a section to fold: it is not
/// the last line, and the next line is not a heading of its level or
/// higher. It reads two lines, not the whole tree, since the gutter asks it
/// of every heading it paints; `headingFoldRange` has no range for either.
function hasSection(state: EditorState, number: number, level: number): boolean {
  if (number >= state.doc.lines) return false;
  const next = headingLevelAt(state, state.doc.line(number + 1).from);
  return next === 0 || next > level;
}

const headingFoldGutter = gutter({
  class: "cm-md-fold-gutter",
  lineMarker(view, blockInfo) {
    // Resolve to the actual document line: blockInfo can extend through folded
    // ranges that follow this heading, so its range spans past the heading
    // line, but `findHeadingFold` needs the exact line.to a fold starts at.
    const line = view.state.doc.lineAt(blockInfo.from);
    const level = headingLevelAt(view.state, line.from);
    if (level === 0) return null;
    if (findHeadingFold(view, { from: line.from, to: line.to })) return CHEVRON_FOLDED;
    return hasSection(view.state, line.number, level) ? CHEVRON_UNFOLDED : null;
  },
  // Re-render gutter markers whenever the fold state changes; without this the
  // chevron stays on `▾` after a click even though the fold applied (lineMarker
  // is otherwise only re-evaluated on doc / viewport changes, which folding
  // alone doesn't trigger).
  lineMarkerChange: (update) => {
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (e.is(foldEffect) || e.is(unfoldEffect)) return true;
      }
    }
    return false;
  },
  initialSpacer: () => CHEVRON_UNFOLDED,
  domEventHandlers: {
    click(view, blockInfo) {
      const line = view.state.doc.lineAt(blockInfo.from);
      if (headingLevelAt(view.state, line.from) === 0) return false;
      const existing = findHeadingFold(view, { from: line.from, to: line.to });
      if (existing) {
        view.dispatch({ effects: unfoldEffect.of(existing) });
        return true;
      }
      // "incomplete" folds nothing: better no fold on this click than a
      // doc-end fold that swallows sections the parse had not reached.
      const range = headingFoldRange(view.state, line.from);
      if (range === "incomplete" || !range || range.to <= line.to) return false;
      view.dispatch({ effects: foldEffect.of(range) });
      return true;
    },
  },
});

export function headingFold(): Extension {
  // `codeFolding()` registers the fold state field that foldEffect /
  // unfoldEffect mutate. Without it the chevron click dispatches an effect that
  // nothing listens to and the fold silently no-ops.
  return [codeFolding(), headingFoldGutter];
}
