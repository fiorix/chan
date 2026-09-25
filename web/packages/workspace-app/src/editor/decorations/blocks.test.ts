// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";
// Build-time contract: Wysiwyg's list-layout CSS reads the theme's list tokens and the hang-column variables the decorations set; vitest drops component CSS.
import wysiwygSource from "../Wysiwyg.svelte?raw";

const removedListLineHook = ["cm", "md", "list", "line"].join("-");
const removedDepthHook = ["cm", "md", "list", "depth"].join("-");
const baseThemeSource = readFileSync("src/editor/themes/base.css", "utf8");
const googleDocsThemeSource = readFileSync("src/editor/themes/google_docs.css", "utf8");
const wordThemeSource = readFileSync("src/editor/themes/word.css", "utf8");

function mountDecorated(doc: string): { parent: HTMLDivElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [chanMarkdown(), chanDecorations()],
    }),
  });
  return { parent, view };
}

describe("list guide removal", () => {
  test("custom list widgets render without guide scaffolding", () => {
    const { parent, view } = mountDecorated(
      "normal prose\n* bullet\n  - child\n1. ordered\n- [ ] task",
    );

    expect(parent.querySelector(".cm-md-ul-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-ol-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-list-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-task-checkbox")).toBeTruthy();
    expect(parent.querySelector(`.${removedListLineHook}`)).toBeNull();
    expect(
      Array.from(parent.querySelectorAll(".cm-line")).some((line) =>
        Array.from(line.classList).some((cls) => cls.startsWith(removedDepthHook)),
      ),
    ).toBe(false);

    view.destroy();
    parent.remove();
  });

  test("list spacing is scoped to bullet glyphs and nested lines", () => {
    expect(baseThemeSource).toContain("--chan-editor-list-marker-family");
    expect(baseThemeSource).toContain("--chan-editor-list-marker-width: 2ch");
    expect(baseThemeSource).toContain("--chan-editor-list-marker-gap: 3ch");
    expect(baseThemeSource).toContain("--chan-editor-task-checkbox-width: 1em");
    expect(baseThemeSource).toContain("--chan-editor-list-glyph-scale: 0.5");
    expect(baseThemeSource).toContain("--chan-editor-list-square-glyph-scale: 0.44");
    expect(wysiwygSource).toContain(
      "--cm-md-list-marker-width: var(--chan-editor-list-marker-width, 2ch)",
    );
    expect(wysiwygSource).toContain(
      "--cm-md-list-marker-gap: var(--chan-editor-list-marker-gap, 3ch)",
    );
    expect(wysiwygSource).toContain(".cm-line.cm-md-list-hang");
    expect(wysiwygSource).toContain("--cm-md-list-hang-col: calc(");
    expect(wysiwygSource).toContain(
      "6px + (var(--cm-md-list-level, 0) + 1) * var(--cm-md-list-hang-col)",
    );
    expect(wysiwygSource).toContain(
      "text-indent: calc(-1 * var(--cm-md-list-hang-col))",
    );
    expect(wysiwygSource).toContain("width: var(--cm-md-list-marker-width)");
    expect(wysiwygSource).toContain("margin-right: var(--cm-md-list-marker-gap)");
    expect(wysiwygSource).toContain(
      "font-family: var(--chan-editor-list-marker-family, inherit)",
    );
    expect(wysiwygSource).toContain(
      "--cm-md-task-checkbox-width: var(--chan-editor-task-checkbox-width, 1em)",
    );
    expect(wysiwygSource).toContain(
      "transform: scale(var(--chan-editor-list-glyph-scale, 0.5))",
    );
    expect(wysiwygSource).toContain(
      "transform: scale(var(--chan-editor-list-square-glyph-scale, 0.44))",
    );
    expect(wysiwygSource).toContain(".cm-md-ol-marker");
    expect(wysiwygSource).toContain(".cm-md-list-marker");
    expect(wysiwygSource).toContain(".cm-md-ul-glyph");
  });

  test("Google Docs and Word inherit the shared list marker contract", () => {
    const tokens = [
      "--chan-editor-list-marker-family",
      "--chan-editor-list-marker-width",
      "--chan-editor-list-marker-gap",
      "--chan-editor-task-checkbox-width",
      "--chan-editor-list-glyph-scale",
      "--chan-editor-list-square-glyph-scale",
    ];
    for (const token of tokens) {
      expect(baseThemeSource).toContain(token);
      expect(googleDocsThemeSource).not.toContain(token);
      expect(wordThemeSource).not.toContain(token);
    }
    expect(googleDocsThemeSource).not.toContain(".cm-md-list-marker");
    expect(googleDocsThemeSource).not.toContain(".cm-md-ul-glyph");
    expect(wordThemeSource).not.toContain(".cm-md-list-marker");
    expect(wordThemeSource).not.toContain(".cm-md-ul-glyph");
  });
});

