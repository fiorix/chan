// Format commands for the StyleToolbar contract.
//
// All commands operate on the markdown SOURCE directly - no
// PM-command-object indirection. Mark toggles wrap/unwrap markers;
// block toggles add/remove line prefixes; isActive walks the syntax
// tree.
//
// Naming follows the legacy editor's contract so StyleToolbar.svelte
// works at cutover with no edits beyond importing from the new
// component.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { uiPrompt } from "../../state/store.svelte";

// Node names inside which a caret is literal code, not markdown structure, so a
// block chord (heading, quote, list) must leave the line intact rather than
// rewrite a fenced `# comment` into a heading or bullet.
const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeMark",
  "CodeInfo",
  "InlineCode",
]);

/// Whether `pos` resolves inside a code node (fenced block or inline span).
function caretInsideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

// ---- mark toggles --------------------------------------------------------

interface MarkSpec {
  name: string;
  marker: string;
  innerNode: string; // syntax node name when the mark is applied
}

const MARK_BOLD: MarkSpec = {
  name: "bold",
  marker: "**",
  innerNode: "StrongEmphasis",
};
const MARK_ITALIC: MarkSpec = {
  name: "italic",
  marker: "*",
  innerNode: "Emphasis",
};
const MARK_STRIKE: MarkSpec = {
  name: "strike",
  marker: "~~",
  innerNode: "Strikethrough",
};
const MARK_CODE: MarkSpec = {
  name: "code",
  marker: "`",
  innerNode: "InlineCode",
};

function toggleMark(view: EditorView, spec: MarkSpec): void {
  const sel = view.state.selection.main;
  const m = spec.marker;
  // Are we currently inside the mark? Walk ancestors at caret head.
  const inner = findAncestor(view, sel.head, spec.innerNode);
  if (inner) {
    // Unwrap: remove the open and close markers and keep inner content.
    // The marker positions are the first and last children of `inner`
    // (per lezer's mark layout: open EmphasisMark, content, close
    // EmphasisMark - same shape for Strong/Strike/InlineCode).
    const cursor = inner.cursor();
    if (!cursor.firstChild()) return;
    const openFrom = cursor.from;
    const openTo = cursor.to;
    let closeFrom = openFrom;
    let closeTo = openTo;
    while (cursor.nextSibling()) {
      closeFrom = cursor.from;
      closeTo = cursor.to;
    }
    // Apply close-then-open so positions remain valid.
    view.dispatch({
      changes: [
        { from: closeFrom, to: closeTo },
        { from: openFrom, to: openTo },
      ],
    });
    return;
  }
  if (sel.empty) {
    // Insert paired markers and place caret between them.
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `${m}${m}` },
      selection: { anchor: sel.from + m.length },
    });
    return;
  }
  // Wrap selection.
  const text = view.state.doc.sliceString(sel.from, sel.to);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${m}${text}${m}` },
    selection: {
      anchor: sel.from + m.length,
      head: sel.to + m.length,
    },
  });
}

export function toggleBold(view: EditorView): void {
  toggleMark(view, MARK_BOLD);
}
export function toggleItalic(view: EditorView): void {
  toggleMark(view, MARK_ITALIC);
}
export function toggleStrike(view: EditorView): void {
  toggleMark(view, MARK_STRIKE);
}
export function toggleInlineCode(view: EditorView): void {
  toggleMark(view, MARK_CODE);
}

// ---- block toggles -------------------------------------------------------

export type BlockKind = "h1" | "h2" | "h3" | "normal" | "code" | "quote";

const HEADING_PREFIX: Record<BlockKind, string | null> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  normal: null,
  code: null,
  quote: null,
};

/// Set the current block (the line containing the caret) to the given
/// kind. Strips any existing heading / quote / fence prefix first, then
/// applies the new prefix (or wraps the line in a code fence for "code").
/// "normal" strips all prefixes.
export function setBlockKind(view: EditorView, kind: BlockKind): void {
  const sel = view.state.selection.main;
  // A block chord on a line inside a fenced or inline code span would rewrite
  // literal code (a shell `# comment` into a heading); leave it untouched.
  if (caretInsideCode(view.state, sel.head)) return;
  const line = view.state.doc.lineAt(sel.head);
  // Strip leading `#`/`>` runs + the trailing space.
  let text = line.text;
  const m = /^((?:[#]+\s+)|(?:>\s+))/.exec(text);
  if (m) text = text.slice(m[0].length);
  if (kind === "h1" || kind === "h2" || kind === "h3") {
    const prefix = HEADING_PREFIX[kind]!;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `${prefix}${text}` },
    });
    return;
  }
  if (kind === "quote") {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `> ${text}` },
    });
    return;
  }
  if (kind === "code") {
    // Wrap the current line in a fenced block.
    const fenced = `\`\`\`\n${text}\n\`\`\``;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: fenced },
    });
    return;
  }
  // "normal" - strip prefixes only.
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
  });
}

