// @vitest-environment jsdom
//
// A list item's first caret position is the start of its text. The hidden
// prefix (indent, marker, gap) is one atomic range, and no caret rests
// anywhere from the line start to the text start, a task's box included:
// ArrowLeft and the other leftward steps from the text start leave the line
// for the end of the line above (on the first line they stay), Home and the
// line-start keys go to the text start, a click or a drag on or left of the
// glyph lands at the text start, and a range keeps the line start only when
// it takes the line whole. Nothing can be typed in front of a marker, and no
// key takes an ordered marker's number from its dot.

import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type RangeSet, type RangeValue, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, type ViewPlugin } from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  defaultKeymap,
  deleteCharBackward,
  deleteCharForward,
  history,
  selectLine,
  undo,
} from "@codemirror/commands";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations, chanDecorationWalker } from ".";
import {
  cursorItemLineBoundaryBackward,
  cursorItemLineStart,
  itemRegion,
  listPrefixCaret,
  selectItemLineStart,
} from "./list_prefix";
import { indentListItem, outdentListItem } from "../commands/list";

// jsdom lacks the range geometry the cursor commands' scroll-into-view measures.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

function editorExtensions() {
  return [chanMarkdown(), chanDecorations(), history(), keymap.of(defaultKeymap)];
}

function mountState(state: EditorState): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state });
  views.push(view);
  return view;
}

/// A fixture parsed whole. A state's first parse stops when its time budget
/// runs out, a selection never moves the parse on, and the view parses the
/// rest when the page is idle, which a synchronous sweep never is: on a loaded
/// machine the later items would stay unparsed, and so no items, for a whole
/// sweep of selections. The finished tree is taken in without the filters, so
/// the selection stays where the test puts it.
function mount(doc: string, head: number, extensions = editorExtensions()): EditorView {
  const state = EditorState.create({ doc, selection: { anchor: head }, extensions });
  if (!ensureSyntaxTree(state, doc.length, 10_000)) throw new Error("the fixture did not parse within 10 s");
  return mountState(state.update({ filter: false }).state);
}

function head(view: EditorView): number {
  return view.state.selection.main.head;
}

function ends(view: EditorView): [number, number] {
  const { anchor, head } = view.state.selection.main;
  return [anchor, head];
}

/// A key through the editor's keymaps: the line-start bindings, then the
/// default keymap. On jsdom Ctrl is Mod, so Ctrl-ArrowLeft is a word step and
/// Alt-ArrowLeft a syntax step.
function key(view: EditorView, name: string, mods: Partial<KeyboardEventInit> = {}): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...mods }));
}

/// Insert `text` at the caret one character at a time, as typed keys land at
/// the state level: the change and the caret after it in one transaction.
function type(view: EditorView, text: string): void {
  for (const ch of text) {
    const at = head(view);
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" });
  }
}

function place(view: EditorView, selection: SelectionRange | number, userEvent?: string): void {
  const sel = typeof selection === "number" ? EditorSelection.cursor(selection) : selection;
  view.dispatch({ selection: EditorSelection.create([sel]), ...(userEvent ? { userEvent } : {}) });
}

/// The item shapes. The second line holds the item; `textStart` is the offset
/// of its text, `lineStart` of its line, and `aboveEnd` the end of line one.
const SHAPES = [
  { label: "a `*` item", doc: "* one\n* two", lineStart: 6, textStart: 8, aboveEnd: 5, firstText: 2 },
  { label: "a `-` item", doc: "- one\n- two", lineStart: 6, textStart: 8, aboveEnd: 5, firstText: 2 },
  { label: "an ordered item", doc: "1. one\n2. two", lineStart: 7, textStart: 10, aboveEnd: 6, firstText: 3 },
  { label: "a nested item", doc: "* one\n  * two", lineStart: 6, textStart: 10, aboveEnd: 5, firstText: 2 },
  { label: "a task item", doc: "- [ ] one\n- [ ] two", lineStart: 10, textStart: 16, aboveEnd: 9, firstText: 6 },
];

