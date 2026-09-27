// Block-level decoration handlers.
//
// Per design.md spec #4 (block prefixes use line-intersect): the
// blockquote `>` and HR text both reveal/hide based on whether the
// caret line touches them, not whether the selection intersects the
// token range. Heading prefix uses the same rule (handled in
// headings.ts).
//
// What we cover here:
//   - Blockquote: line decoration on every quoted line so CSS can
//     paint a left border + indent. Quote markers stay visible (per
//     Obsidian convention - the `>` IS the visual cue that the line
//     is quoted; hiding it removes meaning).
//   - HorizontalRule: leave source text visible. Many notes use
//     `---` as an authoring separator, and replacing it with a
//     rendered rule makes the markdown harder to edit.
//   - FencedCode: per-line decoration distinguishing opener row,
//     content rows, closer row, plus a mark for the language info
//     (CodeInfo). No hide - the fences stay visible (we want the
//     user to see the block structure as they edit).
//   - Task (GFM task-list item, bullet or ordered): TaskMarker `[ ]` /
//     `[x]` is replaced by the CheckboxWidget from widgets/checkbox.ts.
//     The replace is boundary-inclusive - clicking the box edits the
//     source.
//   - BulletList: `*` / `+` markers are replaced by depth glyphs; `-`
//     markers stay literal but use the shared marker column. Nested
//     list rows get an extra visual indent without changing source.
//   - OrderedList: markers (`1.` / `2)` / etc.) stay literal but use
//     the shared marker column; nested rows get the same visual indent
//     as bullets.

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { TokenContext, TokenHandler } from "./walker";
import { CheckboxWidget } from "../widgets/checkbox";
import { copyTextToClipboard } from "../../state/store.svelte";

/// Floating badge anchored at the top-right of a fenced-code block.
/// Shows the language label (from the ```lang opener) and a copy
/// button that lifts the block's body text into the clipboard.
///
/// Widget is rendered ONCE per block at the end of the opener line;
/// the surrounding line has `position: relative` so the badge's
/// `position: absolute` resolves against it. The badge therefore
/// sits at the top-right of the visible block (the opener line is
/// the topmost row of the block in the rendered flow).
class FenceBadgeWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }

  eq(other: FenceBadgeWidget): boolean {
    return this.lang === other.lang && this.code === other.code;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-fence-badge";
    wrap.contentEditable = "false";
    if (this.lang) {
      const lang = document.createElement("span");
      lang.className = "cm-md-fence-badge-lang";
      lang.textContent = this.lang;
      wrap.append(lang);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-md-fence-badge-copy";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", "Copy code");
    btn.append(makeCopyIcon());
    btn.addEventListener("mousedown", (e) => {
      // Prevent CM6 from absorbing the click into its selection
      // handling (which would steal focus + collapse the caret).
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void copyTextToClipboard(this.code, {
        onSuccess: () => flashCopied(btn),
        onError: () => flashCopied(btn, "fail"),
      });
    });
    wrap.append(btn);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
function makeCopyIcon(): SVGElement {
  // Lucide `copy` icon (2 stacked rectangles). Stroke = currentColor
  // so the glyph follows the badge's text colour.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "14");
  rect.setAttribute("height", "14");
  rect.setAttribute("x", "8");
  rect.setAttribute("y", "8");
  rect.setAttribute("rx", "2");
  rect.setAttribute("ry", "2");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  );
  svg.append(rect, path);
  return svg;
}

function flashCopied(btn: HTMLButtonElement, kind: "ok" | "fail" = "ok"): void {
  btn.classList.add(kind === "ok" ? "copied" : "copy-failed");
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.classList.remove("copy-failed");
  }, 900);
}