/// Detect a "block selection": every line touched by the active
/// selection is fully covered. Two acceptable shapes:
///   - from === startLine.from && to === endLine.to (clean
///     full-line span, e.g. triple-click)
///   - from === startLine.from && to === endLine.from with
///     endLine.number > startLine.number (selection extends into the
///     next line's start, so the last fully-selected line is the
///     one BEFORE endLine - this is what dragging from line N start
///     to line N+M start produces)
/// Returns null when the selection is empty, partial, or invalid.
/// Used by the multi-line quote / unquote chords below; passing
/// through to text input when null means a typed `>` / `<` lands
/// as a character.
function blockLineRange(view: EditorView): {
  firstLine: number;
  lastLine: number;
} | null {
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const startLine = view.state.doc.lineAt(sel.from);
  if (sel.from !== startLine.from) return null;
  const endPosLine = view.state.doc.lineAt(sel.to);
  if (sel.to === endPosLine.to) {
    return { firstLine: startLine.number, lastLine: endPosLine.number };
  }
  if (sel.to === endPosLine.from && endPosLine.number > startLine.number) {
    return { firstLine: startLine.number, lastLine: endPosLine.number - 1 };
  }
  return null;
}

/// `>` chord: prefix every line in a multi-line full-line selection
/// with `> `. Returns true (consume the keypress) when the
/// selection qualifies; false (let the `>` character fall through)
/// otherwise so the user can still type a literal `>` in prose.
export function quoteLines(view: EditorView): boolean {
  const range = blockLineRange(view);
  if (!range) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = range.firstLine; n <= range.lastLine; n++) {
    const line = view.state.doc.line(n);
    changes.push({ from: line.from, to: line.from, insert: "> " });
  }
  view.dispatch({ changes });
  return true;
}

/// Escape hatch for a fenced code block that sits at the very end of
/// the document. Inside such a block the user has no natural way
/// out: Enter inserts a literal newline INSIDE the fence, and
/// ArrowDown is a no-op because there's no line below. Wired up to
/// ArrowDown and Mod-Enter on desktop; Enter-on-closer-line covers
/// mobile keyboards that don't have a reliable Mod modifier or
/// arrow keys. All three paths route here and dispatch the same
/// "insert newline after the block, park caret there" edit.
function isCaretInsideFenceAtDocEnd(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  // Find the enclosing FencedCode (if any). Use side=-1 because the
  // caret most often sits at the END of the fence's content (last
  // body line, no text after) - at that boundary side=0 resolves to
  // the parent Document and we'd miss the fence entirely.
  const fence = enclosingFence(view.state, sel.head);
  if (!fence) return false;
  // The block must extend to (or beyond, modulo a trailing newline)
  // the end of the doc - otherwise there's content after the closer
  // and the user can just ArrowDown into it.
  if (fence.to < view.state.doc.length - 1) return false;
  // Caret must be on the actual last line of the doc. If there's
  // any line below - even the closer fence - ArrowDown should keep
  // its default behaviour (just move down by one). We only insert
  // a fresh line when standing on the closer with nowhere to go,
  // so we don't grow the file uninvited.
  const caretLine = view.state.doc.lineAt(sel.head).number;
  return caretLine === view.state.doc.lines;
}

