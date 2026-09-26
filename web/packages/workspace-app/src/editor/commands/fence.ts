// Both faces of the fenced-code-block question: the syntax-tree predicates
// the keymap commands share, and a line tracker for callers that scan
// markdown source with no editor state to ask. Kept in its own module with
// no dependency beyond the syntax tree so the list command can ask it
// without pulling the store module (and its import-time side effects) into
// every test that mounts the editor commands.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/// Walk syntax-tree ancestors at `pos` looking for a FencedCode
/// node. Tries side=-1 first (preferred for end-of-doc carets) and
/// falls back to side=1 so a caret sitting just before an opener
/// fence still resolves into it. Centralizes the boundary handling
/// so callers don't need to repeat the side trick.
export function enclosingFence(state: EditorState, pos: number): SyntaxNode | null {
  return enclosingNamed(state, pos, "FencedCode");
}

/// Walk ancestors at `pos` looking for code of either spelling: a fenced
/// block or an indented one. Markdown has two, and a typing macro must
/// stay literal in both, because either one is a sample the author is
/// showing rather than prose being written. The fence-specific callers
/// keep `enclosingFence`: they act on the fence's own range, which an
/// indented block does not have.
export function enclosingCode(state: EditorState, pos: number): SyntaxNode | null {
  return (
    enclosingNamed(state, pos, "FencedCode") ??
    enclosingNamed(state, pos, "CodeBlock")
  );
}

function enclosingNamed(
  state: EditorState,
  pos: number,
  name: string,
): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (n) {
      if (n.name === name) return n;
      n = n.parent;
    }
  }
  return null;
}

/// Where a markdown source line sits relative to fenced code blocks: a
/// fence line that opens or closes one, a line inside one, or text.
export type FenceLine = "fence" | "code" | "text";

/// The string face of the fence question. Feed the returned function every
/// line of a document in order and it classifies each one. A fence opens on
/// a run of three or more backticks or tildes behind at most three spaces
/// (a tab there makes the line indented code), or right after a list item's
/// marker, and only a run of the same character at least as long closes it,
/// so a ``` line inside a ~~~ block or a ```` block is code. A fence opened
/// on a list item's marker line belongs to the item: its closer sits at the
/// item's content column, and a line indented less than that column ends the
/// item and the fence with it. Each call starts a fresh document.
export function fenceLineTracker(): (line: string) => FenceLine {
  // The open fence's run, and the column its lines are indented from: 0 at
  // the top level, the content column for a fence on a list marker line.
  let fence: { run: string; column: number } | null = null;
  return (line) => {
    if (fence && fence.column > 0 && line.trim() !== "" && indentOf(line) < fence.column) {
      fence = null;
    }
    if (fence) {
      const run = fenceRun(line, fence.column);
      if (run && run[0] === fence.run[0] && run.length >= fence.run.length) {
        fence = null;
        return "fence";
      }
      return "code";
    }
    const run = fenceRun(line, 0);
    if (run) {
      fence = { run, column: 0 };
      return "fence";
    }
    const item = LIST_ITEM_FENCE.exec(line);
    if (item) {
      fence = { run: item[4]!, column: item[1]!.length + item[2]!.length + item[3]!.length };
      return "fence";
    }
    return "text";
  };
}

// A list item's marker line whose content is a fence run: the marker's
// indent, the marker (-, *, + or a number with . or ), then one to four
// spaces to the content column, where the run starts.
const LIST_ITEM_FENCE = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4})(`{3,}|~{3,})/;

/// The run of 3+ backticks or tildes that opens or closes a fence on
/// `line`, or null. Only up to three spaces past `column` may precede it.
function fenceRun(line: string, column: number): string | null {
  const spaces = /^ */.exec(line)![0].length;
  if (spaces < column || spaces > column + 3) return null;
  return /^(`{3,}|~{3,})/.exec(line.slice(spaces))?.[1] ?? null;
}

/// The column where `line`'s content starts, a tab advancing to the next
/// multiple of four as CommonMark counts it.
function indentOf(line: string): number {
  let column = 0;
  for (const ch of line) {
    if (ch === " ") column += 1;
    else if (ch === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}