describe("the text start is an item's first caret position", () => {
  test.each(SHAPES)("ArrowLeft from the text start of $label leaves the line for the end of the line above", (s) => {
    const view = mount(s.doc, s.textStart);
    key(view, "ArrowLeft");
    expect(head(view)).toBe(s.aboveEnd);
  });

  test.each(SHAPES)("word and syntax steps from the text start of $label leave the line", (s) => {
    for (const mods of [{ ctrlKey: true }, { altKey: true }]) {
      const view = mount(s.doc, s.textStart);
      key(view, "ArrowLeft", mods);
      expect(head(view), JSON.stringify(mods)).toBe(s.aboveEnd);
    }
  });

  test.each(SHAPES)("on the document's first line, $label keeps the caret at its text start", (s) => {
    for (const mods of [{}, { ctrlKey: true }, { altKey: true }]) {
      const view = mount(s.doc, s.firstText);
      key(view, "ArrowLeft", mods);
      expect(head(view), JSON.stringify(mods)).toBe(s.firstText);
    }
  });

  test.each(SHAPES)("ArrowRight from the end of the line above lands at the text start of $label", (s) => {
    const view = mount(s.doc, s.aboveEnd);
    key(view, "ArrowRight");
    expect(head(view)).toBe(s.textStart);
  });

  test.each(SHAPES)("Home goes to the text start of $label from its text and from the text start; End is unchanged", (s) => {
    const view = mount(s.doc, s.textStart + 2);
    key(view, "Home");
    expect(head(view)).toBe(s.textStart);
    key(view, "Home");
    expect(head(view)).toBe(s.textStart);
    key(view, "End");
    expect(head(view)).toBe(s.doc.length);
  });

  test.each(SHAPES)("Shift+Home selects back to the text start of $label, Shift+End from it to the line end", (s) => {
    const view = mount(s.doc, s.textStart + 2);
    key(view, "Home", { shiftKey: true });
    expect(ends(view)).toEqual([s.textStart + 2, s.textStart]);
    place(view, s.textStart);
    key(view, "End", { shiftKey: true });
    expect(ends(view)).toEqual([s.textStart, s.doc.length]);
  });

  test.each(SHAPES)("mac Ctrl-a and Shift-Ctrl-a, as the line-start keymap runs them, go to the text start of $label", (s) => {
    const view = mount(s.doc, s.textStart + 2);
    expect(cursorItemLineStart(view)).toBe(true);
    expect(head(view)).toBe(s.textStart);
    place(view, s.textStart + 3);
    expect(selectItemLineStart(view)).toBe(true);
    expect(ends(view)).toEqual([s.textStart + 3, s.textStart]);
  });

  test("the line-start commands leave a line that is not an item, and a selection of several ranges, to the default", () => {
    const view = mount("plain\n* two", 3, [...editorExtensions(), EditorState.allowMultipleSelections.of(true)]);
    expect(cursorItemLineStart(view)).toBe(false);
    expect(cursorItemLineBoundaryBackward(view)).toBe(false);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(9), EditorSelection.cursor(2)]) });
    expect(cursorItemLineStart(view)).toBe(false);
    expect(cursorItemLineBoundaryBackward(view)).toBe(false);
  });

  test("Home on a wrapped item's later visual line is left to the default", () => {
    // jsdom lays out no wrap, so the view's answer for the visual line start
    // is stood in: a boundary past the text start is a later visual line.
    const view = mount("* one two three", 12);
    view.moveToLineBoundary = () => EditorSelection.cursor(8);
    expect(cursorItemLineBoundaryBackward(view)).toBe(false);
    expect(head(view)).toBe(12);
    view.moveToLineBoundary = () => EditorSelection.cursor(0);
    expect(cursorItemLineBoundaryBackward(view)).toBe(true);
    expect(head(view)).toBe(2);
  });

  test.each(SHAPES)("Shift+ArrowLeft from the text start of $label reaches the end of the line above, Shift+ArrowRight returns", (s) => {
    const view = mount(s.doc, s.textStart);
    key(view, "ArrowLeft", { shiftKey: true });
    expect(ends(view)).toEqual([s.textStart, s.aboveEnd]);
    place(view, s.aboveEnd);
    key(view, "ArrowRight", { shiftKey: true });
    expect(ends(view)).toEqual([s.aboveEnd, s.textStart]);
  });

  test.each(SHAPES)("a vertical landing on the line start of $label, or inside its prefix, goes to the text start and keeps its goal column", (s) => {
    const below = `${s.doc}\nbelow`;
    for (const from of [1, below.length - 1]) {
      for (const at of [s.lineStart, s.lineStart + 1, s.textStart - 1]) {
        const view = mount(below, from);
        place(view, EditorSelection.cursor(at, 0, undefined, 7), "select");
        expect(head(view), `from ${from} to ${at}`).toBe(s.textStart);
        expect(view.state.selection.main.goalColumn).toBe(7);
      }
    }
  });

  test.each(SHAPES)("Shift with a vertical landing on $label: from above it ends at the text start, from below it takes the line", (s) => {
    const below = `${s.doc}\nbelow`;
    const above = s.firstText + 1;
    for (const at of [s.lineStart, s.lineStart + 1]) {
      const fromAbove = mount(below, above);
      place(fromAbove, EditorSelection.range(above, at), "select");
      expect(ends(fromAbove), `above to ${at}`).toEqual([above, s.textStart]);
      const fromBelow = mount(below, below.length - 1);
      place(fromBelow, EditorSelection.range(below.length - 1, at), "select");
      expect(ends(fromBelow), `below to ${at}`).toEqual([below.length - 1, s.lineStart]);
    }
  });

  test.each(SHAPES)("a click at the line start, on the glyph or on a blank row of $label lands at the text start", (s) => {
    for (const userEvent of ["select.pointer", "select.pointer.blank"]) {
      for (const at of [s.lineStart, s.lineStart + 1, s.textStart - 1]) {
        // From the text start too: a click is never read as a step left.
        for (const from of [0, s.textStart]) {
          const view = mount(s.doc, from);
          place(view, at, userEvent);
          expect(head(view), `${userEvent} at ${at} from ${from}`).toBe(s.textStart);
        }
      }
    }
  });

  test("a click on an ordered item's digits lands at the text start", () => {
    const view = mount("text\n\n10. ten", 0);
    for (const at of [6, 7, 8, 9]) {
      place(view, at, "select.pointer");
      expect(head(view), `at ${at}`).toBe(10);
    }
  });

  test.each(SHAPES)("a drag from left of the glyph of $label anchors at the text start on its line and keeps the whole line past it", (s) => {
    const doc = `${s.doc}\nafter`;
    const view = mount(doc, 0);
    place(view, EditorSelection.range(s.lineStart, s.textStart + 2), "select.pointer");
    expect(ends(view)).toEqual([s.textStart, s.textStart + 2]);
    place(view, EditorSelection.range(s.lineStart + 1, s.textStart + 2), "select.pointer");
    expect(ends(view)).toEqual([s.textStart, s.textStart + 2]);
    place(view, EditorSelection.range(s.lineStart, doc.length - 2), "select.pointer");
    expect(ends(view)).toEqual([s.lineStart, doc.length - 2]);
  });

  test.each(SHAPES)("a triple-click range and selectLine keep the line start of $label", (s) => {
    const middle = `${s.doc}\nafter`;
    const nextLine = s.doc.length + 1;
    const view = mount(middle, 0);
    place(view, EditorSelection.range(s.lineStart, nextLine), "select.pointer");
    expect(ends(view)).toEqual([s.lineStart, nextLine]);
    place(view, s.textStart);
    expect(selectLine(view)).toBe(true);
    expect(ends(view)).toEqual([s.lineStart, nextLine]);
    // The document's last line has no break to take.
    const last = mount(s.doc, 0);
    place(last, EditorSelection.range(s.lineStart, s.doc.length), "select.pointer");
    expect(ends(last)).toEqual([s.lineStart, s.doc.length]);
  });

  test("Ctrl+Home on a document that opens with an item lands at its text start; select all keeps the whole document", () => {
    const doc = "* one\n* two";
    const view = mount(doc, 8);
    key(view, "Home", { ctrlKey: true });
    expect(head(view)).toBe(2);
    key(view, "a", { ctrlKey: true });
    expect(ends(view)).toEqual([0, doc.length]);
  });

  test.each(SHAPES)("a restored selection or a find match at the line start of $label goes to the text start", (s) => {
    for (const from of [0, s.textStart]) {
      const view = mount(s.doc, from);
      place(view, s.lineStart);
      expect(head(view), `from ${from}`).toBe(s.textStart);
    }
  });

  test("the task box is passed by the caret and toggles on a click", () => {
    const doc = "- [ ] one\n- [ ] two";
    for (const mods of [{}, { ctrlKey: true }, { altKey: true }]) {
      const view = mount(doc, 16);
      key(view, "ArrowLeft", mods);
      expect(head(view), JSON.stringify(mods)).toBe(9);
    }
    const view = mount(doc, 16);
    for (const at of [10, 11, 12, 13, 14, 15]) {
      place(view, at);
      expect(head(view), `at ${at}`).toBe(16);
    }
    const boxes = view.dom.querySelectorAll(".cm-md-task-checkbox");
    expect(boxes).toHaveLength(2);
    boxes[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("- [ ] one\n- [x] two");
    expect(head(view)).toBe(16);
  });

  test.each(SHAPES)("the owner's sequence on $label types the word in order at the end of the item above", (s) => {
    const view = mount(s.doc, s.textStart);
    key(view, "ArrowLeft");
    key(view, "ArrowLeft");
    key(view, "ArrowRight");
    type(view, " ");
    type(view, "hello");
    const [first, second] = s.doc.split("\n");
    expect(view.state.doc.toString()).toBe(`${first} hello\n${second}`);
    expect(head(view)).toBe(s.aboveEnd + " hello".length);
  });

  test("the owner's three ArrowLefts on an ordered item leave the number and dot together", () => {
    const view = mount("1. one\n2. two", 10);
    const heads: number[] = [];
    for (const name of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight"]) {
      key(view, name);
      heads.push(head(view));
    }
    expect(heads).toEqual([6, 5, 4, 5]);
    type(view, " ");
    type(view, "hel");
    expect(view.state.doc.toString()).toBe("1. on hele\n2. two");
  });

  test("ArrowLeft from an item's text start steps through the line above and stops at the first item's text start", () => {
    const view = mount("* one\n* two", 8);
    const stops: number[] = [];
    for (let i = 0; i < 10; i++) {
      const at = head(view);
      expect(cursorCharLeft(view)).toBe(true);
      if (head(view) === at) break;
      stops.push(head(view));
    }
    expect(stops).toEqual([5, 4, 3, 2]);
  });

  test("a space typed at the text start widens the gap and the caret stays at the text start", () => {
    const view = mount("* one\n* two", 8);
    type(view, " ");
    expect(view.state.doc.toString()).toBe("* one\n*  two");
    expect(head(view)).toBe(9);
    expect(cursorCharLeft(view)).toBe(true);
    expect(head(view)).toBe(5);
    expect(cursorCharRight(view)).toBe(true);
    expect(head(view)).toBe(9);
    type(view, "hello");
    expect(view.state.doc.toString()).toBe("* one\n*  hellotwo");
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

  test("a selection set inside the prefix goes to the text start from either side", () => {
    const fromText = mount("1. one\n10. two", 11);
    place(fromText, 9);
    expect(head(fromText)).toBe(11);

    const fromStart = mount("1. one\n10. two", 0);
    place(fromStart, 9);
    expect(head(fromStart)).toBe(11);
  });

  test("a list-shaped line that is not an item keeps every position", () => {
    // `2.` cannot interrupt a paragraph, so the second line is its
    // continuation; a fence holds code, not a list.
    const lazy = mount("text\n2. two", 0);
    place(lazy, 6);
    expect(head(lazy)).toBe(6);
    expect(cursorCharLeft(lazy)).toBe(true);
    expect(head(lazy)).toBe(5);

    const fenced = mount("```\n- name: x\n```", 0);
    place(fenced, 5);
    expect(head(fenced)).toBe(5);
    place(fenced, 4);
    expect(head(fenced)).toBe(4);
  });

  test("each item's region spans the walker's atomic ranges on its line", () => {
    const doc = "* star\n- dash\n1. one\n  * nested\n- [ ] task\n1. [x] done\n- \u00a0nbsp\nplain";
    const walker = chanDecorationWalker();
    const view = mount(doc, 0, [chanMarkdown(), walker, listPrefixCaret()]);
    const plugin = view.plugin(walker as ViewPlugin<{ atomics: RangeSet<RangeValue> }>);
    expect(plugin).toBeTruthy();
    const atomics: Array<[number, number]> = [];
    plugin!.atomics.between(0, doc.length, (from, to) => {
      atomics.push([from, to]);
    });
    const regions: Array<[number, number]> = [];
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n);
      const region = itemRegion(view.state, line.from);
      if (!region) continue;
      const own = atomics.filter(([from]) => from >= line.from && from <= line.to);
      expect(own.length, `atomics on ${JSON.stringify(line.text)}`).toBeGreaterThan(0);
      regions.push([region.from, region.to]);
      expect([own[0][0], own[own.length - 1][1]], JSON.stringify(line.text)).toEqual([region.from, region.to]);
    }
    expect(regions).toHaveLength(7);
  });
});

