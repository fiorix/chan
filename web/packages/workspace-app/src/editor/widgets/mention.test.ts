// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { mentionDecorations } from "./mention";

function mount(doc: string): { view: EditorView; cleanup: () => void } {
  const target = document.createElement("div");
  document.body.append(target);
  const state = EditorState.create({
    doc,
    extensions: [chanMarkdown(), mentionDecorations({ onMentionClick: () => {} })],
  });
  const view = new EditorView({ state, parent: target });
  return {
    view,
    cleanup: () => {
      view.destroy();
      target.remove();
    },
  };
}

function mentions(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".cm-md-mention")].map((el) => el.textContent ?? "");
}

afterEach(() => {
  document.body.innerHTML = "";
});

// A mention's click opens the contact, so a mention inside a link's label or
// an image's alt text would take the link's own click.
describe("mention decorations skip link and image labels", () => {
  test("a mention in a link label is not decorated", () => {
    const { view, cleanup } = mount("[@@bob](https://example.com)");
    expect(mentions(view)).toEqual([]);
    cleanup();
  });

  test("a mention in an image's alt text is not decorated", () => {
    const { view, cleanup } = mount("![@@bob](pic.png)");
    expect(mentions(view)).toEqual([]);
    cleanup();
  });

  test("a bare mention outside a link still decorates", () => {
    const { view, cleanup } = mount("ask @@bob about it");
    expect(mentions(view)).toEqual(["@@bob"]);
    cleanup();
  });
});
