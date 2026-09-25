// @vitest-environment jsdom
//
// A right-click in an editor leaves the selection alone, so the context menu
// acts on what the user had selected rather than on the word or line under
// the pointer. CodeMirror never selects on a right-button press; the browser
// does, unless the press is consumed, which is what rightClickNoSelect does.
// Mouse-downs are dispatched on real editor views and the tests read whether
// the default was prevented and what stayed selected.

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import SourceComponent from "./Source.svelte";
import { rightClickNoSelect } from "./right_click_no_select";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

const DOC = "alpha beta\ngamma delta";
const SELECTED = EditorSelection.single(0, 5);
const views: EditorView[] = [];
const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  for (const c of mounted.splice(0)) unmount(c);
  unmountWysiwygs();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/// Press `button` in the editor with `selection` set ("alpha" by default).
function pressOn(view: EditorView, button: number, selection: EditorSelection = SELECTED): MouseEvent {
  view.dispatch({ selection });
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button, detail: 1, clientX: 5, clientY: 5 });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function plainView(extensions = [rightClickNoSelect()]): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc: DOC, extensions }), parent });
  views.push(view);
  return view;
}

describe("rightClickNoSelect", () => {
  test("consumes a right-button press, keeping the selection", () => {
    const view = plainView();
    expect(pressOn(view, 2).defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
  });

  test("is what consumes it: CodeMirror alone leaves the press to the browser", () => {
    const view = plainView([]);
    expect(pressOn(view, 2).defaultPrevented).toBe(false);
  });

  test("leaves a left-button press to CodeMirror, which moves the caret", () => {
    const view = plainView();
    pressOn(view, 0, EditorSelection.single(DOC.length));
    expect(view.state.selection.main.head).not.toBe(DOC.length);
  });
});

describe("in the editors", () => {
  test("Wysiwyg keeps the selection through a right-button press", async () => {
    const { view } = await mountWysiwyg({ value: DOC });
    expect(pressOn(view, 2).defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
  });

  test("Source keeps the selection through a right-button press", () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(SourceComponent, {
        target,
        props: { autoFocus: false, path: "note.md", value: DOC } as ComponentProps<typeof SourceComponent>,
      }),
    );
    flushSync();
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(pressOn(view, 2).defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 5 });
  });
});