// The sweep: every position of a document holding every item shape, reached
// by every path, must leave no caret and no range end in a region, except a
// range end at a line start when the range takes that line whole. The regions
// of the fixture are written out here, not read from the code under test.
const SWEEP_LINES: Array<[string, number | null]> = [
  ["* first", 2],
  ["para", null],
  ["  * indented", 4],
  ["- [ ] open", 6],
  ["- [x] done", 6],
  // Blank lines keep each list apart: a `10.` item cannot interrupt the
  // task's paragraph, an empty item cannot interrupt the `10.` item's, and
  // `2. lazy` is a continuation of the paragraph `text` only outside a list.
  ["", null],
  ["10. ten", 4],
  ["", null],
  ["* ", 2],
  ["", null],
  ["text", null],
  ["2. lazy", null],
  ["* last", 2],
];
const SWEEP_DOC = SWEEP_LINES.map(([text]) => text).join("\n");

interface Span {
  from: number;
  to: number;
}

function fixtureRegions(): Span[] {
  const regions: Span[] = [];
  let from = 0;
  for (const [text, prefix] of SWEEP_LINES) {
    if (prefix !== null) regions.push({ from, to: from + prefix });
    from += text.length + 1;
  }
  return regions;
}

/// The regions of any document by the test's own reading, for the documents
/// an edit makes: a list prefix at the line start whose marker the parser
/// reads as a list mark. Checked against the fixture's written regions.
function readRegions(state: EditorState): Span[] {
  const regions: Span[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const m = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\])?[ \t\u00a0]*/.exec(line.text);
    if (!m) continue;
    if (syntaxTree(state).resolveInner(line.from + m[1].length, 1).name !== "ListMark") continue;
    regions.push({ from: line.from, to: line.from + m[0].length });
  }
  return regions;
}

