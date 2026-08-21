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
  for (const side of [-1, 1] as const) {
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (n) {
      if (n.name === "FencedCode") return n;
      n = n.parent;
    }
  }
  return null;
}