const LINE_QUOTE = Decoration.line({ attributes: { class: "cm-md-quote" } });
const LINE_FENCE_OPENER = Decoration.line({
  attributes: { class: "cm-md-fence-opener" },
});
const LINE_FENCE_CLOSER = Decoration.line({
  attributes: { class: "cm-md-fence-closer" },
});
const LINE_CODE_BLOCK = Decoration.line({
  attributes: { class: "cm-md-code-block" },
});
const MARK_FENCE_INFO = Decoration.mark({
  attributes: { class: "cm-md-fence-info" },
});
const LINE_FRONTMATTER = Decoration.line({
  attributes: { class: "cm-md-frontmatter" },
});
const HIDE = Decoration.replace({});

const handleBlockquote: TokenHandler = (ctx) => {
  // Walk every line within the blockquote's range and emit the line
  // decoration. Blockquote can wrap multiple paragraphs; the line
  // decoration covers the visible run.
  const startLine = ctx.state.doc.lineAt(ctx.node.from).number;
  const endLine = ctx.state.doc.lineAt(
    Math.min(ctx.node.to, ctx.state.doc.length),
  ).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = ctx.state.doc.line(n);
    ctx.push(LINE_QUOTE, line.from, line.from);
  }
};

const handleHorizontalRule: TokenHandler = (ctx) => {
  void ctx;
};

