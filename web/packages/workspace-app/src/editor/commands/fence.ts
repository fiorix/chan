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
/// a run of three or more backticks or tildes behind at most three
/// whitespace characters, and only a run of the same character at least
/// as long closes it, so a ``` line inside a ~~~ block or a ```` block is
/// code. Each call starts a fresh document.
export function fenceLineTracker(): (line: string) => FenceLine {
  let fence: string | null = null;
  return (line) => {
    const marker = fenceMarker(line);
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        return "fence";
      }
      return "code";
    }
    if (marker) {
      fence = marker;
      return "fence";
    }
    return "text";
  };
}

/// The fence marker (a run of 3+ backticks or tildes) that opens/closes a code
/// block on `line`, or null. Only leading indentation may precede it.
function fenceMarker(line: string): string | null {
  const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : null;
}