function exitFenceAtDocEnd(view: EditorView): boolean {
  // Always exit past the closer, not at the caret's line - when the
  // caret is on the last body line, splicing at line.to would inject
  // a newline INSIDE the block. Anchor the insertion at doc.length
  // so the new line lands after the closing fence regardless of
  // whether the caret was on a body line or the closer itself.
  //
  // When the fence is UNCLOSED (no `\`\`\`` line yet - the user
  // typed an opener and started writing), appending a bare `\n`
  // just extends the unclosed fence, so the next ArrowDown is
  // still trapped. Insert the closer first in that case so the
  // new caret lands OUTSIDE the block.
  const end = view.state.doc.length;
  const closed = isFenceClosedAtDocEnd(view);
  const insert = closed ? "\n" : "\n```\n";
  view.dispatch({
    changes: { from: end, to: end, insert },
    selection: { anchor: end + insert.length },
  });
  return true;
}

/// True when the doc-end fence already has a closing `\`\`\`` line.
/// We check the doc text rather than walking the syntax tree because
/// @lezer/markdown happily extends an unclosed FencedCode all the
/// way to doc end and reports both the open and close CodeMark on
/// the same opener line - making the syntax tree alone unreliable
/// for this question.
function isFenceClosedAtDocEnd(view: EditorView): boolean {
  const doc = view.state.doc;
  // Strip a single trailing newline so a doc that ends with
  // "```\n" still finds the closer on the last meaningful line.
  let lastLineNumber = doc.lines;
  while (lastLineNumber > 1) {
    const line = doc.line(lastLineNumber);
    if (line.text.length > 0) break;
    lastLineNumber--;
  }
  const lastLine = doc.line(lastLineNumber);
  if (!CLOSER_FENCE_RE.test(lastLine.text)) return false;
  // The closer can't be the same line as the opener - if the doc
  // is just "```" on its own, that's an opener with no body, no
  // closer.
  return lastLineNumber > 1;
}

/// ArrowDown + Mod-Enter binding: exit a fenced code block when the
/// caret sits inside one on the last line of the doc. Returns false
/// otherwise so the key keeps its default behaviour.
export function escapeFenceAtDocEnd(view: EditorView): boolean {
  if (!isCaretInsideFenceAtDocEnd(view)) return false;
  return exitFenceAtDocEnd(view);
}

/// Mobile-friendly Enter binding: when the caret is on the closing
/// fence line (e.g. ``` on its own line) AND that line is the last
/// line of the doc, Enter exits the block. Keeps normal Enter (which
/// inserts a literal newline into the code body) intact for the
/// content lines above the closer.
const CLOSER_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/;
export function escapeFenceOnEnterAtCloser(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  // Closer must be the last line of the doc (allowing one optional
  // trailing newline that the doc itself bakes into doc.length).
  if (line.to < view.state.doc.length - 1) return false;
  if (!CLOSER_FENCE_RE.test(line.text)) return false;
  if (!enclosingFence(view.state, sel.head)) return false;
  return exitFenceAtDocEnd(view);
}

/// Mod-Enter from anywhere inside a fenced code block: append a
/// blank line just past the block end and park the caret on it.
/// This is the always-on escape hatch - independent of where the
/// block sits in the doc, whether the caret is on the opener / a
/// body line / the closer, and whether the block is closed at all.
///
/// The earlier "must be at doc end + caret on last line" rules
/// kept missing edge cases (empty trailing line, lezer's
/// resolveInner side-bias, unclosed fence parsing); this command
/// is the user-controlled out: press Mod-Enter, get out. If the
/// caret is not in any fence, return false so Mod-Enter can fall
/// through to the caller's next key binding.
export function exitFenceAnywhere(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const fence = enclosingFence(view.state, sel.head);
  if (!fence) return false;
  const closed = isFenceNodeClosed(view.state, fence);
  // Anchor the insertion at the fence's end. For an unclosed fence
  // that runs to doc end this is doc.length; for a closed fence
  // mid-doc this is the position right after the closer's last
  // backtick. Inserting a closer line in the unclosed case ensures
  // the new caret position sits OUTSIDE the (newly closed) block.
  const at = Math.min(fence.to, view.state.doc.length);
  const insert = closed ? "\n" : "\n```\n";
  view.dispatch({
    changes: { from: at, to: at, insert },
    selection: { anchor: at + insert.length },
  });
  return true;
}