const handleFencedCode: TokenHandler = (ctx) => {
  const cursor = ctx.node.node.cursor();
  if (!cursor.firstChild()) return;
  // Find opener CodeMark (first CodeMark child), closer CodeMark
  // (last CodeMark child), and CodeInfo (optional, immediately
  // after the opener).
  let openMarkFrom = -1;
  let openMarkTo = -1;
  let closeMarkFrom = -1;
  let closeMarkTo = -1;
  let infoFrom = -1;
  let infoTo = -1;
  do {
    if (cursor.name === "CodeMark") {
      if (openMarkFrom === -1) {
        openMarkFrom = cursor.from;
        openMarkTo = cursor.to;
      }
      closeMarkFrom = cursor.from;
      closeMarkTo = cursor.to;
    } else if (cursor.name === "CodeInfo") {
      infoFrom = cursor.from;
      infoTo = cursor.to;
    }
  } while (cursor.nextSibling());
  if (openMarkFrom === -1) return;

  const openLineObj = ctx.state.doc.lineAt(openMarkFrom);
  const closeLineObj = ctx.state.doc.lineAt(closeMarkFrom);
  const openLine = openLineObj.number;
  const closeLine = closeLineObj.number;
  const blockEndLine = ctx.state.doc.lineAt(
    Math.min(ctx.node.to, ctx.state.doc.length),
  ).number;
  // The closer fence may sit OUTSIDE the FencedCode's syntactic
  // range when the parser is recovering from a missing fence; clamp
  // to be safe.
  const lastLine = Math.max(closeLine, blockEndLine);
  // For an unclosed fence @lezer/markdown emits a single CodeMark
  // (the opener) and stretches the FencedCode node to doc end.
  // We detect that here so we can (a) keep the opener visible
  // while the caret sits anywhere in the block, even on body lines
  // BELOW the opener - without this, the markers hide and the user
  // has no signal they're typing inside an unclosed code block;
  // (b) drop a ghost ` ``` ` placeholder on the line past the last
  // body line so the missing closer is visually obvious.
  const isUnclosed = closeMarkFrom === openMarkFrom;

  // Show the fence verbatim (backticks + lang inline) whenever the
  // caret is ANYWHERE inside the block - not just on the opener /
  // closer rows. For closed fences the opener-to-closer line span
  // covers everything; for unclosed fences the closer line equals
  // the opener line, so we must use the FencedCode node's full
  // extent instead, otherwise the opener marker hides as soon as
  // the caret leaves line 1 and the user has no visual signal
  // they're still inside a code block.
  const blockEnd = Math.max(closeLineObj.to, ctx.node.to);
  const caretInBlock = ctx.lineIntersect(openLineObj.from, blockEnd);
  if (!caretInBlock) {
    if (openMarkFrom < openMarkTo) {
      ctx.push(HIDE, openMarkFrom, openMarkTo);
    }
    // The lang text rides into the floating badge; hide its inline
    // copy too so the opener row reads as an empty bar with the
    // badge floating at the right edge.
    if (infoFrom !== -1 && infoTo !== -1 && infoFrom < infoTo) {
      ctx.push(HIDE, infoFrom, infoTo);
    }
    if (
      closeMarkFrom !== openMarkFrom &&
      closeMarkFrom < closeMarkTo
    ) {
      ctx.push(HIDE, closeMarkFrom, closeMarkTo);
    }
  } else if (infoFrom !== -1 && infoTo !== -1 && infoFrom < infoTo) {
    // Caret IS in the block: keep the lang readable inline with
    // the link-style underline so the user can edit it.
    ctx.push(MARK_FENCE_INFO, infoFrom, infoTo);
  }

  // Compute the inner block text once for the copy button.
  // Range: from start of first content line to end of last content
  // line. If the block has no content lines (opener+closer adjacent
  // or unclosed), the slice degenerates to "".
  let codeText = "";
  if (closeLine > openLine + 1) {
    const firstContent = ctx.state.doc.line(openLine + 1);
    const lastContent = ctx.state.doc.line(closeLine - 1);
    codeText = ctx.state.doc.sliceString(firstContent.from, lastContent.to);
  } else if (closeLine === openLine && lastLine > openLine) {
    // Unclosed block: everything after the opener line up to lastLine.
    const firstContent = ctx.state.doc.line(openLine + 1);
    const lastContent = ctx.state.doc.line(lastLine);
    codeText = ctx.state.doc.sliceString(firstContent.from, lastContent.to);
  }
  const langText = infoFrom !== -1 ? ctx.state.doc.sliceString(infoFrom, infoTo) : "";

  for (let n = openLine; n <= lastLine; n++) {
    const line = ctx.state.doc.line(n);
    let deco;
    if (n === openLine) deco = LINE_FENCE_OPENER;
    else if (n === closeLine && closeLine !== openLine) deco = LINE_FENCE_CLOSER;
    else deco = LINE_CODE_BLOCK;
    ctx.push(deco, line.from, line.from);
  }

  // Floating badge anchored on the opener line. Placed at the END
  // of the line so an arrow-right that lands at line.to still sees
  // the user's text content (the badge is past line.to). Position:
  // absolute inside the .cm-md-fence-opener row pins it visually
  // to the top-right of the block.
  const badge = Decoration.widget({
    widget: new FenceBadgeWidget(langText, codeText),
    side: 1,
  });
  ctx.push(badge, openLineObj.to, openLineObj.to);

  // Ghost closer for unclosed fences. Drops a dimmed ` ``` ` widget
  // at the end of the last body line so the user can see the
  // block isn't closed. Without it, an unclosed fence reads as
  // "regular text inside a slightly-shaded slab" and traps the
  // caret silently - typed content keeps extending the fence with
  // no visible cue.
  if (isUnclosed) {
    const lastLineObj = ctx.state.doc.line(lastLine);
    const ghost = Decoration.widget({
      widget: new GhostCloserWidget(),
      side: 1,
    });
    ctx.push(ghost, lastLineObj.to, lastLineObj.to);
  }
};

/// Dimmed inline placeholder for an unclosed code fence. Renders
/// as a faint `\`\`\`` chip at the end of the fence's last body
/// line so the user can see the block lacks a closer. Click
/// inserts a real closer on a fresh line below.
class GhostCloserWidget extends WidgetType {
  eq(_other: GhostCloserWidget): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-fence-ghost-closer";
    wrap.contentEditable = "false";
    wrap.title = "Unclosed code block - click to add the closing ```";
    wrap.textContent = "```";
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(wrap);
      const line = view.state.doc.lineAt(pos);
      const insert = line.text.length === 0 ? "```\n" : "\n```\n";
      const at = line.to;
      view.dispatch({
        changes: { from: at, to: at, insert },
        selection: { anchor: at + insert.length },
      });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    // Let our explicit mousedown above run; CM6's default handling
    // would otherwise eat the click into selection placement.
    return false;
  }
}

