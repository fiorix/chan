// @vitest-environment jsdom
//
// clickToPlaceCaret places the caret for a blank-area click (right of a short
// line, below the last line) that CodeMirror's precise hit-test misses, and
// otherwise stays out of the way. jsdom has no layout, so each test decides
// what the view's hit-test answers and reads the selection transactions the
// click produced: the handler's own carry no pointer user event.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { clickToPlaceCaret } from "./click_caret";
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

/// The anchors of selection transactions not made by CodeMirror's own pointer
/// handling.
function placedBy(transactions: readonly { selection?: { main: { anchor: number } }; isUserEvent(e: string): boolean }[]): number[] {
  return transactions
    .filter((tr) => tr.selection && !tr.isUserEvent("select.pointer"))
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