function breach(state: EditorState, regions: Span[]): string | null {
  const range = state.selection.main;
  const holding = (pos: number) => regions.find((r) => pos >= r.from && pos < r.to);
  const takesLine = (r: Span, other: number) => {
    const end = state.doc.lineAt(r.from).to;
    return other > end || (other === end && end === state.doc.length);
  };
  const pairs: Array<[number, number]> = range.empty
    ? [[range.head, range.head]]
    : [
        [range.anchor, range.head],
        [range.head, range.anchor],
      ];
  for (const [end, other] of pairs) {
    const r = holding(end);
    if (!r) continue;
    if (!range.empty && end === r.from && takesLine(r, other)) continue;
    return `${range.anchor}..${range.head} has ${end} in [${r.from}, ${r.to})`;
  }
  return null;
}

/// Arrow, word (Ctrl) and syntax (Alt) steps both ways, Home and End, each
/// plain and with Shift.
const SWEEP_KEYS: Array<[string, Partial<KeyboardEventInit>]> = (
  [
    ["ArrowLeft", {}],
    ["ArrowRight", {}],
    ["ArrowLeft", { ctrlKey: true }],
    ["ArrowRight", { ctrlKey: true }],
    ["ArrowLeft", { altKey: true }],
    ["ArrowRight", { altKey: true }],
    ["Home", {}],
    ["End", {}],
  ] as Array<[string, Partial<KeyboardEventInit>]>
).flatMap(([name, mods]) => [
  [name, mods],
  [name, { ...mods, shiftKey: true }],
]);