const handleTask: TokenHandler = (ctx) => {
  // A GFM task list item: `[-*+] [ ] text`, or ordered, `1. [ ] text` /
  // `1) [ ] text`. lezer-markdown emits a Task block-level node with a
  // TaskMarker child covering exactly `[ ]` / `[x]` / `[X]` (3 chars). We hide
  // a bullet marker AND the leading indent, render the checkbox in the shared
  // list marker column, and tag the line so the same `.cm-md-list-hang` rule
  // that handles plain lists gives it a depth-driven indent and a hanging
  // indent (wrapped text under the item). An ordered marker stays in front of
  // the checkbox: the ordered list's own decorations render it and hide the
  // indent before it and the gap after it, and a hide over the whole prefix
  // here would overlap it and swallow the marker of an indented item.
  const line = ctx.state.doc.lineAt(ctx.node.from);
  const prefix = /^([ \t]*)([-*+]|\d+[.)])[ \t]+/.exec(line.text);
  if (!prefix) return;
  const ordered = /\d/.test(prefix[2]!);
  if (!ordered) ctx.push(HIDE, line.from, line.from + prefix[0].length);
  const cursor = ctx.node.node.cursor();
  if (!cursor.firstChild()) return;
  do {
    if (cursor.name === "TaskMarker") {
      const text = ctx.state.doc.sliceString(cursor.from, cursor.to);
      if (text.length !== 3) return;
      const checked = text === "[x]" || text === "[X]";
      ctx.push(
        Decoration.replace({ widget: new CheckboxWidget(checked) }),
        cursor.from,
        cursor.to,
      );
      // Hide the whitespace between the checkbox and the item text so the text
      // sits at the fixed marker column the checkbox margin defines.
      const gap =
        ctx.state.doc.sliceString(cursor.to, line.to).match(/^[ \t]+/)?.[0]
          .length ?? 0;
      if (gap > 0) ctx.push(HIDE, cursor.to, cursor.to + gap);
      break;
    }
  } while (cursor.nextSibling());
  // Depth-driven indent + hanging indent, matching plain list items.
  let li: import("@lezer/common").SyntaxNode | null = ctx.node.node.parent;
  while (li && li.name !== "ListItem") li = li.parent;
  ctx.push(
    Decoration.line({
      attributes: {
        class: "cm-md-list-hang",
        style: `--cm-md-list-level: ${li ? listItemDepth(li) : 0}`,
      },
    }),
    line.from,
    line.from,
  );
};

const handleBulletList: TokenHandler = (ctx) => {
  decorateBulletList(ctx, ctx.node.node);
};

/// Google-Docs depth glyphs for `*` / `+` lists, by nesting depth
/// (depth % 3): level 1 = filled disc, level 2 = open circle, level 3 =
/// filled square, then the cycle repeats.
const BULLET_GLYPH_CHARS = ["●", "○", "■"]; // ● ○ ■
const BULLET_GLYPH_CLASSES = [
  "cm-md-ul-disc",
  "cm-md-ul-circle",
  "cm-md-ul-square",
];

/// The `*` / `+` source marker is REPLACED by this widget, which renders
/// the depth glyph as a REAL inline character (real width, real
/// position). That is the load-bearing change behind the bullet
/// cursor/click cleanup: the earlier rendering kept the source char but
/// collapsed it to font-size:0 and drew the glyph in a CSS ::before, so
/// the visible glyph was DECOUPLED from the source position - click and
/// caret coordinates mapped into the marker prefix and needed a pile of
/// snap logic to compensate. A replace-widget glyph behaves like the
/// hyphen `-` and ordered `1.` markers (which are real text): default
/// CodeMirror cursor / click / arrow motion just works, no snap. The
/// DOCUMENT is untouched (the replace is render-only); round-trip still
/// writes the literal `*` / `+`.
class BulletGlyphWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletGlyphWidget): boolean {
    return this.depth % 3 === other.depth % 3;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    const i = this.depth % BULLET_GLYPH_CHARS.length;
    span.className = `cm-md-list-marker cm-md-ul-marker cm-md-ul-glyph ${BULLET_GLYPH_CLASSES[i]}`;
    span.textContent = BULLET_GLYPH_CHARS[i];
    return span;
  }

  ignoreEvent(): boolean {
    // Let CodeMirror handle clicks on the glyph so the caret lands at the
    // marker boundary natively (no custom handler; the glyph is a passive
    // marker, not an interactive control like the task checkbox).
    return false;
  }
}

