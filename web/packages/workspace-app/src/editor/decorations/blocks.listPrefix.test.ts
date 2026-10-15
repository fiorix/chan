// @vitest-environment jsdom
//
// A list item's hidden prefix (indent, marker, gap) is one atomic range and
// the caret never rests inside it: an arrow crosses it in one press, and a
// selection that another path puts inside (a typed space at the line start,
// Home on an indented item, a restore) is moved to its edge. A caret inside
// the prefix has no text node of its own in the DOM, and the browser then
// types beside it in an order of its own. The owner's sequence from the start
// of the second item's text, two ArrowLefts, an ArrowRight, a Space and a
// word, must leave the word in order, and no sequence may take an ordered
// marker's number from its dot.

import { EditorState } from "@codemirror/state";
import { EditorView, type ViewPlugin } from "@codemirror/view";
import type { RangeSet, RangeValue } from "@codemirror/state";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  deleteCharBackward,
  deleteCharForward,
  selectCharLeft,
  selectLineBoundaryBackward,
} from "@codemirror/commands";
import { afterEach, describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations, chanDecorationWalker } from ".";
import { listPrefixCaret, listPrefixSpans } from "./list_prefix";

// jsdom lacks the range geometry the cursor commands' scroll-into-view measures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

function mount(doc: string, head: number, extensions = [chanMarkdown(), chanDecorations()]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: { anchor: head }, extensions }),
  });
  views.push(view);
  return view;
}

function head(view: EditorView): number {
  return view.state.selection.main.head;
}

/// Insert `text` at the caret one character at a time, as typed keys land at
/// the state level: the change and the caret after it in one transaction.
function type(view: EditorView, text: string): void {
  for (const ch of text) {
    const at = head(view);
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 } });
  }
}

/// The caret as the DOM has it: a text node and an offset into it, or an
/// element and a child index, which is a position with no text of its own.
function domHome(view: EditorView): { text: boolean; node: string; offset: number } {
  const { node, offset } = view.domAtPos(head(view));
  const text = node.nodeType === Node.TEXT_NODE;
  return { text, node: text ? (node.textContent ?? "") : (node as Element).className, offset };
}

function secondLine(view: EditorView): string {
  return view.state.doc.line(2).text;
}

/// The item shapes the owner's sequence runs over. The second line holds the
/// item, `textStart` is the offset of its text in the document, and `typed`
/// is that line after the owner's sequence: the Space lands at the line
/// start, in front of the marker, and the word at the start of the text.
const ITEMS = [
  { label: "a `*` item", doc: "* one\n* two", textStart: 8, typed: " * hellotwo" },
  { label: "a `-` item", doc: "- one\n- two", textStart: 8, typed: " - hellotwo" },
  { label: "an ordered item", doc: "1. one\n2. two", textStart: 10, typed: " 2. hellotwo" },
  { label: "a nested item", doc: "* one\n  * two", textStart: 10, typed: "   * hellotwo" },
];