/// True when the fence node's last line is a `\`\`\`` closer (or
/// `~~~`). Walks the node's text instead of its child tree because
/// @lezer/markdown sometimes emits both open/close CodeMark on the
/// opener line for unclosed fences, which makes the child-based
/// "two distinct CodeMarks" check unreliable.
function isFenceNodeClosed(
  state: import("@codemirror/state").EditorState,
  fence: import("@lezer/common").SyntaxNode,
): boolean {
  const fenceEndLine = state.doc.lineAt(
    Math.min(fence.to, state.doc.length),
  );
  // The closer must be on a different line from the opener - a
  // single-line `\`\`\`` is just an opener with no body / no
  // closer.
  if (fenceEndLine.from <= fence.from) return false;
  return CLOSER_FENCE_RE.test(fenceEndLine.text);
}

/// Walk syntax-tree ancestors at `pos` looking for a FencedCode
/// node. Tries side=-1 first (preferred for end-of-doc carets) and
/// falls back to side=1 so a caret sitting just before an opener
/// fence still resolves into it. Centralizes the boundary handling
/// so callers don't need to repeat the side trick. Exported for the
/// list keymap, whose regex cannot tell a bullet from a YAML line in
/// a code block.
export function enclosingFence(
  state: import("@codemirror/state").EditorState,
  pos: number,
): import("@lezer/common").SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let n: import("@lezer/common").SyntaxNode | null = syntaxTree(
      state,
    ).resolveInner(pos, side);
    while (n) {
      if (n.name === "FencedCode") return n;
      n = n.parent;
    }
  }
  return null;
}

/// Tab inside a fenced code block: insert a literal `\t` at the
/// caret (or replace the active selection). Returns false when the
/// caret isn't inside a fence so the keymap falls through to the
/// next Tab handler (list indent / browser focus).
export function tabInFence(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!enclosingFence(view.state, sel.head)) return false;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: "\t" },
    selection: { anchor: sel.from + 1 },
  });
  return true;
}

/// `<` chord: strip one level of `> ` (or `>` alone) from every
/// line in a multi-line full-line selection. Falls through if no
/// line has a quote prefix (so an unrelated `<` stays a literal
/// character). Single-level only - pressing `<` twice on a
/// `> > foo` line peels both levels in sequence.
export function unquoteLines(view: EditorView): boolean {
  const range = blockLineRange(view);
  if (!range) return false;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = range.firstLine; n <= range.lastLine; n++) {
    const line = view.state.doc.line(n);
    const m = /^> ?/.exec(line.text);
    if (!m) continue;
    changes.push({ from: line.from, to: line.from + m[0].length, insert: "" });
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes });
  return true;
}

/// Toggle a list prefix on the current line. If the line already starts
/// with the target prefix, strip it; otherwise replace any existing
/// list / heading / quote prefix with the new one.
function toggleLinePrefix(view: EditorView, target: string): void {
  const sel = view.state.selection.main;
  // A list chord inside a fenced or inline code span would rewrite literal code;
  // leave it untouched.
  if (caretInsideCode(view.state, sel.head)) return;
  const line = view.state.doc.lineAt(sel.head);
  const text = line.text;
  // Existing prefix detection (any list / task / quote / heading).
  const m = /^((?:[-*+]\s+(?:\[[ xX]\]\s+)?)|(?:\d+\.\s+)|(?:>\s+)|(?:[#]+\s+))/.exec(text);
  const existing = m ? m[0] : "";
  const inner = m ? text.slice(existing.length) : text;
  if (existing === target) {
    // Already this prefix - strip it.
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: inner },
    });
    return;
  }
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: `${target}${inner}` },
  });
}

