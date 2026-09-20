// The fenced-code-block predicate the keymap commands share. Kept in its
// own module with no dependency beyond the syntax tree so the list
// command can ask it without pulling the store module (and its import-time
// side effects) into every test that mounts the editor commands.

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
