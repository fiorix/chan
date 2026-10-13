// @vitest-environment jsdom
//
// clickToPlaceCaret places the caret for a blank-area click (right of a short
// line, below the last line) that CodeMirror's precise hit-test misses.
// jsdom has no layout, so each test decides what the hit-test answers.

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { clickToPlaceCaret } from "./click_caret";
import { chanDecorations } from "./decorations";
import { decorationWalker } from "./decorations/walker";
import { chanMarkdown } from "./markdown/grammar";
import {
  installEditorDom,
  mountWysiwyg,
  recordTransactions,
  unmountWysiwygs,
} from "../__tests__/wysiwyg";

installEditorDom();

const PRECISE = 3;
const NEAR = 7;
const views: EditorView[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  unmountWysiwygs();
  vi.restoreAllMocks();
});

/// Answer the hit-test: `precise` for the precise query, NEAR for the
/// nearest-position query.
function hitTest(view: EditorView, precise: number | null, near: number | null = NEAR): void {
  vi.spyOn(view, "posAtCoords").mockImplementation(((_coords: unknown, isPrecise = true) =>
    isPrecise ? precise : near) as EditorView["posAtCoords"]);
}

function plainView(): { view: EditorView; placed: () => number[] } {
  const record = recordTransactions();
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: "short\nline two", extensions: [clickToPlaceCaret(), record.extension] }),
    parent,
  });
  views.push(view);
  return { view, placed: () => placedBy(record.transactions) };
}

function placedBy(transactions: readonly { selection?: { main: { anchor: number } }; isUserEvent(e: string): boolean }[]): number[] {
  return transactions
    .filter((tr) => tr.selection && tr.isUserEvent("select.pointer.blank"))
    .map((tr) => tr.selection!.main.anchor);
}

function click(view: EditorView, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    clientX: 200,
    clientY: 10,
    ...init,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("a click the precise hit-test misses", () => {
  test("places the caret at the nearest position", () => {
    const { view, placed } = plainView();
    hitTest(view, null);
    const event = click(view);
    expect(placed()).toEqual([NEAR]);
    expect(view.state.selection.main.head).toBe(NEAR);
    expect(event.defaultPrevented).toBe(true);
  });

  test("with no nearest position either, does nothing", () => {
    const { view, placed } = plainView();
    hitTest(view, null, null);
    click(view);
    expect(placed()).toEqual([]);
    expect(view.state.selection.main.head).toBe(0);
  });
});

describe("the handler stays out of the way", () => {
  test("of a click the precise hit-test resolves", () => {
    const { view, placed } = plainView();
    hitTest(view, PRECISE);
    click(view);
    expect(placed()).toEqual([]);
  });

  for (const [name, init] of [
    ["a shift-click", { shiftKey: true }],
    ["an alt-click", { altKey: true }],
    ["a meta-click", { metaKey: true }],
    ["a ctrl-click", { ctrlKey: true }],
    ["a double-click", { detail: 2 }],
    ["a right-click", { button: 2 }],
  ] as const) {
    test(`of ${name}`, () => {
      const { view, placed } = plainView();
      hitTest(view, null);
      click(view, init);
      expect(placed()).toEqual([]);
    });
  }
});

describe("in the Wysiwyg editor", () => {
  test("a blank-area click places the caret", async () => {
    const record = recordTransactions();
    const { view } = await mountWysiwyg({ value: "short\nline two", extraExtensions: [record.extension] });
    hitTest(view, null);
    click(view);
    expect(placedBy(record.transactions)).toContain(NEAR);
    expect(view.state.selection.main.head).toBe(NEAR);
  });
});

const MARKED_DOC = [
  "plain control",
  "**Reply:**",
  "**Reply:** after",
  "*Reply:*",
  "*Reply:* after",
  "`Reply:`",
  "`Reply:` after",
  "[reply](https://example.test)",
  "[reply](https://example.test) after",
  "<https://example.test>",
  "~~reply~~",
].join("\n");

function markedView(doc = MARKED_DOC, extra: Extension = []): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [chanMarkdown(), clickToPlaceCaret(), chanDecorations(), extra] }),
    parent,
  });
  views.push(view);
  return view;
}

function pointer(view: EditorView, anchor: number, head = anchor): void {
  view.dispatch({ selection: { anchor, head }, annotations: Transaction.userEvent.of("select.pointer") });
}