export function toggleBulletList(view: EditorView): void {
  toggleLinePrefix(view, "- ");
}
export function toggleOrderedList(view: EditorView): void {
  toggleLinePrefix(view, "1. ");
}
export function toggleTaskList(view: EditorView): void {
  toggleLinePrefix(view, "- [ ] ");
}

export function insertHorizontalRule(view: EditorView): void {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  // Insert a fresh `---` line below the current; if the current line
  // is empty, replace it.
  if (line.text.trim() === "") {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "---" },
    });
  } else {
    view.dispatch({
      changes: { from: line.to, to: line.to, insert: "\n\n---\n" },
    });
  }
}

export function insertImage(view: EditorView): void {
  // Insert `![](|)` at caret; the `![` triggers the image bubble on
  // the next transaction.
  const sel = view.state.selection.main;
  const insert = "![](";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${insert})` },
    selection: { anchor: sel.from + insert.length },
  });
}

/// Apply a Link mark. Without an explicit URL, asks the user through
/// the in-house PromptModal (uiPrompt) - never a `window.prompt`,
/// which fails silently inside Chan.app's WKWebView. Returns early if
/// the user cancels.
export async function toggleLink(view: EditorView, url?: string): Promise<void> {
  let target = url;
  if (target === undefined) {
    const answer = await uiPrompt("URL");
    target = answer?.trim() ?? "";
    if (!target) return;
  }
  // Re-read the selection AFTER the await: the modal is async, so the
  // user's selection (or even the editor mount) might have shifted.
  // Bail safely if the view has gone away. CM6's `destroyed` field is
  // marked private on EditorView; route through `unknown` so the type
  // system stays out of the way of this defensive runtime check.
  if ((view as unknown as { destroyed?: boolean }).destroyed) return;
  const sel = view.state.selection.main;
  if (sel.empty) {
    const insert = `[](${target})`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + 1 }, // caret in the label
    });
    return;
  }
  const text = view.state.doc.sliceString(sel.from, sel.to);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `[${text}](${target})` },
  });
}

// ---- introspection -------------------------------------------------------

export function isActive(view: EditorView, name: string): boolean {
  const pos = view.state.selection.main.head;
  switch (name) {
    case "bold":
      return !!findAncestor(view, pos, "StrongEmphasis");
    case "italic":
      return !!findAncestor(view, pos, "Emphasis");
    case "strike":
      return !!findAncestor(view, pos, "Strikethrough");
    case "code":
      return !!findAncestor(view, pos, "InlineCode");
    case "link":
      return !!findAncestor(view, pos, "Link") || !!findAncestor(view, pos, "Autolink");
    case "bulletList":
      return !!findAncestor(view, pos, "BulletList");
    case "orderedList":
      return !!findAncestor(view, pos, "OrderedList");
    case "taskList":
      return !!findAncestor(view, pos, "Task");
    case "blockquote":
      return !!findAncestor(view, pos, "Blockquote");
    default:
      return false;
  }
}

export function currentBlockKind(view: EditorView): BlockKind {
  const pos = view.state.selection.main.head;
  // Walk to the innermost block-level ancestor.
  let node = syntaxTree(view.state).resolveInner(pos, 0);
  while (node) {
    switch (node.name) {
      case "ATXHeading1":
        return "h1";
      case "ATXHeading2":
        return "h2";
      case "ATXHeading3":
        return "h3";
      case "ATXHeading4":
      case "ATXHeading5":
      case "ATXHeading6":
        return "h3"; // collapsed into h3 (StyleToolbar only exposes h1-h3)
      case "Blockquote":
        return "quote";
      case "FencedCode":
      case "CodeBlock":
        return "code";
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return "normal";
}

// ---- helpers -------------------------------------------------------------

function findAncestor(
  view: EditorView,
  pos: number,
  name: string,
): import("@lezer/common").SyntaxNode | null {
  let node: import("@lezer/common").SyntaxNode | null = syntaxTree(
    view.state,
  ).resolveInner(pos, 0);
  while (node) {
    if (node.name === name) return node;
    node = node.parent;
  }
  return null;
}
