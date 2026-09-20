// @vitest-environment jsdom
//
// The `@today` / `@date` macros inside a fenced code block. A fence is
// literal source: expanding a macro there rewrites the code sample the user
// is typing, which is exactly what a document describing these macros does.
// `enclosingFence` is the predicate the format and list commands already ask.

import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { chanMarkdown } from "../markdown/grammar";
import { expandDateMacro } from "./date_macros";

let host: HTMLDivElement | undefined;
let view: EditorView | undefined;

/// A mounted markdown editor with the caret at the end of `doc`, parsed
/// synchronously so the fence lookup sees a populated tree.
function mount(doc: string): void {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [chanMarkdown()],
    }),
    parent: host,
  });
  forceParsing(view, view.state.doc.length, 5000);
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

describe("date macros inside a fenced code block", () => {
  test("@today stays literal", () => {
    const doc = "```text\n@today";
    mount(doc);
    const fired = expandDateMacro(view!);
    expect(view!.state.doc.toString()).toBe(doc);
    expect(fired).toBe(false);
  });

  test("@date stays literal and opens no picker", () => {
    const doc = "```text\n@date";
    mount(doc);
    // The @date picker anchors itself on the next animation frame, off
    // coordsAtPos, which jsdom cannot answer. Stub the frame after the
    // mount: a macro that does not fire schedules none.
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    const fired = expandDateMacro(view!);
    expect(view!.state.doc.toString()).toBe(doc);
    expect(fired).toBe(false);
    expect(frame).not.toHaveBeenCalled();
  });

  test("a closed fence keeps its macro literal", () => {
    const doc = "```text\n@today\n```\n";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("@today") + 6 },
      extensions: [chanMarkdown()],
    });
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({ state, parent: host });
    forceParsing(view, view.state.doc.length, 5000);
    const fired = expandDateMacro(view);
    expect(view.state.doc.toString()).toBe(doc);
    expect(fired).toBe(false);
  });
});

describe("date macros outside a fence", () => {
  test("@today still expands to a date", () => {
    mount("note @today");
    expect(expandDateMacro(view!)).toBe(true);
    expect(view!.state.doc.toString()).not.toContain("@today");
  });
});
