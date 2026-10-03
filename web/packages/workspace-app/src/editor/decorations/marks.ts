// Inline mark handlers: bold, italic, strike, code, link, autolink,
// naked URL.
//
// Each paired-mark handler (Emphasis, StrongEmphasis, Strikethrough,
// InlineCode):
//   1. Emits a `Decoration.mark` over the inner content with a class
//      that the CSS layer styles (`cm-md-bold`, `cm-md-italic`, etc.).
//   2. If the active selection does NOT intersect the OUTER mark's
//      range, emits `Decoration.replace({})` over each marker child to
//      hide the source punctuation. Outer-range intersection (not per-
//      child) so caret near *a* reveals BOTH `*` chars together - a
//      per-child rule would show `*a` then `a*` as the caret crossed.
//
// Link and Autolink apply the same outer-range test to their own
// children: an external `[label](url)` hides its LinkMarks and its
// URL, an autolink hides its angle brackets.
//
// Naked URLs: lezer-markdown's GFM Autolink emits a bare `URL` node
// for `https://x` text in paragraphs (also for emails). The URL node
// also appears as a child of `Link` and `Autolink`. We dispatch the
// URL handler to behave differently per parent:
//   - parent is Link / Image / Autolink → handled by the parent;
//     URL handler does nothing.
//   - parent is anything else (Paragraph, Heading, etc.) → naked URL,
//     apply the link mark style. No hide; the URL text IS the user-
//     visible content.

import { Decoration } from "@codemirror/view";
import { isInternalHref } from "../links";
import type { TokenContext, TokenHandler } from "./walker";

// ---- shared decorations --------------------------------------------------

const HIDE = Decoration.replace({});

const MARK_BOLD = Decoration.mark({ class: "cm-md-bold" });
const MARK_ITALIC = Decoration.mark({ class: "cm-md-italic" });
const MARK_STRIKE = Decoration.mark({ class: "cm-md-strike" });
const MARK_CODE = Decoration.mark({ class: "cm-md-code" });
const MARK_LINK_LABEL = Decoration.mark({ class: "cm-md-link" });
const MARK_LINK_URL = Decoration.mark({ class: "cm-md-link-url" });
const MARK_NAKED_URL = Decoration.mark({ class: "cm-md-link" });

// ---- helpers -------------------------------------------------------------

/// Walk the node's children and return the open (first) and close (last)
/// child boundaries. Returns null if the node has no children - a
/// well-formed Emphasis / StrongEmphasis / Strikethrough / InlineCode
/// always carries at least its opening + closing marker children, so a
/// null return means the parser saw a malformed run we should skip.
function openCloseRange(
  ctx: TokenContext,
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  const cursor = ctx.node.node.cursor();
  if (!cursor.firstChild()) return null;
  const openFrom = cursor.from;
  const openTo = cursor.to;
  let closeFrom = openFrom;
  let closeTo = openTo;
  do {
    closeFrom = cursor.from;
    closeTo = cursor.to;
  } while (cursor.nextSibling());
  return { openFrom, openTo, closeFrom, closeTo };
}

/// Standard "outer marks with markers at both ends" handler. Used for
/// Emphasis, StrongEmphasis, Strikethrough, InlineCode - all of which
/// have the same shape: open marker, content, close marker.
function handlePairedMark(contentDeco: Decoration): TokenHandler {
  return (ctx) => {
    const range = openCloseRange(ctx);
    if (!range) return;
    const { openFrom, openTo, closeFrom, closeTo } = range;
    if (openTo < closeFrom) {
      ctx.push(contentDeco, openTo, closeFrom);
    }
    const visible = ctx.selectionInRange(ctx.node.from, ctx.node.to);
    if (!visible) {
      // Hide each marker. open and close ranges must be non-empty; the
      // parser guarantees this for well-formed marks.
      if (openFrom < openTo) ctx.push(HIDE, openFrom, openTo);
      if (closeFrom < closeTo && closeFrom > openTo) {
        ctx.push(HIDE, closeFrom, closeTo);
      }
    }
  };
}

// ---- handlers ------------------------------------------------------------

const handleEmphasis = handlePairedMark(MARK_ITALIC);
const handleStrong = handlePairedMark(MARK_BOLD);
const handleStrike = handlePairedMark(MARK_STRIKE);
const handleCode = handlePairedMark(MARK_CODE);