/// Renders a list marker's LITERAL text (`-`, `1.`, `2)`, ...) as a replace
/// widget instead of a `Decoration.mark` class on the source text. The visible
/// result is identical to the raw marker, but it exists so the hyphen and
/// ordered markers use the SAME replace-widget mechanism as the `*` / `+` glyph.
///
/// This is load-bearing on chan-desktop's WKWebView: a `Decoration.mark` (a
/// class added to existing text) does not force WKWebView to repaint the line
/// when the list decoration first applies, so typing `- ` or `1. ` left the
/// item un-flowed (no hanging indent) until an unrelated event (scroll, click,
/// another keystroke) forced a repaint - the "sporadic list mode" the host hit.
/// A replace widget swaps a real DOM node in, which forces the line to
/// re-layout and applies the hanging-indent line decoration with it, exactly as
/// the `*` / `+` glyph already does. Blink repaints either way, so this is
/// invisible in Chrome. The document is untouched (render-only; round-trip
/// still writes the literal marker), and the widget carries the marker classes
/// so the marker column geometry is unchanged.
class LiteralMarkerWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super();
  }

  eq(other: LiteralMarkerWidget): boolean {
    return this.text === other.text && this.cls === other.cls;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const HYPHEN_CLASS = "cm-md-list-marker cm-md-ul-marker cm-md-ul-hyphen";
const ORDERED_CLASS = "cm-md-list-marker cm-md-ol-marker";

/// Nesting depth of this ListItem: the count of ancestor ListItems
/// above it (0 = top-level). Drives the Google-Docs glyph cycle
/// (depth % 3). Walks the syntax ancestry rather than the indent so it
/// tracks the actual list structure (a `*` one space deeper is still
/// top-level until it nests under a parent item).
function listItemDepth(item: import("@lezer/common").SyntaxNode): number {
  let depth = 0;
  let cur = item.parent;
  while (cur) {
    if (cur.name === "ListItem") depth++;
    cur = cur.parent;
  }
  return depth;
}

/// Zero-width replace that hides the source whitespace between a list marker
/// and the item text, so the text starts at exactly the fixed marker column.
const HIDE_GAP = Decoration.replace({});

/// Indent + hanging indent for a list item, at any depth. The marker renders
/// in a fixed-width column (marker width + gap); source whitespace that would
/// otherwise offset the text off that column is hidden (render-only, the
/// document keeps it) so the geometry is exact and independent of how the
/// source was indented:
///   - leading indent before the marker -> hidden; nesting is instead driven
///     by the item's syntactic DEPTH via the `.cm-md-list-hang` CSS rule (one
///     marker column per level, so a nested marker sits under its parent text).
///   - whitespace between the marker and the text -> hidden, so the text starts
///     at exactly the marker column and wrapped continuation lines hang on it.
function decorateListHang(
  ctx: TokenContext,
  item: import("@lezer/common").SyntaxNode,
  markFrom: number,
  markTo: number,
): void {
  const line = ctx.state.doc.lineAt(item.from);
  if (markFrom > line.from) ctx.push(HIDE_GAP, line.from, markFrom);
  const gap =
    ctx.state.doc.sliceString(markTo, line.to).match(/^[ \t]+/)?.[0].length ?? 0;
  if (gap > 0) ctx.push(HIDE_GAP, markTo, markTo + gap);
  ctx.push(
    Decoration.line({
      attributes: {
        class: "cm-md-list-hang",
        style: `--cm-md-list-level: ${listItemDepth(item)}`,
      },
    }),
    line.from,
    line.from,
  );
}

/// Decoration for a bullet ListItem's marker. Hyphen (`-`) renders its literal
/// dash through a replace widget (see LiteralMarkerWidget for the WKWebView
/// repaint rationale); `*` / `+` are REPLACED by a real-width depth-glyph widget
/// (disc / circle / square, depth % 3).
function bulletMarkerDecoration(markerChar: string, depth: number): Decoration {
  if (markerChar === "-") {
    return Decoration.replace({
      widget: new LiteralMarkerWidget("-", HYPHEN_CLASS),
    });
  }
  return Decoration.replace({ widget: new BulletGlyphWidget(depth) });
}

function decorateBulletList(
  ctx: TokenContext,
  list: import("@lezer/common").SyntaxNode,
): void {
  const cursor = list.cursor();
  if (!cursor.firstChild()) return;
  do {
    if (cursor.name !== "ListItem") continue;
    const item = cursor.node;
    const sub = item.cursor();
    let markFrom = -1;
    let markTo = -1;
    let hasTask = false;
    if (sub.firstChild()) {
      do {
        if (sub.name === "ListMark") {
          markFrom = sub.from;
          markTo = sub.to;
        } else if (sub.name === "Task") {
          hasTask = true;
        }
      } while (sub.nextSibling());
    }
    if (!hasTask && markFrom !== -1 && markTo !== -1) {
      const markerChar = ctx.state.doc.sliceString(markFrom, markTo);
      ctx.push(
        bulletMarkerDecoration(markerChar, listItemDepth(item)),
        markFrom,
        markTo,
      );
      decorateListHang(ctx, item, markFrom, markTo);
    }
  } while (cursor.nextSibling());
}

function decorateListIndents(
  ctx: TokenContext,
  list: import("@lezer/common").SyntaxNode,
): void {
  const cursor = list.cursor();
  if (!cursor.firstChild()) return;
  do {
    if (cursor.name !== "ListItem") continue;
    const item = cursor.node;
    const sub = item.cursor();
    if (!sub.firstChild()) continue;
    do {
      if (sub.name === "ListMark") {
        // Render the literal ordered marker (`1.`, `2)`, ...) through a replace
        // widget for the same WKWebView repaint reason as the hyphen (see
        // LiteralMarkerWidget); the visible marker is unchanged.
        const markerText = ctx.state.doc.sliceString(sub.from, sub.to);
        ctx.push(
          Decoration.replace({
            widget: new LiteralMarkerWidget(markerText, ORDERED_CLASS),
          }),
          sub.from,
          sub.to,
        );
        decorateListHang(ctx, item, sub.from, sub.to);
        break;
      }
    } while (sub.nextSibling());
  } while (cursor.nextSibling());
}

const handleOrderedList: TokenHandler = (ctx) => {
  decorateListIndents(ctx, ctx.node.node);
};

const handleFrontmatter: TokenHandler = (ctx) => {
  // Dim every line in the frontmatter range with a line decoration.
  // The Frontmatter node from markdown/frontmatter.ts covers the
  // opening `---`, the YAML body, and the closing `---`.
  const startLine = ctx.state.doc.lineAt(ctx.node.from).number;
  const endLine = ctx.state.doc.lineAt(
    Math.min(ctx.node.to, ctx.state.doc.length),
  ).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = ctx.state.doc.line(n);
    ctx.push(LINE_FRONTMATTER, line.from, line.from);
  }
};

export const blockHandlers = {
  Blockquote: handleBlockquote,
  HorizontalRule: handleHorizontalRule,
  FencedCode: handleFencedCode,
  BulletList: handleBulletList,
  OrderedList: handleOrderedList,
  Task: handleTask,
  Frontmatter: handleFrontmatter,
};
