// An editor whose creation parse ends after its first slice, as it can on a
// throttled CPU share. The language parses one bounded slice when the state
// is created and checks the clock against its budget after each step; the
// clock here steps a second at each read while the state and the view are
// built, so that parse stops at its first check. The clock is restored
// before the view is handed back.

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vi } from "vitest";

export function viewWithShortParse(
  doc: string,
  extensions: Extension,
  anchor = 0,
): { parent: HTMLElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.append(parent);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  try {
    const state = EditorState.create({ doc, selection: { anchor }, extensions });
    return { parent, view: new EditorView({ parent, state }) };
  } finally {
    clock.mockRestore();
  }
}
