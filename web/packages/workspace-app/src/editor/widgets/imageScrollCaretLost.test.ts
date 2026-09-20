// @vitest-environment jsdom
//
// Image-load scroll restore: an inline image has unknown height until its
// bytes arrive, so a load that completes after the user typed can push the
// caret out of the viewport with no transaction to re-anchor it. The load
// handler re-anchors, and it answers three questions in order: did the user
// just scroll on purpose, is the caret still visible, and where is it.
//
// jsdom has no layout, so the two measurements the handler reads
// (`coordsAtPos` and the scroller's rect) are supplied by the test. The
// decision the handler makes from them is the real thing.

import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { imageDecorations } from "./image";

const SCROLLER = { top: 0, bottom: 200 };

let view: EditorView | undefined;
let target: HTMLDivElement | undefined;

function mount(doc: string, caret: number): void {
  target = document.createElement("div");
  document.body.append(target);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [chanMarkdown(), imageDecorations({ getCurrentPath: () => null })],
    }),
    parent: target,
  });
}

/// Place the caret at `caretTop` in a 200px-tall scroller. The handler reads
/// the caret's coords and the scroller's rect and compares them; nothing
/// else about layout reaches it.
function stubLayout(caretTop: number, caretBottom: number): void {
  vi.spyOn(view!, "coordsAtPos").mockReturnValue({
    left: 0,
    right: 1,
    top: caretTop,
    bottom: caretBottom,
  });
  vi.spyOn(view!.scrollDOM, "getBoundingClientRect").mockReturnValue({
    ...SCROLLER,
    left: 0,
    right: 300,
    width: 300,
    height: SCROLLER.bottom - SCROLLER.top,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/// The image's `<img>`, which owns the one-shot load listener. Scoped to
/// the widget wrap: CM6 pads a replace widget with its own `cm-widgetBuffer`
/// images, and a bare `img` selector picks one of those instead.
function image(): HTMLImageElement {
  const img = view!.dom.querySelector(".cm-md-image-wrap img");
  expect(img).toBeInstanceOf(HTMLImageElement);
  return img as HTMLImageElement;
}

/// Fire the load the browser fires when the bytes arrive, and report what
/// the handler dispatched.
function load(): unknown[] {
  const dispatched: unknown[] = [];
  vi.spyOn(view!, "dispatch").mockImplementation((...specs: unknown[]) => {
    dispatched.push(...specs);
  });
  image().dispatchEvent(new Event("load"));
  return dispatched;
}

afterEach(() => {
  view?.destroy();
  target?.remove();
  view = undefined;
  target = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("an image that lands under the caret", () => {
  test("an off-screen caret is scrolled back into view", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(560, 580);
    const dispatched = load();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toHaveProperty("effects");
  });

  test("a visible caret is left where the user put it", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(40, 60);
    expect(load()).toEqual([]);
  });

  test("a caret far above the image is restored too, not only an adjacent one", () => {
    // The distance between the caret's line and the image's line is not a
    // reason to skip: a tall image rendering above pushes the whole layout
    // down, and the caret the user never moved goes off-screen with it.
    const doc = ["![a](b.png)", "one", "two", "three", "four", "five"].join("\n");
    mount(doc, doc.length);
    stubLayout(900, 920);
    expect(load()).toHaveLength(1);
  });

  test("a caret the handler cannot measure is left alone", () => {
    mount("![a](b.png)\ntext", 14);
    vi.spyOn(view!, "coordsAtPos").mockReturnValue(null);
    expect(load()).toEqual([]);
  });
});

describe("a user who just scrolled keeps their position", () => {
  test("a wheel on the scroller suppresses the restore", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(560, 580);
    view!.scrollDOM.dispatchEvent(new Event("wheel"));
    expect(load()).toEqual([]);
  });

  test("a paging key on the scroller suppresses the restore", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(560, 580);
    view!.scrollDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
    );
    expect(load()).toEqual([]);
  });

  test("a typing key is not a scroll, so the restore still runs", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(560, 580);
    view!.scrollDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(load()).toHaveLength(1);
  });

  test("the quiet window expires and the restore runs again", () => {
    mount("![a](b.png)\ntext", 14);
    stubLayout(560, 580);
    view!.scrollDOM.dispatchEvent(new Event("wheel"));
    const marked = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(marked + 901);
    expect(load()).toHaveLength(1);
  });
});
