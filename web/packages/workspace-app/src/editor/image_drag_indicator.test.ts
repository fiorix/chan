// @vitest-environment jsdom
//
// The image-move drag indicator: while a rendered image is dragged, the row
// it would land on is marked and a badge near the pointer names it. The drag
// events are dispatched on real editor views; jsdom has no layout, so each
// test decides which document position the pointer is over.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";

import { imageDropHandlers } from "./bubbles/image_drop";
import { imageDragIndicator, rowSnippet, startImageDragIndicator } from "./image_drag_indicator";
import { IMAGE_MOVE_MIME } from "./widgets/image";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

const DOC = "![](a.png)\nfirst\nsecond line";
const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  unmountWysiwygs();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("rowSnippet (badge text)", () => {
  test("trims and passes short lines through", () => {
    expect(rowSnippet("  hello world  ")).toBe("hello world");
  });

  test("truncates long lines with an ellipsis", () => {
    const long = "x".repeat(60);
    const out = rowSnippet(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(41); // 40 chars + ellipsis
  });

  test("an empty line reads as a placeholder, not blank", () => {
    expect(rowSnippet("   ")).toBe("(empty line)");
    expect(rowSnippet("")).toBe("(empty line)");
  });
});

/// A stand-in for the browser's DataTransfer, which jsdom lacks.
function dataTransfer(types: string[] = [IMAGE_MOVE_MIME], data: Record<string, string> = {}) {
  const store: Record<string, string> = { ...data };
  return {
    types: [...types],
    dropEffect: "none",
    effectAllowed: "all",
    setData(type: string, value: string) {
      store[type] = value;
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData: (type: string) => store[type] ?? "",
    setDragImage() {},
    files: [] as File[],
  };
}

type FakeTransfer = ReturnType<typeof dataTransfer>;

function drag(
  el: EventTarget,
  type: string,
  transfer: FakeTransfer,
  init: MouseEventInit & { relatedTarget?: EventTarget | null } = {},
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 50, ...init });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  el.dispatchEvent(event);
  return event;
}

/// Put the pointer over document position `pos`.
function pointAt(view: EditorView, pos: number): void {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
}

function badge(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".cm-md-image-drop-badge");
}

function markedRows(view: EditorView): Array<[string, boolean]> {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line.cm-md-image-drop-line")].map((line) => [
    line.textContent ?? "",
    line.classList.contains("cm-md-image-drop-noop"),
  ]);
}

/// A plain editor with the indicator and the drop handlers, a drag armed on
/// the image on line 1.
function armedView(): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [imageDragIndicator, imageDropHandlers({ getUploadDir: () => null })],
    }),
    parent,
  });
  views.push(view);
  startImageDragIndicator(view, { from: 0, to: 10 });
  return view;
}

describe("during an image move", () => {
  test("the row under the pointer is marked and the badge names it beside the pointer", () => {
    const view = armedView();
    expect(badge(), "armed, but no target yet").toBeNull();

    pointAt(view, DOC.indexOf("second"));
    const over = drag(view.contentDOM, "dragover", dataTransfer());
    expect(over.defaultPrevented, "the editor accepts the drop").toBe(true);
    expect(markedRows(view)).toEqual([["second line", false]]);
    expect(badge()?.textContent).toBe("line 3 · second line");
    expect(badge()?.style.left).toBe("54px");
    expect(badge()?.style.top).toBe("66px");
  });

  test("over the image's own row, the badge says it stays", () => {
    const view = armedView();
    pointAt(view, 2);
    drag(view.contentDOM, "dragover", dataTransfer());
    expect(markedRows(view)).toEqual([["![](a.png)", true]]);
    expect(badge()?.textContent).toBe("stays here");
    expect(badge()?.classList.contains("cm-md-image-drop-badge-noop")).toBe(true);
  });

  test("a drag that is not an image move shows nothing", () => {
    const view = armedView();
    pointAt(view, DOC.indexOf("second"));
    const over = drag(view.contentDOM, "dragover", dataTransfer(["Files"]));
    expect(over.defaultPrevented).toBe(false);
    expect(badge()).toBeNull();
  });

  test("leaving the editor hides the badge, and coming back shows it again", () => {
    const view = armedView();
    pointAt(view, DOC.indexOf("first"));
    const transfer = dataTransfer();
    drag(view.contentDOM, "dragover", transfer);

    drag(view.contentDOM, "dragleave", transfer, { relatedTarget: view.contentDOM.firstChild });
    expect(badge(), "crossing into a child is not leaving").not.toBeNull();
    drag(view.contentDOM, "dragleave", transfer, { relatedTarget: null });
    expect(badge()).toBeNull();
    expect(markedRows(view)).toEqual([]);

    drag(view.contentDOM, "dragover", transfer, { clientX: 41 });
    expect(badge()?.textContent).toBe("line 2 · first");
  });

  test("a drop clears it", () => {
    const view = armedView();
    pointAt(view, 2);
    const transfer = dataTransfer([IMAGE_MOVE_MIME], { [IMAGE_MOVE_MIME]: '{"from":0,"to":10}' });
    drag(view.contentDOM, "dragover", transfer);
    drag(view.contentDOM, "drop", transfer);
    expect(badge()).toBeNull();
    expect(markedRows(view)).toEqual([]);
  });

  test("an edit clears it", () => {
    const view = armedView();
    pointAt(view, DOC.indexOf("second"));
    drag(view.contentDOM, "dragover", dataTransfer());
    view.dispatch({ changes: { from: DOC.length, insert: "!" } });
    expect(badge()).toBeNull();
  });
});

describe("in the Wysiwyg editor", () => {
  test("dragging a rendered image arms the indicator, and its dragend clears it", async () => {
    const value = "![](photo.png)\n\ntext";
    const { view, content } = await mountWysiwyg({ value, currentPath: "notes/a.md" });
    const img = content.querySelector(".cm-md-image-wrap img");
    expect(img, "the image rendered").not.toBeNull();

    const transfer = dataTransfer([]);
    drag(img!, "dragstart", transfer);
    expect(transfer.types).toContain(IMAGE_MOVE_MIME);

    pointAt(view, value.indexOf("text"));
    drag(content, "dragover", transfer);
    expect(badge()?.textContent).toBe("line 3 · text");

    drag(img!, "dragend", transfer);
    expect(badge()).toBeNull();
  });
});
