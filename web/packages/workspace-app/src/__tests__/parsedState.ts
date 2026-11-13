// An editor state whose whole document is in the tree `syntaxTree` reads.
//
// A state's creation parse stops when its 20 ms budget runs out, which a
// loaded machine can make happen after the first block. `ensureSyntaxTree`
// finishes the parse in the state's parse context only: `syntaxTree(state)`
// keeps answering with the tree the state was created with. A transaction
// is what moves the finished tree into the next state, which is how
// `forceParsing` publishes it to a view; an empty one carries no change of
// its own.

import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export function parsedState(state: EditorState): EditorState {
  if (!ensureSyntaxTree(state, state.doc.length, 10_000)) {
    throw new Error("the fixture did not parse within 10 s");
  }
  return state.update({}).state;
}
