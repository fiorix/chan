// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { tableDecorations } from "./table";

const TABLE_DOC = [
  "before",
  "",
  "| Name | Skills |",
  "|------|--------|",
  "| @@Alice | frontend |",
  "| @@Bob | syseng |",
  "",
  "after",
].join("\n");

/// Mount an editor over `doc` with the table decorations and force the parse
/// through the document before returning. The initial parse at state creation
/// runs under a small wall-clock budget, so on a cold or loaded worker the
/// tree - and therefore the decoration set scanned from it - can be
/// incomplete at mount; the tests assert what the widget renders, not how
/// fast the machine parsed.
function mountTable(doc: string): { parent: HTMLElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [chanMarkdown(), tableDecorations()],
    }),
  });
  if (!forceParsing(view, view.state.doc.length, 5000)) {
    throw new Error("parse did not complete within its budget");
  }
  return { parent, view };
}

describe("tableDecorations", () => {
  test("renders a pipe table as a block widget without throwing", () => {
    const { parent, view } = mountTable(TABLE_DOC);

    expect(parent.querySelector(".cm-md-table")).toBeTruthy();
    expect(parent.textContent).toContain("@@Alice");
    expect(view.state.doc.toString()).toBe(TABLE_DOC);

    view.destroy();
    parent.remove();
  });

  test("bold in a cell renders as <strong>", () => {
    const { parent, view } = mountTable(
      [
        "before",
        "",
        "| Name | Note |",
        "|------|------|",
        "| Alice | **bold** |",
        "",
        "after",
      ].join("\n"),
    );

    const strong = parent.querySelector(".cm-md-table td strong");
    expect(strong).toBeTruthy();
    expect(strong?.textContent).toBe("bold");

    view.destroy();
    parent.remove();
  });

  test("a table past the initial parse frontier renders once the parse completes", () => {
    // The parse run at state creation never covers more than the first 3000
    // characters, so a table this deep is deterministically absent from the
    // tree the decoration field first scans. The widget also sits far below
    // jsdom's rendered viewport, so the assertions read the decoration set
    // through the public atomicRanges facet instead of the DOM.
    const atomicCount = (view: EditorView): number =>
      view.state
        .facet(EditorView.atomicRanges)
        .reduce((n, ranges) => n + ranges(view).size, 0);

    const doc = "prose paragraph line\n".repeat(4000) + TABLE_DOC;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chanMarkdown(), tableDecorations()],
      }),
    });
    expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    expect(atomicCount(view)).toBe(0);
    // Completing the parse dispatches an effects-only transaction (the async
    // ParseWorker's shape: no doc change, no selection). The field must
    // rescan on the new tree, or the table would stay raw source until the
    // next edit or caret move.
    expect(forceParsing(view, view.state.doc.length, 5000)).toBe(true);
    expect(atomicCount(view)).toBe(1);
    view.destroy();
    parent.remove();
  });

  test("wide tables are contained so prose still wraps at page width", () => {
    const source = readFileSync("src/editor/Wysiwyg.svelte", "utf8");

    expect(source).toMatch(/\.cm-content\)[\s\S]{1,500}min-width: 0;/);
    expect(source).toMatch(
      /\.cm-md-table-wrap\)[\s\S]{1,300}width: 100%;[\s\S]{1,300}max-width: 100%;[\s\S]{1,300}min-width: 0;[\s\S]{1,300}overflow-x: auto;[\s\S]{1,300}contain: inline-size;/,
    );
    expect(source).toMatch(
      /\.cm-md-table\)[\s\S]{1,500}width: max-content;[\s\S]{1,200}min-width: 100%;/,
    );
  });

  test("block-widget roots carry no vertical margins", () => {
    // CM6's height map measures block widgets via getBoundingClientRect,
    // which excludes margins. A vertical margin on a block-widget root
    // shifts every later block's height-map band off its visual rect, so
    // clicks below the widget resolve to the wrong line (worst right after
    // a table, where the next line is usually a heading). Vertical spacing
    // on these roots must be padding.
    const source = readFileSync("src/editor/Wysiwyg.svelte", "utf8");
    const roots = [
      ".cm-md-table-wrap",
      ".cm-md-diagram-rendered",
      '.cm-md-image-wrap[data-editing="true"]',
      ".cm-md-page-break",
    ];

    for (const root of roots) {
      const escaped = root.replace(/[.[\]"]/g, (ch) => `\\${ch}`);
      const rule = new RegExp(`${escaped}\\)\\s*\\{([^}]*)\\}`).exec(source);
      expect(rule, `rule for ${root}`).toBeTruthy();
      const body = rule![1].replace(/\/\*[\s\S]*?\*\//g, "");
      expect(body, `${root} must not set margin-top`).not.toMatch(
        /margin-top\s*:/,
      );
      expect(body, `${root} must not set margin-bottom`).not.toMatch(
        /margin-bottom\s*:/,
      );
      // Shorthand margin is only safe when the vertical component is 0.
      const shorthand = /margin\s*:\s*([^;]+);/.exec(body);
      if (shorthand) {
        expect(shorthand[1].trim(), `${root} margin shorthand`).toMatch(
          /^0(px)?( |$)/,
        );
      }
    }
  });
});
