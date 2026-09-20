// `pasteInsertPos` gates the caret on `view.hasFocus`: trust the
// caret only when the editor is focused, otherwise append at the
// end of the document so a paste into an unfocused editor never
// clobbers the first row.

import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildImageInsert, moveImageSource, pasteInsertPos } from "./image_drop";

/// Build a view over `doc` with the caret at `head` and a forced
/// `hasFocus`. CM6's `hasFocus` reads the DOM in jsdom; we override it
/// so the test exercises the branch deterministically without a real
/// focus event.
function viewWith(doc: string, head: number, hasFocus: boolean): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head },
    }),
  });
  Object.defineProperty(view, "hasFocus", {
    get: () => hasFocus,
    configurable: true,
  });
  return view;
}

describe("pasteInsertPos", () => {
  const doc = "# Title\n\nbody line\n";

  test("focused editor: insert at the caret", () => {
    const head = 3; // mid-title
    const view = viewWith(doc, head, true);
    expect(pasteInsertPos(view)).toBe(head);
    view.destroy();
  });

  test("unfocused editor with caret at 0: append at end, not row 1", () => {
    const view = viewWith(doc, 0, false);
    expect(pasteInsertPos(view)).toBe(doc.length);
    expect(pasteInsertPos(view)).not.toBe(0);
    view.destroy();
  });

  test("unfocused editor ignores a stale mid-doc caret too", () => {
    // Even with a non-zero stale caret, an unfocused paste appends:
    // the caret is not a reliable signal when focus is elsewhere.
    const view = viewWith(doc, 5, false);
    expect(pasteInsertPos(view)).toBe(doc.length);
    view.destroy();
  });
});