/// Link `[label](url)` - external markdown links (a link with an
/// internal path is left to the wikilink widget, which renders it as
/// an atomic pill). Children layout per lezer-markdown:
///   LinkMark `[`
///   <inline content for label> (zero or more nodes)
///   LinkMark `]`
///   LinkMark `(`
///   URL
///   LinkMark `)`
///
/// We collect all LinkMark + URL child positions, decide visibility by
/// outer-range intersection, then:
///   - mark the label range (between the first `]` and the previous
///     `[`) with link style
///   - hide each LinkMark unless visible
///   - hide the URL unless visible (when visible it gets the "url"
///     dimmed style instead), except under an empty label, where the
///     URL stays and takes the link style
function handleLink(ctx: TokenContext): void {
  const cursor = ctx.node.node.cursor();
  if (!cursor.firstChild()) return;
  type Range = { from: number; to: number };
  const linkMarks: Range[] = [];
  let urlRange: Range | null = null;
  do {
    if (cursor.name === "LinkMark") {
      linkMarks.push({ from: cursor.from, to: cursor.to });
    } else if (cursor.name === "URL") {
      urlRange = { from: cursor.from, to: cursor.to };
    }
  } while (cursor.nextSibling());
  if (linkMarks.length < 4 || !urlRange) {
    // Reference-style links and other non-`[label](url)` shapes are not
    // decorated here.
    return;
  }
  // The wikilink walker owns internal links, including paths it cannot
  // place in the workspace, which it renders as broken pills.
  const url = ctx.state.doc.sliceString(urlRange.from, urlRange.to);
  if (isInternalHref(url)) return;
  // Label sits between linkMarks[0].to and linkMarks[1].from.
  const labelFrom = linkMarks[0]!.to;
  const labelTo = linkMarks[1]!.from;
  const labelEmpty = labelFrom >= labelTo;
  if (!labelEmpty) {
    ctx.push(MARK_LINK_LABEL, labelFrom, labelTo);
  }
  const visible = ctx.selectionInRange(ctx.node.from, ctx.node.to);
  if (visible) {
    // URL stays visible-but-dimmed via the "url" mark class.
    ctx.push(MARK_LINK_URL, urlRange.from, urlRange.to);
  } else {
    for (const m of linkMarks) {
      if (m.from < m.to) ctx.push(HIDE, m.from, m.to);
    }
    if (labelEmpty && urlRange.from < urlRange.to) {
      // Empty label (`[](url)`): fall back to showing the URL as the
      // link text so the reader sees something instead of a zero-
      // width gap. The brackets + parens stay hidden via the loop
      // above so the URL reads as the link's surface label.
      ctx.push(MARK_LINK_LABEL, urlRange.from, urlRange.to);
    } else if (urlRange.from < urlRange.to) {
      ctx.push(HIDE, urlRange.from, urlRange.to);
    }
  }
}

/// Bare URL handler. Fires for both naked URLs in paragraphs and the
/// URL nodes inside Links / Images / Autolinks. The latter are owned
/// by their parent's handler - detect parent context and skip.
function handleUrl(ctx: TokenContext): void {
  const parent = ctx.node.node.parent;
  if (!parent) return;
  switch (parent.name) {
    case "Link":
    case "Image":
    case "Autolink":
      return; // parent handler owns it
    default:
      ctx.push(MARK_NAKED_URL, ctx.node.from, ctx.node.to);
  }
}

/// `<https://x>` autolink: hide the angle brackets unless visible,
/// style the URL as a link.
function handleAutolink(ctx: TokenContext): void {
  const cursor = ctx.node.node.cursor();
  if (!cursor.firstChild()) return;
  type Range = { from: number; to: number };
  const linkMarks: Range[] = [];
  let urlRange: Range | null = null;
  do {
    if (cursor.name === "LinkMark") {
      linkMarks.push({ from: cursor.from, to: cursor.to });
    } else if (cursor.name === "URL") {
      urlRange = { from: cursor.from, to: cursor.to };
    }
  } while (cursor.nextSibling());
  if (!urlRange) return;
  ctx.push(MARK_NAKED_URL, urlRange.from, urlRange.to);
  const visible = ctx.selectionInRange(ctx.node.from, ctx.node.to);
  if (!visible) {
    for (const m of linkMarks) {
      if (m.from < m.to) ctx.push(HIDE, m.from, m.to);
    }
  }
}

// ---- exported registry ---------------------------------------------------

export const inlineMarkHandlers = {
  Emphasis: handleEmphasis,
  StrongEmphasis: handleStrong,
  Strikethrough: handleStrike,
  InlineCode: handleCode,
  Link: handleLink,
  URL: handleUrl,
  Autolink: handleAutolink,
};