/// The filter and the parser alone, for the sweeps that only set selections.
function mountLight(doc: string): EditorView {
  return mount(doc, 0, [chanMarkdown(), listPrefixCaret()]);
}

describe("no path leaves a caret or a range end in an item's region", () => {
  test("the written regions are the ones the parser gives the fixture", () => {
    const view = mount(SWEEP_DOC, 0);
    expect(readRegions(view.state)).toEqual(fixtureRegions());
  });

  test("a caret set at every position, by a restore and by a click", { timeout: 60_000 }, () => {
    const regions = fixtureRegions();
    const view = mountLight(SWEEP_DOC);
    const breaches: string[] = [];
    for (let pos = 0; pos <= SWEEP_DOC.length; pos++) {
      for (const userEvent of [undefined, "select.pointer"]) {
        place(view, pos, userEvent);
        const b = breach(view.state, regions);
        if (b) breaches.push(`${userEvent ?? "restore"} at ${pos}: ${b}`);
      }
    }
    expect(breaches).toEqual([]);
  });

  test("every arrow, word, syntax, Home and End key, plain and with Shift, and the line-start commands, from every position", { timeout: 60_000 }, () => {
    const regions = fixtureRegions();
    const view = mount(SWEEP_DOC, 0);
    const breaches: string[] = [];
    for (let pos = 0; pos <= SWEEP_DOC.length; pos++) {
      for (const [name, mods] of SWEEP_KEYS) {
        place(view, pos);
        key(view, name, mods);
        const b = breach(view.state, regions);
        if (b) breaches.push(`${name} ${JSON.stringify(mods)} from ${pos}: ${b}`);
      }
      for (const [label, run] of [
        ["Ctrl-a", cursorItemLineStart],
        ["Shift-Ctrl-a", selectItemLineStart],
      ] as const) {
        place(view, pos);
        run(view);
        const b = breach(view.state, regions);
        if (b) breaches.push(`${label} from ${pos}: ${b}`);
      }
    }
    expect(breaches).toEqual([]);
  });

  test("every range between two positions", { timeout: 60_000 }, () => {
    const regions = fixtureRegions();
    const view = mountLight(SWEEP_DOC);
    const breaches: string[] = [];
    for (let anchor = 0; anchor <= SWEEP_DOC.length; anchor++) {
      for (let to = 0; to <= SWEEP_DOC.length; to++) {
        if (to === anchor) continue;
        place(view, EditorSelection.range(anchor, to), "select.pointer");
        const b = breach(view.state, regions);
        if (b) breaches.push(`${anchor}..${to}: ${b}`);
      }
    }
    expect(breaches.slice(0, 20)).toEqual([]);
  });

  test("a typed character, Backspace, Enter, Tab and Shift+Tab at every position, and undo after each", { timeout: 60_000 }, () => {
    const regions = fixtureRegions();
    const view = mount(SWEEP_DOC, 0);
    const breaches: string[] = [];
    const edits: Array<[string, (v: EditorView) => void]> = [
      ["type", (v) => type(v, "x")],
      ["Backspace", (v) => key(v, "Backspace")],
      ["Enter", (v) => key(v, "Enter")],
      ["Tab", (v) => void indentListItem(v)],
      ["Shift+Tab", (v) => void outdentListItem(v)],
    ];
    for (let pos = 0; pos <= SWEEP_DOC.length; pos++) {
      for (const [label, edit] of edits) {
        place(view, pos);
        const changed = view.state.doc;
        edit(view);
        const after = breach(view.state, readRegions(view.state));
        if (after) breaches.push(`${label} at ${pos}: ${after}`);
        if (view.state.doc !== changed) undo(view);
        expect(view.state.doc.toString(), `${label} at ${pos} undone`).toBe(SWEEP_DOC);
        const undone = breach(view.state, regions);
        if (undone) breaches.push(`${label} at ${pos}, undone: ${undone}`);
      }
    }
    expect(breaches).toEqual([]);
  });
});

describe("the filter follows the parse", () => {
  test("a caret on a line the parse had not reached goes to the text start when the parse reaches it", () => {
    // Every clock read advances 50 ms while the state is built, so the first
    // parse's time budget runs out after its first step.
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 50));
    let view: EditorView;
    try {
      view = mountState(EditorState.create({ doc: SWEEP_DOC, extensions: [chanMarkdown(), listPrefixCaret()] }));
    } finally {
      clock.mockRestore();
    }
    const last = SWEEP_DOC.lastIndexOf("* last");
    expect(syntaxTree(view.state).length, "setup: the first parse stops before the last item").toBeLessThan(last);
    place(view, last);
    expect(head(view), "setup: a line the parse has not reached is no item yet").toBe(last);

    expect(forceParsing(view, SWEEP_DOC.length, 10_000)).toBe(true);

    expect(head(view)).toBe(last + 2);
  });
});
