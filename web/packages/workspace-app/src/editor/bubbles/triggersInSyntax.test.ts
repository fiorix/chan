// Trigger scans against the syntax tree: a bubble may not open from the
// characters before the caret when the tree says the caret sits inside
// markup the user has already written. Committing one of these bubbles
// replaces a range that starts inside an existing Image or Link node, so
// the Enter that ends a line destroys the line.

import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { parsedState } from "../../__tests__/parsedState";
import { computeBubbleSpec } from "./triggers";
import { chanMarkdown } from "../markdown/grammar";

/// A parsed markdown state with the caret at `pos`: computeBubbleSpec's tree
/// lookups read the state's tree, and there is no view to parse it.
function specAt(doc: string, pos: number) {
  const state = parsedState(
    EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [chanMarkdown()],
    }),
  );
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

  test("a tag typed against a following link keeps its picker", () => {
    // The caret sits at the link's start boundary, where none of the
    // link's text is behind it, so the scan reads only the tag.
    expect(specAt("#ta[x](u)", 3)).toMatchObject({ kind: "tag", query: "ta" });
  });

  test("a formed image's URL slot still opens the raw image bubble", () => {
    const doc = "![alt](./img.png)";
    expect(specAt(doc, doc.indexOf("./img.png") + 3)).toMatchObject({
      kind: "image",
      templateMode: "raw",
    });
  });
});

describe("a caret at the end of an external URL opens the link picker", () => {
  test.each([
    ["[label](https://chan.app)", "https://chan.app"],
    ["<https://chan.app>", "https://chan.app"],
    ["https://chan.app", "https://chan.app"],
    ["[mail](mailto:a@example.com)", "mailto:a@example.com"],
    ["[call](tel:+15551212)", "tel:+15551212"],
    ["[graph](chan://graph?s=one)", "chan://graph?s=one"],
  ])("%s", (doc, url) => {
    const from = doc.indexOf(url);
    expect(specAt(doc, from + url.length)).toMatchObject({
      kind: "wiki",
      templateMode: "raw",
      triggerStart: from,
      triggerEnd: from + url.length,
      query: url,
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

  test("a tag opening a line keeps its picker", () => {
    // `#t` cannot be a heading, so a query after whitespace alone is a
    // tag. A bare `#` still may be a heading, which is the case above.
    expect(specAt("#todo", 5)).toMatchObject({ kind: "tag", query: "todo" });
    expect(specAt("  #todo", 7)).toMatchObject({ kind: "tag", query: "todo" });
  });

  test("a query behind a second hash is still the marker", () => {
    expect(specAt("##todo", 6)).toBeNull();
  });
});
