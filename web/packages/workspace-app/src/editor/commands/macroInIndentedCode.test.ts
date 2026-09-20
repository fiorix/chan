// @vitest-environment jsdom
//
// A typing macro rewrites the line the caret is on. Inside a fenced code
// block that is wrong, because the line is a code sample the author is
// showing, and it is equally wrong inside an INDENTED code block, which
// the parser calls something else.
//
// The list commands read the enclosing FENCE for their own reason (a
// list-shaped line inside a code block is code, not a list). That
// predicate is shared, so this file also pins what the list command does
// in an indented code block, which is the behaviour that must not move
// when the macro stops firing there.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { chanMarkdown } from "../markdown/grammar";
import { expandPageBreakMacro } from "./page_break";
import { continueListOnEnter } from "./list";

let view: EditorView | undefined;
let parent: HTMLElement | undefined;

function mount(doc: string, head: number): EditorView {
  parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [chanMarkdown()],
    }),
    parent,
  });
  forceParsing(view, view.state.doc.length, 5000);
  return view;
}

/// The innermost node the parser reports at the caret, named so a change
/// in the grammar shows up here rather than as a silent behaviour shift.
function nodeAt(v: EditorView, pos: number): string {
  return syntaxTree(v.state).resolveInner(pos, -1).name;
}

afterEach(() => {
  view?.destroy();
  parent?.remove();
  view = undefined;
  parent = undefined;
  document.body.innerHTML = "";
});

describe("an indented code block", () => {
  test("is a code block to the parser, under its own name", () => {
    const doc = "text\n\n    @pagebreak";
    const v = mount(doc, doc.length);
    expect(nodeAt(v, doc.length)).toBe("CodeText");
  });

  test("keeps the page-break macro literal", () => {
    const doc = "text\n\n    @pagebreak";
    const v = mount(doc, doc.length);
    const fired = expandPageBreakMacro(v);
    expect(v.state.doc.toString()).toBe(doc);
    expect(fired).toBe(false);
  });

  test("leaves the list command's verdict where it is", () => {
    // Measured, not wished for: the list command reads the enclosing
    // FENCE, so in an indented code block it sees none and continues the
    // list, growing a bullet inside a code sample. That is its own
    // defect and its own file. What this pins is that the macro's guard
    // does not move it, in either direction.
    const doc = "text\n\n    - item";
    const v = mount(doc, doc.length);
    expect(continueListOnEnter(v)).toBe(true);
  });

  test("a fenced code block keeps the macro literal too", () => {
    const doc = "```text\n@pagebreak";
    const v = mount(doc, doc.length);
    expect(expandPageBreakMacro(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(doc);
  });

  test("an ordinary line still expands the macro", () => {
    const doc = "text\n\n@pagebreak";
    const v = mount(doc, doc.length);
    expect(expandPageBreakMacro(v)).toBe(true);
    expect(v.state.doc.toString()).toContain('<hr class="chan-page-break">');
  });
});
