// @vitest-environment jsdom
//
// Every image action resolves the image's source range from a position
// captured when the widget was built. An edit anywhere above the image
// moves the image and leaves that capture behind, and because the widget
// compares equal the DOM (and the position stamped on it) is reused. Each
// test below types one character above the image and then takes one action.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import {
  IMAGE_MOVE_MIME,
  imageCaretRedirect,
  imageDecorations,
  selectedImageMarkdown,
} from "./image";

const writeClipboardText = vi.fn(async (_text: string) => {});
vi.mock("../../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/desktop")>()),
  writeClipboardText: (text: string) => writeClipboardText(text),
}));

const IMAGE = "![a](b.png)";
const DOC = `top\n${IMAGE}`;
const INSERT = "xxxx";

let view: EditorView | undefined;
let target: HTMLDivElement | undefined;

function mount(): void {
  target = document.createElement("div");
  document.body.append(target);
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        chanMarkdown(),
        imageDecorations({ getCurrentPath: () => null }),
        imageCaretRedirect(),
      ],
    }),
    parent: target,
  });
}

/// Type above the image. The image keeps its markdown, so the widget
/// compares equal and its DOM survives; only the document moved.
function editAbove(): void {
  view!.dispatch({ changes: { from: 0, insert: INSERT } });
}

/// The image's source range in the document as it stands now.
function imageRange(): { from: number; to: number } {
  const from = view!.state.doc.toString().indexOf(IMAGE);
  return { from, to: from + IMAGE.length };
}

function wrap(): HTMLElement {
  const el = view!.dom.querySelector<HTMLElement>(".cm-md-image-wrap");
  expect(el).toBeTruthy();
  return el!;
}

function ringSelect(): void {
  wrap().dataset.selected = "true";
}

beforeEach(() => {
  writeClipboardText.mockClear();
});

afterEach(() => {
  view?.destroy();
  target?.remove();
  view = undefined;
  target = undefined;
  document.body.innerHTML = "";
});

describe("an image action after an edit above the image", () => {
  test("Edit puts the caret in the image's URL", () => {
    mount();
    editAbove();
    wrap()
      .querySelector(".cm-md-image-action")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const { from, to } = imageRange();
    const head = view!.state.selection.main.head;
    expect(head).toBeGreaterThan(from);
    expect(head).toBeLessThan(to);
  });

  test("the Copy button copies the image's markdown", async () => {
    mount();
    editAbove();
    wrap()
      .querySelector(".cm-md-image-copy")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(IMAGE);
    });
  });

  test("Cmd+C copies the image's markdown", async () => {
    mount();
    editAbove();
    ringSelect();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(IMAGE);
    });
  });

  test("right-click Copy reads the image's markdown", () => {
    mount();
    editAbove();
    ringSelect();
    expect(selectedImageMarkdown(view!)).toBe(IMAGE);
  });

  test("drag-to-move carries the image's current range", () => {
    mount();
    editAbove();
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: (type: string, value: string) => data.set(type, value),
        setDragImage: () => {},
        effectAllowed: "",
      },
    });
    wrap().querySelector("img")!.dispatchEvent(event);
    expect(data.get(IMAGE_MOVE_MIME)).toBe(JSON.stringify(imageRange()));
  });

  test("the widget's DOM is the same element after the edit", () => {
    mount();
    const before = wrap();
    editAbove();
    // The other tests here are only about a stale position if the DOM
    // that carries it survives. Were the widget to compare unequal
    // across the edit, CodeMirror would rebuild it with a fresh stamp
    // and every one of them would pass without resolving anything.
    expect(wrap()).toBe(before);
  });

  test("the selection ring lights up at the image's boundary", () => {
    mount();
    editAbove();
    view!.dispatch({ selection: { anchor: imageRange().from } });
    expect(wrap().dataset.selected).toBe("true");
  });
});

describe("the same actions before any edit", () => {
  test("Edit, right-click Copy and the ring all work on the captured position", () => {
    mount();
    ringSelect();
    expect(selectedImageMarkdown(view!)).toBe(IMAGE);
    view!.dispatch({ selection: { anchor: imageRange().from } });
    expect(wrap().dataset.selected).toBe("true");
    wrap()
      .querySelector(".cm-md-image-action")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const { from, to } = imageRange();
    const head = view!.state.selection.main.head;
    expect(head).toBeGreaterThan(from);
    expect(head).toBeLessThan(to);
  });
});
