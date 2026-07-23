// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import {
  expandPageBreakMacro,
  isPageBreakLine,
  pageBreakDecorations,
  PAGE_BREAK_MARKER,
} from "./page_break";

let host: HTMLDivElement;
let view: EditorView;

function mount(doc: string, caret: number): void {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
    }),
    parent: host,
  });
}

afterEach(() => {
  view?.destroy();
  host?.remove();
});

describe("expandPageBreakMacro", () => {
  test("expands @pagebreak on its own line", () => {
    const doc = "@pagebreak";
    mount(doc, doc.length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${PAGE_BREAK_MARKER}\n\n`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  test("supports @break as a short alias", () => {
    const doc = "@break";
    mount(doc, doc.length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${PAGE_BREAK_MARKER}\n\n`);
  });

  test("reuses an existing blank separator below an own-line trigger", () => {
    const doc = "@pagebreak\n\n# Next\n\nbody";
    mount(doc, "@pagebreak".length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `${PAGE_BREAK_MARKER}\n\n# Next\n\nbody`,
    );
    expect(view.state.selection.main.head).toBe(
      `${PAGE_BREAK_MARKER}\n`.length,
    );
  });

  test("adds only the blank separator when the trigger ends a line", () => {
    const doc = "before @pagebreak\nnext";
    mount(doc, "before @pagebreak".length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n\nnext`,
    );
    expect(view.state.selection.main.head).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n`.length,
    );
  });

  test("adds nothing when the line break and blank separator exist", () => {
    const doc = "before @pagebreak\n\n# Next";
    mount(doc, "before @pagebreak".length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n\n# Next`,
    );
    expect(view.state.selection.main.head).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n`.length,
    );
  });

  test("normalizes a mid-paragraph trigger into a block marker", () => {
    const doc = "before @pagebreak after";
    mount(doc, "before @pagebreak".length);

    expect(expandPageBreakMacro(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n\nafter`,
    );
    expect(view.state.selection.main.head).toBe(
      `before\n\n${PAGE_BREAK_MARKER}\n\n`.length,
    );
  });

  test("falls through when the trigger is embedded in another token", () => {
    const doc = "before@pagebreak";
    mount(doc, doc.length);

    expect(expandPageBreakMacro(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("isPageBreakLine", () => {
  test("matches the persisted marker", () => {
    expect(isPageBreakLine(PAGE_BREAK_MARKER)).toBe(true);
    expect(isPageBreakLine('<hr class="other">')).toBe(false);
  });
});

describe("pageBreakDecorations", () => {
  test("renders the persisted marker as a page-break divider", () => {
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({
      state: EditorState.create({
        doc: `before\n${PAGE_BREAK_MARKER}\nafter`,
        selection: { anchor: 0 },
        extensions: [pageBreakDecorations()],
      }),
      parent: host,
    });

    expect(host.querySelector(".cm-md-page-break-label")?.textContent).toBe(
      "Page break",
    );
  });
});