/// Plain view over `doc`; the move feature does not depend on focus.
function plainView(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

describe("moveImageSource (image drag across rows)", () => {
  test("move a standalone image down to a later row, no blank gap", () => {
    // Line 1: image (standalone). Line 3: target paragraph.
    const md = "![](a.png#w=250)\n\nlast line\n";
    const view = plainView(md);
    const imgFrom = 0;
    const imgTo = "![](a.png#w=250)".length;
    // Drop onto "last line" (offset within line 3).
    const dropPos = md.indexOf("last");
    moveImageSource(
      view,
      { from: imgFrom, to: imgTo },
      dropPos,
    );
    const out = view.state.doc.toString();
    // The standalone image line (and its newline) is gone; the image
    // now sits on its own row at the former "last line" position.
    expect(out).toBe("\n![](a.png#w=250)\nlast line\n");
    expect(out).not.toContain("![](a.png#w=250)\n\n"); // no double-source
    view.destroy();
  });

  test("move an image up to an earlier row", () => {
    const md = "first\n\n![](b.png)\n";
    const view = plainView(md);
    const imgFrom = md.indexOf("![](b.png)");
    const imgTo = imgFrom + "![](b.png)".length;
    const dropPos = 0; // onto "first"
    moveImageSource(
      view,
      { from: imgFrom, to: imgTo },
      dropPos,
    );
    const out = view.state.doc.toString();
    expect(out.startsWith("![](b.png)\nfirst")).toBe(true);
    // Source line removed; no stray "![](b.png)" left at the bottom.
    expect(out.match(/!\[\]\(b\.png\)/g)?.length).toBe(1);
    view.destroy();
  });

  test("dropping inside the source range is a no-op", () => {
    const md = "![](c.png)\n\nbody\n";
    const view = plainView(md);
    const imgFrom = 0;
    const imgTo = "![](c.png)".length;
    const before = view.state.doc.toString();
    moveImageSource(
      view,
      { from: imgFrom, to: imgTo },
      3, // inside the source range
    );
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  test("target list line keeps the image inline (trailing space)", () => {
    const md = "- a bullet\n\n![](d.png)\n";
    const view = plainView(md);
    const imgFrom = md.indexOf("![](d.png)");
    const imgTo = imgFrom + "![](d.png)".length;
    const dropPos = 2; // onto the bullet line
    moveImageSource(
      view,
      { from: imgFrom, to: imgTo },
      dropPos,
    );
    const out = view.state.doc.toString();
    // Inserted at the bullet line start with a trailing space (inline),
    // not a newline.
    expect(out.startsWith("![](d.png) - a bullet")).toBe(true);
    view.destroy();
  });

  test("image embedded in a text row moves the ENTIRE row", () => {
    // `text ![](..) text`: the surrounding text must travel with the
    // image, not be stranded while only the atom relocates.
    const md = "before ![](x.png#w=250) after\n\nlast line\n";
    const view = plainView(md);
    const imgFrom = md.indexOf("![](");
    const imgTo = imgFrom + "![](x.png#w=250)".length;
    const dropPos = md.indexOf("last");
    moveImageSource(view, { from: imgFrom, to: imgTo }, dropPos);
    const out = view.state.doc.toString();
    expect(out).toBe("\nbefore ![](x.png#w=250) after\nlast line\n");
    // Surrounding text moved with the image; nothing stranded / dropped.
    expect(out.match(/before .* after/)?.length).toBe(1);
    view.destroy();
  });

  test("image in a bullet item moves the entire bullet line", () => {
    const md = "- task ![](y.png) done\n\nlast\n";
    const view = plainView(md);
    const imgFrom = md.indexOf("![](");
    const imgTo = imgFrom + "![](y.png)".length;
    const dropPos = md.indexOf("last");
    moveImageSource(view, { from: imgFrom, to: imgTo }, dropPos);
    const out = view.state.doc.toString();
    // The `- ` marker travels too, so it stays a bullet at the new row.
    expect(out).toBe("\n- task ![](y.png) done\nlast\n");
    expect(out.match(/- task/g)?.length).toBe(1);
    view.destroy();
  });

  test("dropping a mixed-row image elsewhere on its own row is a no-op", () => {
    const md = "before ![](z.png) after\nother\n";
    const view = plainView(md);
    const imgFrom = md.indexOf("![](");
    const imgTo = imgFrom + "![](z.png)".length;
    const before = view.state.doc.toString();
    // Drop at "after" - same row as the image, outside the image range.
    moveImageSource(
      view,
      { from: imgFrom, to: imgTo },
      md.indexOf("after"),
    );
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  test("an empty source range is ignored", () => {
    const md = "![](e.png)\nbody\n";
    const view = plainView(md);
    const before = view.state.doc.toString();
    moveImageSource(view, { from: 5, to: 5 }, 12);
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });
});

// `buildImageInsert` turns a server upload path into the markdown image text
// inserted at the caret plus the caret offset within it.
describe("buildImageInsert", () => {
  const uploaded = ".Drafts/abc/img.png";

  describe("markdown image insert", () => {
    test("off a list line: a `![](rel#w=250)` embed + trailing newline", () => {
      const { text, caret } = buildImageInsert(uploaded, {
        currentPath: ".Drafts/abc/draft.md",
        onListLine: false,
      });
      // Relativized against the draft dir, default 250px width, own block.
      expect(text).toBe("![](./img.png#w=250)\n");
      // Caret lands just past the atom, BEFORE the trailing newline.
      expect(caret).toBe("![](./img.png#w=250)".length);
    });

    test("on a list line: trailing space instead of a newline", () => {
      const { text, caret } = buildImageInsert(uploaded, {
        currentPath: ".Drafts/abc/draft.md",
        onListLine: true,
      });
      expect(text).toBe("![](./img.png#w=250) ");
      expect(caret).toBe("![](./img.png#w=250)".length);
    });

    test("no currentPath: the upload path is used as-is, percent-encoded", () => {
      const { text } = buildImageInsert(".Drafts/abc/My Photo.png", {
        currentPath: null,
        onListLine: false,
      });
      // The space is percent-encoded so the ref round-trips the graph scan.
      expect(text).toBe("![](.Drafts/abc/My%20Photo.png#w=250)\n");
    });
  });
});
