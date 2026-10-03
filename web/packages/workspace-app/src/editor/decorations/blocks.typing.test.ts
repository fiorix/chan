// @vitest-environment jsdom

// End-to-end check that list markers decorate in three contexts: an empty
// doc, after a paragraph, and directly under a `---` opener with no closing
// fence. The `---`-headed case depends on the frontmatter parser leaving an
// unclosed opener alone: a parser that consumed it would corrupt the whole
// document parse, and no list would style. Also verifies the Enter
// keymap's regex path continues numbering regardless of parse state.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";
import { continueListOnEnter } from "../commands/list";

function mountDecorated(doc: string): { parent: HTMLDivElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [chanMarkdown(), chanDecorations()],
    }),
  });
  return { parent, view };
}

// The three contexts a freshly-typed list item can appear in. The `head`
// prefix precedes the list line; the `---` head is the unclosed opener.
const CONTEXTS: Array<{ label: string; head: string }> = [
  { label: "empty doc", head: "" },
  { label: "after a paragraph", head: "intro\n\n" },
  { label: "under an unclosed `---` opener", head: "---\n" },
];

describe("list marker decorations by context", () => {
  for (const { label, head } of CONTEXTS) {
    test(`ordered / bullet / task markers style ${label}`, () => {
      const { parent, view } = mountDecorated(
        `${head}1. one\n- two\n* three\n+ four\n- [ ] task`,
      );
      expect(parent.querySelector(".cm-md-ol-marker")).toBeTruthy();
      expect(parent.querySelectorAll(".cm-md-ul-marker").length).toBe(3);
      expect(parent.querySelector(".cm-md-task-checkbox")).toBeTruthy();
      view.destroy();
      parent.remove();
    });
  }
});

describe("Enter continues an ordered list", () => {
  for (const { label, head } of CONTEXTS) {
    test(`Enter after \`1. item\` inserts \`\\n2. \` ${label}`, () => {
      const doc = `${head}1. item`;
      const { parent, view } = mountDecorated(doc);
      // Caret at end of the ordered item.
      view.dispatch({ selection: { anchor: doc.length } });
      const handled = continueListOnEnter(view);
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe(`${head}1. item\n2. `);
      view.destroy();
      parent.remove();
    });
  }
});