describe("the list prefix is one atomic range", () => {
  test.each(ITEMS)("one ArrowLeft from the text start of $label reaches the line start, one ArrowRight returns", ({ doc, textStart }) => {
    const view = mount(doc, textStart);
    const lineStart = view.state.doc.lineAt(textStart).from;

    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(lineStart);
    expect(cursorCharRight(view)).toBe(true);
    expect(head(view)).toBe(textStart);
  });

  test.each([...ITEMS, { label: "a task item", doc: "- [ ] one\n- [ ] two", textStart: 16, typed: "- [ ]  hellotwo" }])(
    "the owner's sequence on $label types the word in order at the start of the text",
    ({ doc, textStart, typed }) => {
      const view = mount(doc, textStart);
      const heads: number[] = [];
      for (const step of [cursorCharLeft, cursorCharLeft, cursorCharRight]) {
        step(view);
        heads.push(head(view));
      }
      type(view, " ");
      heads.push(head(view));
      // The space widened a hidden span; the caret is at its edge, in a text
      // node, never inside it.
      expect(domHome(view).text).toBe(true);
      type(view, "hello");
      expect(secondLine(view)).toBe(typed);
      expect(head(view)).toBe(view.state.doc.line(2).from + typed.length - "two".length);
      expect(domHome(view)).toEqual({ text: true, node: "hellotwo", offset: 5 });
      for (const h of heads) {
        const line = view.state.doc.lineAt(h);
        expect(listPrefixSpans(view.state, h).some((s) => h > s.from && h < s.to), `caret ${h} inside the prefix of ${JSON.stringify(line.text)}`).toBe(false);
      }
    },
  );

  test("the owner's three ArrowLefts on an ordered item leave the number and dot together", () => {
    const view = mount("1. one\n2. two", 10);
    const heads: number[] = [];
    for (const step of [cursorCharLeft, cursorCharLeft, cursorCharLeft, cursorCharRight]) {
      step(view);
      heads.push(head(view));
    }
    expect(heads).not.toContain(8);
    type(view, " ");
    type(view, "hel");
    expect(view.state.doc.toString()).not.toContain("2 .");
    expect(secondLine(view)).toBe("2. two");
    expect(view.state.doc.line(1).text).toBe("1. one hel");
  });

  test("ArrowLeft never stops between a marker and its gap", () => {
    const view = mount("* one\n* two", 8);
    const stops: number[] = [];
    while (cursorCharLeft(view) && head(view) > 0) stops.push(head(view));
    expect(stops).toEqual([6, 5, 4, 3, 2]);
  });

  test("a space typed at the text start widens the gap and the caret stays at the text start", () => {
    const view = mount("* one\n* two", 8);
    type(view, " ");
    expect(view.state.doc.toString()).toBe("* one\n*  two");
    expect(head(view)).toBe(9);
    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(6);
    expect(cursorCharRight(view)).toBe(true);
    expect(head(view)).toBe(9);
    type(view, "hello");
    expect(view.state.doc.toString()).toBe("* one\n*  hellotwo");
    expect(domHome(view)).toEqual({ text: true, node: "hellotwo", offset: 5 });
  });

  test("the task checkbox stays reachable beside its atomic neighbours", () => {
    const view = mount("- [ ] one\n- [ ] two", 16);
    // 16 is the text start, 15 the end of the box `[ ]`, 12 its start; the
    // gap after the box and the bullet prefix before it are atomic, the box
    // is not.
    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(15);
    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(14);
    view.dispatch({ selection: { anchor: 12 } });
    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(10);
    expect(cursorCharRight(view)).toBe(true);
    expect(head(view)).toBe(12);
    expect(view.dom.querySelectorAll(".cm-md-task-checkbox")).toHaveLength(2);
  });

  test("Home on an indented item alternates between the line start and the text start", () => {
    const view = mount("* one\n  * two", 10);
    expect(cursorLineBoundaryBackward(view)).toBe(true);
    expect(head(view)).toBe(6);
    expect(cursorLineBoundaryBackward(view)).toBe(true);
    expect(head(view)).toBe(10);
  });

  test("Shift+ArrowLeft and Shift+Home select the prefix whole", () => {
    const view = mount("* one\n  * two", 10);
    expect(selectCharLeft(view)).toBe(true);
    expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([10, 6]);
    view.dispatch({ selection: { anchor: 10 } });
    expect(selectLineBoundaryBackward(view)).toBe(true);
    expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([10, 6]);
  });

  test("Backspace at the text start and Delete at the line start remove the prefix in one press", () => {
    const view = mount("* one\n  * two", 10);
    expect(deleteCharBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("* one\ntwo");
    expect(head(view)).toBe(6);

    const other = mount("1. one\n2. two", 7);
    expect(deleteCharForward(other)).toBe(true);
    expect(other.state.doc.toString()).toBe("1. one\ntwo");
    expect(head(other)).toBe(7);
  });

  test("a selection set inside the prefix moves to the edge on the side it came from", () => {
    const fromText = mount("1. one\n10. two", 11);
    fromText.dispatch({ selection: { anchor: 9 } });
    expect(head(fromText)).toBe(7);

    const fromStart = mount("1. one\n10. two", 0);
    fromStart.dispatch({ selection: { anchor: 9 } });
    expect(head(fromStart)).toBe(11);
  });

  test("a list-shaped line that is not an item keeps every position", () => {
    // `2.` cannot interrupt a paragraph, so the second line is its
    // continuation; a fence holds code, not a list.
    const lazy = mount("text\n2. two", 0);
    lazy.dispatch({ selection: { anchor: 6 } });
    expect(head(lazy)).toBe(6);
    expect(cursorCharLeft(lazy)).toBe(true);
    expect(head(lazy)).toBe(5);

    const fenced = mount("```\n- name: x\n```", 0);
    fenced.dispatch({ selection: { anchor: 5 } });
    expect(head(fenced)).toBe(5);
  });

  test("the caret filter's spans are the walker's atomic ranges", () => {
    const doc = "* star\n- dash\n1. one\n  * nested\n- [ ] task\n1. [x] done\n- \u00a0nbsp\nplain";
    const walker = chanDecorationWalker();
    const view = mount(doc, 0, [chanMarkdown(), walker, listPrefixCaret()]);
    const plugin = view.plugin(walker as ViewPlugin<{ atomics: RangeSet<RangeValue> }>);
    expect(plugin).toBeTruthy();
    const atomics: Array<[number, number]> = [];
    plugin!.atomics.between(0, doc.length, (from, to) => {
      atomics.push([from, to]);
    });
    const spans: Array<[number, number]> = [];
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n);
      for (const s of listPrefixSpans(view.state, line.from)) spans.push([s.from, s.to]);
    }
    expect(atomics.length).toBeGreaterThan(6);
    expect(spans).toEqual(atomics);
  });
});
