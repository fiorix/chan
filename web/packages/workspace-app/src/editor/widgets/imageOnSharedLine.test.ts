// @vitest-environment jsdom
//
// Two images on one source line, the caret inside the second. The caret
// makes that image render as a preview block ABOVE the line, and a block
// widget's live position is the line's start, which is where the first
// image begins. Every action the preview offers resolves its own source
// range, so each one below asks for the second image and must not get the
// first: a read that copies the wrong markdown is wrong, and a write that
// moves the caret or the range into another image is worse.

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

const FIRST = "![one](1.png)";
const SECOND = "![two](2.png)";
const DOC = `${FIRST} ${SECOND}`;
/// Strictly inside the second image's URL slot, which is what puts it in
/// edit mode and renders the preview block.
const CARET = DOC.indexOf("2.png") + 3;

let view: EditorView | undefined;
let target: HTMLDivElement | undefined;

function mount(): void {
  target = document.createElement("div");
  document.body.append(target);
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: CARET },
      extensions: [
        chanMarkdown(),
        imageDecorations({ getCurrentPath: () => null }),
        imageCaretRedirect(),
      ],
    }),
    parent: target,
  });
}

/// The wrap that stands for one image. Both images have one, and the
/// preview's is the one the actions below are driven from.
function wrapFor(src: string): HTMLElement {
  const wraps = Array.from(
    view!.dom.querySelectorAll<HTMLElement & { _chanImg?: { src: string } }>(
      ".cm-md-image-wrap",
    ),
  );
  const found = wraps.find((el) => el._chanImg?.src === src);
  expect(found, `no image wrap for ${src}`).toBeTruthy();
  return found!;
}

/// Type in front of the first image. The line keeps both images and
/// their markdown, so the preview widget compares equal and its DOM,
/// with the position stamped on it, is reused while the document moved.
const INSERT = "xx";
function editBefore(): void {
  view!.dispatch({ changes: { from: 0, insert: INSERT } });
}

/// Where Edit lands the caret in the second image: one past the URL
/// slot's opening parenthesis. A range test alone cannot tell that from
/// the caret already sitting in the slot, and Edit doing nothing at all
/// would pass one.
function secondUrlCaret(): number {
  return view!.state.doc.toString().indexOf("2.png", secondRange().from) + 1;
}

function secondRange(): { from: number; to: number } {
  const from = view!.state.doc.toString().indexOf(SECOND);
  return { from, to: from + SECOND.length };
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

describe("the editing preview of the second image on a line", () => {
  test("the Copy button copies the second image's markdown", async () => {
    mount();
    wrapFor("2.png")
      .querySelector(".cm-md-image-copy")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(SECOND);
    });
  });

  test("Cmd+C on its ring copies the second image's markdown", async () => {
    mount();
    wrapFor("2.png").dataset.selected = "true";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(SECOND);
    });
  });

  test("right-click Copy reads the second image's markdown", () => {
    mount();
    wrapFor("2.png").dataset.selected = "true";
    expect(selectedImageMarkdown(view!)).toBe(SECOND);
  });

  test("Edit puts the caret in the second image's URL", () => {
    mount();
    view!.dispatch({ selection: { anchor: DOC.indexOf("2.png") + 4 } });
    wrapFor("2.png")
      .querySelector(".cm-md-image-action")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view!.state.selection.main.head).toBe(secondUrlCaret());
  });

  test("drag-to-move carries the second image's range", () => {
    mount();
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: (type: string, value: string) => data.set(type, value),
        setDragImage: () => {},
        effectAllowed: "",
      },
    });
    wrapFor("2.png").querySelector("img")!.dispatchEvent(event);
    expect(data.get(IMAGE_MOVE_MIME)).toBe(JSON.stringify(secondRange()));
  });
});

describe("the same preview after an edit in front of both images", () => {
  test("right-click Copy still reads the second image's markdown", () => {
    mount();
    const before = wrapFor("2.png");
    editBefore();
    // Neither position can answer alone now: the widget's live position
    // is the line's start, which is text, and its stamp points into the
    // first image. The caret is what says which image the preview is.
    expect(wrapFor("2.png")).toBe(before);
    wrapFor("2.png").dataset.selected = "true";
    expect(selectedImageMarkdown(view!)).toBe(SECOND);
  });

  test("Edit still puts the caret in the second image's URL", () => {
    mount();
    editBefore();
    wrapFor("2.png")
      .querySelector(".cm-md-image-action")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view!.state.selection.main.head).toBe(secondUrlCaret());
  });
});

describe("one selection entering both images", () => {
  test("Copy on the second preview still reads the second image", () => {
    mount();
    // A range over the whole line enters both images, so both render a
    // preview. Their live positions are the same line start and the
    // first image is what a walk from there reaches, for both of them;
    // only the position each widget was built with tells them apart.
    view!.dispatch({ selection: { anchor: 0, head: DOC.length } });
    wrapFor("2.png").dataset.selected = "true";
    expect(selectedImageMarkdown(view!)).toBe(SECOND);
  });
});