describe("list marker rendering (real positioned markers)", () => {
  test("top-level star bullet renders the disc GLYPH char; doc keeps `*`", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "* item",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    // The `*` is REPLACED by a real-width glyph widget rendering the disc
    // character. The rendered marker text is the glyph (not `*`), but the
    // DOCUMENT keeps the literal `*` (render-only replace).
    const marker = parent.querySelector(".cm-md-ul-glyph");
    expect(marker?.textContent).toBe("●");
    expect(marker?.classList.contains("cm-md-ul-disc")).toBe(true);
    expect(view.state.doc.toString()).toBe("* item");

    view.destroy();
    parent.remove();
  });

  test("`*` and `+` share the depth glyph; `-` stays a distinct dash", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    // `*` and `+` both render the depth-0 disc GLYPH (Google Docs keys the
    // glyph off depth, not the char). `-` stays literal in the shared
    // marker column.
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "* star\n+ plus\n- dash",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    const markers = Array.from(parent.querySelectorAll(".cm-md-ul-marker"));
    expect(markers.length).toBe(3);
    // `*` and `+` -> disc glyph widget (real ● character).
    expect(markers[0]?.classList.contains("cm-md-ul-disc")).toBe(true);
    expect(markers[0]?.textContent).toBe("●");
    expect(markers[1]?.classList.contains("cm-md-ul-disc")).toBe(true);
    expect(markers[1]?.textContent).toBe("●");
    expect(markers[2]?.classList.contains("cm-md-ul-hyphen")).toBe(true);
    expect(markers[2]?.classList.contains("cm-md-ul-glyph")).toBe(false);
    expect(markers[2]?.textContent).toBe("-");
    expect(view.state.doc.toString()).toBe("* star\n+ plus\n- dash");

    view.destroy();
    parent.remove();
  });

  test("hyphen list keeps the literal dash at every nesting depth", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "- l1\n  - l2\n    - l3",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    const markers = Array.from(parent.querySelectorAll(".cm-md-ul-marker"));
    expect(markers.length).toBe(3);
    for (const m of markers) {
      expect(m.classList.contains("cm-md-ul-hyphen")).toBe(true);
      expect(m.textContent).toBe("-");
    }
    expect(view.state.doc.toString()).toBe("- l1\n  - l2\n    - l3");

    view.destroy();
    parent.remove();
  });

  test("star bullet glyph cycles disc -> circle -> square by depth", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "* l1\n  * l2\n    * l3\n      * l4",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    const markers = Array.from(parent.querySelectorAll(".cm-md-ul-glyph"));
    // depth 0 disc ●, 1 circle ○, 2 square ■, 3 wraps back to disc ●.
    expect(markers[0]?.classList.contains("cm-md-ul-disc")).toBe(true);
    expect(markers[0]?.textContent).toBe("●");
    expect(markers[1]?.classList.contains("cm-md-ul-circle")).toBe(true);
    expect(markers[1]?.textContent).toBe("○");
    expect(markers[2]?.classList.contains("cm-md-ul-square")).toBe(true);
    expect(markers[2]?.textContent).toBe("■");
    expect(markers[3]?.classList.contains("cm-md-ul-disc")).toBe(true);
    expect(markers[3]?.textContent).toBe("●");
    // The document keeps the literal source chars (render-only replace).
    expect(view.state.doc.toString()).toBe(
      "* l1\n  * l2\n    * l3\n      * l4",
    );

    view.destroy();
    parent.remove();
  });

  test("keeps ordered marker text while placing it in the shared marker column", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "1. one\n2. two",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    const markers = Array.from(
      parent.querySelectorAll(".cm-md-ol-marker"),
    ).map((el) => el.textContent);
    expect(markers).toEqual(["1.", "2."]);
    // The whitespace between the marker and the item text is hidden
    // (render-only) so the text hangs at the fixed marker column; the rendered
    // marker and text sit adjacent while the source keeps the space intact.
    expect(parent.textContent).toContain("1.one");
    expect(parent.textContent).toContain("2.two");
    expect(view.state.doc.toString()).toBe("1. one\n2. two");

    view.destroy();
    parent.remove();
  });

  test("does not add a bullet glyph before task-list checkboxes", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "- [ ] task",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    expect(parent.querySelector(".cm-md-ul-marker")).toBeNull();
    expect(parent.querySelector(".cm-md-task-list-marker")).toBeNull();
    expect(parent.querySelector(".cm-md-task-checkbox-slot")).toBeTruthy();
    expect(parent.querySelector(".cm-md-list-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-task-checkbox")).toBeTruthy();
    expect(view.state.doc.toString()).toBe("- [ ] task");

    view.destroy();
    parent.remove();
  });

  test("tags every list line with its syntactic depth for the hanging indent", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "* l1\n  * l2\n    1. l3",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    // Every list line (all depths) gets the hang decoration; nesting is driven
    // by the item's syntactic depth via --cm-md-list-level, so the CSS indents
    // each level by one marker column.
    const hung = Array.from(parent.querySelectorAll(".cm-md-list-hang"));
    expect(hung.length).toBe(3);
    expect(hung[0]?.getAttribute("style")).toContain("--cm-md-list-level: 0");
    expect(hung[1]?.getAttribute("style")).toContain("--cm-md-list-level: 1");
    expect(hung[2]?.getAttribute("style")).toContain("--cm-md-list-level: 2");

    view.destroy();
    parent.remove();
  });
});

describe("horizontal rule source visibility", () => {
  test("leaves --- source text visible anywhere in the document", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "one\n---\ntwo",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    expect(parent.textContent).toContain("---");
    expect(parent.querySelector(".cm-md-hr")).toBeNull();
    expect(view.state.doc.toString()).toBe("one\n---\ntwo");

    view.destroy();
    parent.remove();
  });
});