describe("pointer placement beside hidden closing marks", () => {
  test.each([
    ["bold at line end", 22, 24],
    ["bold mid-line", 33, 35],
    ["italic at line end", 49, 50],
    ["italic mid-line", 58, 59],
    ["code at line end", 73, 74],
    ["code mid-line", 82, 83],
    ["link label at line end", 96, 119],
    ["link URL tail", 98, 119],
    ["link label mid-line", 126, 149],
    ["autolink at line end", 177, 178],
    ["strike at line end", 186, 188],
  ])("maps %s from %i to %i", (_name, from, to) => {
    const view = markedView();
    pointer(view, from);
    expect(view.state.selection.main.head).toBe(to);
  });

  test("maps through nested hidden closers", () => {
    const doc = "plain control\n***x***";
    const view = markedView(doc);
    pointer(view, doc.indexOf("x") + 1);
    expect(view.state.selection.main.head).toBe(doc.length);
  });

  test("leaves a caret inside the content inside", () => {
    const view = markedView();
    pointer(view, 20);
    expect(view.state.selection.main.head).toBe(20);
  });

  test("maps the blank-area helper through the same hidden tail", () => {
    const view = markedView();
    hitTest(view, null, 22);
    click(view);
    expect(view.state.selection.main.head).toBe(24);
  });

  test("leaves the inner end when the marks were already shown", () => {
    const view = markedView();
    view.dispatch({ selection: { anchor: 20 } });
    pointer(view, 22);
    expect(view.state.selection.main.head).toBe(22);
  });

  test("leaves a link label caret inside its text", () => {
    const view = markedView();
    pointer(view, 95);
    expect(view.state.selection.main.head).toBe(95);
  });

  test.each([96, 98])("leaves a link tail caret at %i when the link was already shown", (offset) => {
    const view = markedView();
    view.dispatch({ selection: { anchor: 95 } });
    pointer(view, offset);
    expect(view.state.selection.main.head).toBe(offset);
  });

  test("maps only the closing parenthesis of an empty-label external link", () => {
    const doc = "plain control\n[](https://example.test)";
    const view = markedView(doc);
    pointer(view, doc.length - 1);
    expect(view.state.selection.main.head).toBe(doc.length);
  });

  test("leaves a pointer range from the inner end intact", () => {
    const view = markedView();
    pointer(view, 22, 20);
    expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([22, 20]);
  });

  test.each([22, 96])("leaves keyboard selection at %i", (offset) => {
    const view = markedView();
    view.dispatch({ selection: { anchor: offset }, annotations: Transaction.userEvent.of("select") });
    expect(view.state.selection.main.head).toBe(offset);
  });

  test.each(["[reply](inside.md)", "[reply][ref]\n\n[ref]: https://example.test"]) (
    "leaves a link with no hidden tail: %s", (doc) => {
      const view = markedView(`plain control\n${doc}`);
      pointer(view, "plain control\n[reply".length);
      expect(view.state.selection.main.head).toBe("plain control\n[reply".length);
    },
  );
});

function observedBoldView(): { view: EditorView; seen: number[] } {
  const seen: number[] = [];
  const probe = decorationWalker({ StrongEmphasis: ({ sel }) => { seen.push(sel.main.head); } });
  return { view: markedView(MARKED_DOC, probe), seen };
}

function press(view: EditorView): void {
  hitTest(view, 0);
  click(view);
}

describe("a pointer held over source that would reveal", () => {
  test("keeps the pre-press reveal through a pointer selection and redraws on release alone", () => {
    const { view, seen } = observedBoldView();
    press(view);
    pointer(view, 22);
    expect(seen.at(-1)).toBe(0);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(seen.at(-1)).toBe(24);
  });

  test("maps a second pointer selection of the same press", () => {
    const { view } = observedBoldView();
    press(view);
    pointer(view, 22);
    expect(view.state.selection.main.head).toBe(24);
    pointer(view, 20);
    expect(view.state.selection.main.head).toBe(20);
    pointer(view, 22);
    expect(view.state.selection.main.head).toBe(24);
  });

  test("ends the hold for a keyboard selection", () => {
    const { view, seen } = observedBoldView();
    press(view);
    pointer(view, 22);
    view.dispatch({ selection: { anchor: 20 }, annotations: Transaction.userEvent.of("select") });
    expect(seen.at(-1)).toBe(20);
    pointer(view, 22);
    expect(view.state.selection.main.head).toBe(22);
  });

  test.each([
    ["release outside", (_view: EditorView) => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }))],
    ["move with no button", (_view: EditorView) => document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 0 }))],
    ["window blur", (_view: EditorView) => window.dispatchEvent(new Event("blur"))],
    ["editor blur", (view: EditorView) => view.contentDOM.dispatchEvent(new FocusEvent("blur", { bubbles: false }))],
    ["drag start", (view: EditorView) => view.contentDOM.dispatchEvent(new Event("dragstart", { bubbles: true }))],
  ] as const)("ends on %s", (_name, end) => {
    const view = markedView();
    press(view);
    pointer(view, 22);
    end(view);
    pointer(view, 22);
    expect(view.state.selection.main.head).toBe(22);
  });

  test("removes document listeners when the view is destroyed", () => {
    const removed = vi.spyOn(document, "removeEventListener");
    const view = markedView();
    view.destroy();
    expect(removed.mock.calls.some(([name]) => name === "mouseup")).toBe(true);
    expect(removed.mock.calls.some(([name]) => name === "mousemove")).toBe(true);
  });
});
