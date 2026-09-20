// @vitest-environment jsdom
//
// GFM autolinks a bare URL written in an image's alt text, and the parser
// folds that link's URL element into the Image node. An Image can therefore
// hold two URL children, and only the one inside the parentheses is the
// image's source; the one in the alt text is prose.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { imageDecorations } from "./image";

const DOC = "![see https://example.com/x](shot.png)";

let view: EditorView | undefined;
let target: HTMLDivElement | undefined;

function mount(): void {
  target = document.createElement("div");
  document.body.append(target);
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: 0 },
      extensions: [
        chanMarkdown(),
        imageDecorations({ getCurrentPath: () => null }),
      ],
    }),
    parent: target,
  });
}

afterEach(() => {
  view?.destroy();
  target?.remove();
  view = undefined;
  target = undefined;
  document.body.innerHTML = "";
});

describe("an image whose alt text carries a bare URL", () => {
  test("the widget renders the URL in the parentheses", () => {
    mount();
    const wrap = view!.dom.querySelector<
      HTMLElement & { _chanImg?: { src: string } }
    >(".cm-md-image-wrap");
    expect(wrap).toBeTruthy();
    expect(wrap!._chanImg?.src).toBe("shot.png");
  });
});
