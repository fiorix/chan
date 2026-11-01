// ATX heading handlers.
//
// Per design.md spec #4 (block prefixes use line-intersect, not
// selection-intersect): the `# ` prefix is hidden unless the caret line
// intersects the heading's line. This avoids the flicker that pure
// selection-intersect would produce when the caret crosses the prefix
// mid-line edit.
//
// Visual rendering uses a `Decoration.line` with a level-specific class
// (`cm-md-h1`...`cm-md-h6`). CSS rules for these classes set
// font-size / weight per heading level.
//
// HeaderMark in lezer-markdown covers ONLY the `#` characters; the
// trailing space is plain text. We extend the hide range to include the
// space (and any following whitespace) so the heading content lines up
// flush left when collapsed.

import { Decoration } from "@codemirror/view";
import type { TokenContext, TokenHandler } from "./walker";

const HIDE = Decoration.replace({});

const HEADING_LINE: Record<number, Decoration> = {
  1: Decoration.line({ attributes: { class: "cm-md-h1" } }),
  2: Decoration.line({ attributes: { class: "cm-md-h2" } }),
  3: Decoration.line({ attributes: { class: "cm-md-h3" } }),
  4: Decoration.line({ attributes: { class: "cm-md-h4" } }),
  5: Decoration.line({ attributes: { class: "cm-md-h5" } }),
  6: Decoration.line({ attributes: { class: "cm-md-h6" } }),
};

function makeHeadingHandler(level: number): TokenHandler {
  const lineDeco = HEADING_LINE[level]!;
  return (ctx: TokenContext) => {
    for (let parent = ctx.node.node.parent; parent; parent = parent.parent) {
      if (parent.name === "ListItem" || parent.name === "Blockquote") return;
    }
    const line = ctx.state.doc.lineAt(ctx.node.from);
    // Find the HeaderMark child (always first per CommonMark) and the
    // run of whitespace immediately following it.
    const cursor = ctx.node.node.cursor();
    if (!cursor.firstChild() || cursor.name !== "HeaderMark") return;
    if (!ctx.state.doc.sliceString(cursor.to, ctx.node.to).trim()) return;
    // Line decoration: zero-width at line start, applies to whole line.
    ctx.push(lineDeco, line.from, line.from);
    const markFrom = cursor.from;
    let hideTo = cursor.to;
    // Eat trailing whitespace so the visible content has no leading
    // space after the prefix collapses.
    while (
      hideTo < line.to &&
      ctx.state.doc.sliceString(hideTo, hideTo + 1) === " "
    ) {
      hideTo++;
    }
    if (ctx.lineIntersect(markFrom, hideTo)) return;
    if (markFrom < hideTo) ctx.push(HIDE, markFrom, hideTo);
  };
}

export const headingHandlers = {
  ATXHeading1: makeHeadingHandler(1),
  ATXHeading2: makeHeadingHandler(2),
  ATXHeading3: makeHeadingHandler(3),
  ATXHeading4: makeHeadingHandler(4),
  ATXHeading5: makeHeadingHandler(5),
  ATXHeading6: makeHeadingHandler(6),
};
