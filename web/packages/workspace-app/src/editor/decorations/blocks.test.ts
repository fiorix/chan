// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";
// Build-time contract: Wysiwyg's stylesheet reads each --cm-md-* variable the decorations set on a line, in the rule keyed on that line's class; vitest drops component CSS.
import wysiwygSource from "../Wysiwyg.svelte?raw";

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

describe("list widgets", () => {
  test("render the bullet, ordered and task markers", () => {
    const { parent, view } = mountDecorated(
      "normal prose\n* bullet\n  - child\n1. ordered\n- [ ] task",
    );

    expect(parent.querySelector(".cm-md-ul-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-ol-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-list-marker")).toBeTruthy();
    expect(parent.querySelector(".cm-md-task-checkbox")).toBeTruthy();

    view.destroy();
    parent.remove();
  });

  test("each --cm-md-* variable a list line carries is read by the rule for that line's class", () => {
    const { parent, view } = mountDecorated("* l1\n  * l2\n    1. l3\n- [ ] task");
    const css = wysiwygSource.slice(wysiwygSource.indexOf("<style"));
    const handshakes: string[] = [];
    for (const line of parent.querySelectorAll<HTMLElement>(".cm-line")) {
      const names = [...(line.getAttribute("style") ?? "").matchAll(/(--cm-md-[\w-]+)\s*:/g)].map((m) => m[1]!);
      const classes = [...line.classList].filter((c) => c.startsWith("cm-md-"));
      for (const name of names) {
        for (const cls of classes) {
          const at = css.indexOf(`.cm-line.${cls})`);
          expect(at, `a stylesheet rule for .cm-line.${cls}`).toBeGreaterThan(-1);
          const body = css.slice(css.indexOf("{", at), css.indexOf("}", at));
          expect(body, `.cm-line.${cls} reads ${name}`).toContain(`var(${name}`);
          handshakes.push(`${cls} ${name}`);
        }
      }
    }
    expect(new Set(handshakes)).toEqual(new Set(["cm-md-list-hang --cm-md-list-level"]));

    view.destroy();
    parent.remove();
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
    expect(view.state.doc.toString()).toBe("one\n---\ntwo");

    view.destroy();
    parent.remove();
  });
});
