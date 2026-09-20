// Trigger scans against the syntax tree: a bubble may not open from the
// characters before the caret when the tree says the caret sits inside
// markup the user has already written. Committing one of these bubbles
// replaces a range that starts inside an existing Image or Link node, so
// the Enter that ends a line destroys the line.

import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, test } from "vitest";
import { computeBubbleSpec } from "./triggers";
import { chanMarkdown } from "../markdown/grammar";

/// A parsed markdown state with the caret at `pos`. ensureSyntaxTree forces
/// the synchronous parse computeBubbleSpec's tree lookups need; no view.
function specAt(doc: string, pos: number) {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [chanMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 10000);
  return computeBubbleSpec(state);
}

describe("a caret inside a formed image or link opens no trigger bubble", () => {
  test("the alt text of a formed image", () => {
    const doc = "![alt](./img.png#w=250)";
    expect(specAt(doc, doc.indexOf("alt") + 2)).toBeNull();
  });

  test("the empty alt slot of a formed image", () => {
    const doc = "![](./img.png#w=250)";
    expect(specAt(doc, 2)).toBeNull();
  });

  test("the alt text of an image inside a link", () => {
    const doc = "[![alt](./img.png)](./doc.md)";
    expect(specAt(doc, doc.indexOf("alt") + 2)).toBeNull();
  });

  test("the label of a formed link", () => {
    const doc = "[see #topic](./doc.md)";
    expect(specAt(doc, doc.indexOf("#topic") + 6)).toBeNull();
  });

  test("a freshly typed `![query` still opens the image bubble", () => {
    const doc = "![pho";
    expect(specAt(doc, doc.length)).toMatchObject({
      kind: "image",
      query: "pho",
      templateMode: "wrap",
    });
  });

  test("a formed image's URL slot still opens the raw image bubble", () => {
    const doc = "![alt](./img.png)";
    expect(specAt(doc, doc.indexOf("./img.png") + 3)).toMatchObject({
      kind: "image",
      templateMode: "raw",
    });
  });
});

describe("a heading marker is not a tag trigger", () => {
  test.each(["#", "##", "###", "  ##"])(
    "the caret after %j opens no tag picker",
    (doc) => {
      expect(specAt(doc, doc.length)).toBeNull();
    },
  );

  test("a tag later in the line still opens the picker", () => {
    const doc = "see #topic";
    expect(specAt(doc, doc.length)).toMatchObject({ kind: "tag", query: "topic" });
  });
});
