// @vitest-environment jsdom
//
// An image move carries a source range captured when the drag started.
// The range means nothing outside the view that captured it, and nothing
// after that view's document has changed, so the drop asks the live drag
// state, which only the view that armed it holds and which clears on any
// document change. Without that, dropping in a second pane moves
// whatever text happens to sit at those offsets there.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { imageDragIndicator } from "../image_drag_indicator";
import { imageDecorations, IMAGE_MOVE_MIME } from "../widgets/image";
import { imageDropHandlers } from "./image_drop";

const IMAGE = "![a](b.png)";
const DOC = `${IMAGE}\n\nlast line\n`;
const OTHER = "first line\n\nsecond line\n";

const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function mount(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        chanMarkdown(),
        imageDecorations({ getCurrentPath: () => null }),
        imageDragIndicator,
        imageDropHandlers({ getUploadDir: () => null }),
      ],
    }),
    parent: host,
  });
  views.push(view);
  return view;
}

/// Start a real drag from this view's image, which is what arms the
/// view's drag state and fills the payload.
function dragFrom(view: EditorView): string {
  const data = new Map<string, string>();
  const event = new Event("dragstart", { bubbles: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      setData: (type: string, value: string) => data.set(type, value),
      setDragImage: () => {},
      effectAllowed: "",
    },
  });
  view.dom.querySelector(".cm-md-image-wrap img")!.dispatchEvent(event);
  const payload = data.get(IMAGE_MOVE_MIME);
  expect(payload).toBeTruthy();
  return payload!;
}

/// Drop that payload on a view, at the position the pointer names.
function dropOn(view: EditorView, payload: string, at: number): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { getData: (type: string) => (type === IMAGE_MOVE_MIME ? payload : ""), files: [] },
  });
  Object.defineProperty(event, "clientX", { value: 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  const original = view.posAtCoords.bind(view);
  Object.defineProperty(view, "posAtCoords", {
    value: () => at,
    configurable: true,
  });
  view.contentDOM.dispatchEvent(event);
  Object.defineProperty(view, "posAtCoords", { value: original, configurable: true });
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const host of hosts.splice(0)) host.remove();
  document.body.innerHTML = "";
});

describe("a drop the view did not start", () => {
  test("another pane's document is untouched", () => {
    const a = mount(DOC);
    const b = mount(OTHER);
    const payload = dragFrom(a);
    const before = b.state.doc.toString();
    dropOn(b, payload, OTHER.indexOf("second"));
    expect(b.state.doc.toString()).toBe(before);
    expect(a.state.doc.toString()).toBe(DOC);
  });

  test("the view that started it still moves its own image", () => {
    const a = mount(DOC);
    const payload = dragFrom(a);
    dropOn(a, payload, DOC.indexOf("last"));
    expect(a.state.doc.toString()).not.toBe(DOC);
    expect(a.state.doc.toString()).toContain(IMAGE);
  });
});

describe("a drop whose offsets the document has outrun", () => {
  test("a change between dragstart and drop cancels the move", () => {
    const a = mount(DOC);
    const payload = dragFrom(a);
    a.dispatch({ changes: { from: 0, insert: "xxxx" } });
    const before = a.state.doc.toString();
    dropOn(a, payload, before.indexOf("last"));
    expect(a.state.doc.toString()).toBe(before);
  });
});
