// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { afterEach, describe, expect, test } from "vitest";
import { renderMarkdown } from "../../api/markdown";
import { mouseDown, mouseMoveHeld, mouseUp } from "../../__tests__/pointer";
import { clickToPlaceCaret } from "../click_caret";
import { pointerHold } from "../decorations/selection";
import { chanMarkdown } from "../markdown/grammar";
import { tableDecorations } from "./table";

// A press CodeMirror takes measures text ranges, which jsdom does not lay out.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

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
function mountTable(
  doc: string,
  extensions: Extension[] = [],
): { parent: HTMLElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [chanMarkdown(), tableDecorations(), ...extensions],
    }),
  });
  if (!forceParsing(view, view.state.doc.length, 5000)) {
    throw new Error("parse did not complete within its budget");
  }
  return { parent, view };
}

function tableText(table: Element): string[][] {
  return Array.from(table.querySelectorAll("tr"), (row) =>
    Array.from(row.querySelectorAll("th, td"), (cell) =>
      cell.textContent ?? "",
    ),
  );
}

function expectTableMatchesMarkdown(
  source: string,
  expected: string[][],
): void {
  const { parent, view } = mountTable(source);
  const widget = parent.querySelector(".cm-md-table");
  expect(widget).toBeTruthy();

  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdown(source);
  const exported = rendered.querySelector("table");
  expect(exported).toBeTruthy();
  expect(tableText(widget!)).toEqual(expected);
  expect(tableText(widget!)).toEqual(tableText(exported!));

  view.destroy();
  parent.remove();
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

  test.each([
    {
      name: "two columns with a body at the document start and a tight heading",
      source: [
        "| | |",
        "|---|---|",
        "| A | B |",
        "# Foo",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["", ""],
        ["A", "B"],
      ],
    },
    {
      name: "one column without a body and a blank before the heading",
      source: ["| |", "|---|", "", "# Foo", "", "after"].join("\n"),
      expected: [[""]],
    },
    {
      name: "two columns without a body in the document middle",
      source: [
        "before",
        "",
        "| | |",
        "|---|---|",
        "# Foo",
        "",
        "after",
      ].join("\n"),
      expected: [["", ""]],
    },
    {
      name: "one column with a body in the document middle",
      source: [
        "before",
        "",
        "| |",
        "|---|",
        "| A |",
        "",
        "# Foo",
        "",
        "after",
      ].join("\n"),
      expected: [[""], ["A"]],
    },
    {
      name: "whitespace-only columns",
      source: [
        "|   | \t |",
        "|---|---|",
        "| A | B |",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["", ""],
        ["A", "B"],
      ],
    },
  ])("renders an empty header: $name", ({ source, expected }) => {
    expectTableMatchesMarkdown(source, expected);
  });

  test.each([
    {
      name: "middle header cell",
      source: [
        "| A |  | C |",
        "|---|---|---|",
        "| 1 | 2 | 3 |",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["A", "", "C"],
        ["1", "2", "3"],
      ],
    },
    {
      name: "first header cell",
      source: [
        "| | B | C |",
        "|---|---|---|",
        "| 1 | 2 | 3 |",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["", "B", "C"],
        ["1", "2", "3"],
      ],
    },
    {
      name: "last header cell",
      source: [
        "| A | B | |",
        "|---|---|---|",
        "| 1 | 2 | 3 |",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["A", "B", ""],
        ["1", "2", "3"],
      ],
    },
    {
      name: "middle body cell",
      source: [
        "| A | B | C |",
        "|---|---|---|",
        "| 1 |  | 3 |",
        "",
        "after",
      ].join("\n"),
      expected: [
        ["A", "B", "C"],
        ["1", "", "3"],
      ],
    },
  ])("preserves an empty $name", ({ source, expected }) => {
    expectTableMatchesMarkdown(source, expected);
  });

  test("keeps rows without outer pipes at their parser widths", () => {
    const source = [
      "A | B",
      "---|---",
      "1 | 2",
      "left | ",
      "",
      "after",
    ].join("\n");
    const { parent, view } = mountTable(source);
    const widget = parent.querySelector(".cm-md-table");

    expect(widget).toBeTruthy();
    expect(tableText(widget!)).toEqual([
      ["A", "B"],
      ["1", "2"],
      ["left"],
    ]);

    view.destroy();
    parent.remove();
  });

  test("keeps an escaped pipe aligned with markdown export", () => {
    const source = [
      "| A \\| B | C |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "after",
    ].join("\n");
    expectTableMatchesMarkdown(source, [
      ["A | B", "C"],
      ["1", "2"],
    ]);
  });

  test("keeps ragged short and long body rows at their source widths", () => {
    const source = [
      "| A | B | C |",
      "|---|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 | 5 | 6 |",
      "",
      "after",
    ].join("\n");
    const { parent, view } = mountTable(source);
    const widget = parent.querySelector(".cm-md-table");

    expect(widget).toBeTruthy();
    expect(tableText(widget!)).toEqual([
      ["A", "B", "C"],
      ["1", "2"],
      ["3", "4", "5", "6"],
    ]);

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
    // Build-time contract: Wysiwyg.svelte scrolls a wide table inside its wrap so prose wraps at page width; jsdom lays out nothing.
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
    // Build-time contract: Wysiwyg.svelte gives block-widget roots no vertical margin; jsdom lays out nothing.
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

describe("a press on a rendered cell", () => {
  const mounted: Array<{ parent: HTMLElement; view: EditorView }> = [];

  afterEach(() => {
    for (const { parent, view } of mounted.splice(0)) {
      view.destroy();
      parent.remove();
    }
  });

  /// The editor's pointer hold comes with the click handling, as in the
  /// WYSIWYG editor.
  function mountPressable(doc: string): { parent: HTMLElement; view: EditorView } {
    const m = mountTable(doc, [clickToPlaceCaret()]);
    mounted.push(m);
    return m;
  }

  function cellWithText(parent: HTMLElement, text: string): HTMLElement {
    const cell = Array.from(
      parent.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td"),
    ).find((c) => c.textContent === text);
    if (!cell) throw new Error(`no rendered cell reads ${JSON.stringify(text)}`);
    return cell;
  }

  test("keeps the grid drawn while held and shows its source at the release, the caret after the cell's text", () => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const cell = cellWithText(parent, "frontend");

    mouseDown(cell);

    expect(parent.querySelector(".cm-md-table")).toBeTruthy();
    expect(view.state.selection.main.head).toBe(TABLE_DOC.indexOf("frontend") + "frontend".length);

    mouseUp(cell);

    expect(parent.querySelector(".cm-md-table")).toBeNull();
    expect(parent.textContent).toContain("| @@Alice | frontend |");
    expect(view.state.selection.main.head).toBe(TABLE_DOC.indexOf("frontend") + "frontend".length);
  });

  test("keeps the hold through the focus the press gives an editor that had none", async () => {
    const { parent, view } = mountPressable(TABLE_DOC);
    expect(document.activeElement).not.toBe(view.contentDOM);
    const cell = cellWithText(parent, "frontend");
    const caret = TABLE_DOC.indexOf("frontend") + "frontend".length;

    mouseDown(cell);
    // The view reads the DOM selection back after it takes focus; wait for
    // its next measure so that read has happened before the release.
    await new Promise<void>((resolve) => view.requestMeasure({ read: () => null, write: () => resolve() }));

    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.head).toBe(caret);
    expect(parent.querySelector(".cm-md-table")).toBeTruthy();

    mouseUp(cell);

    expect(parent.querySelector(".cm-md-table")).toBeNull();
    expect(view.state.selection.main.head).toBe(caret);
  });

  test("selects nothing when the pointer moves during the press", () => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const cell = cellWithText(parent, "syseng");
    const caret = TABLE_DOC.indexOf("syseng") + "syseng".length;

    mouseDown(cell, { clientX: 40, clientY: 40 });
    mouseMoveHeld(cell, { clientX: 41, clientY: 40 });
    mouseMoveHeld(cell, { clientX: 80, clientY: 90 });

    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(caret);
    expect(parent.querySelector(".cm-md-table")).toBeTruthy();
    mouseUp(cell);
  });

  // `^` marks the expected caret in each source; the rendered cell is named
  // by the text the grid shows, so the parser's split of the row is pinned
  // rather than assumed.
  test.each([
    {
      name: "a cell after an escaped pipe",
      rows: ["| A \\| B^ | C |", "|---|---|", "| 1 | 2 |"],
      shown: "A | B",
    },
    {
      // The parser splits a body row at a pipe inside a code span, as GFM
      // does unless the pipe is escaped; the grid shows the two halves.
      name: "a cell split at a pipe inside a code span",
      rows: ["| x | y | w |", "|---|---|---|", "| `p^|q` | z |"],
      shown: "`p",
    },
    {
      name: "a body cell of a row without outer pipes",
      rows: ["A | B", "---|---", "1 | 2^"],
      shown: "2",
    },
    {
      name: "an empty cell, after its left delimiter",
      rows: ["| A | B | C |", "|---|---|---|", "| 1 |^  | 3 |"],
      shown: "",
    },
    {
      name: "a header cell",
      rows: ["| Name^ | Skills |", "|---|---|", "| a | b |"],
      shown: "Name",
    },
  ])("places the caret in $name", ({ rows, shown }) => {
    const marked = ["before", "", ...rows, "", "after"].join("\n");
    const caret = marked.indexOf("^");
    const doc = marked.replace("^", "");
    const { parent, view } = mountPressable(doc);
    const cell = cellWithText(parent, shown);

    mouseDown(cell);
    mouseUp(cell);

    expect(view.state.selection.main.head).toBe(caret);
  });

  // A cell's own press is a plain primary single press; these stay
  // CodeMirror's, which jsdom does not map to a position.
  test.each([
    { name: "a shift press, which extends the selection", init: { shiftKey: true } },
    { name: "the second press of a double click, which selects a word", init: { detail: 2 } },
    { name: "a secondary press", init: { button: 2, buttons: 2 } },
  ])("leaves $name on a cell to CodeMirror", ({ init }) => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const cell = cellWithText(parent, "frontend");

    mouseDown(cell, init);
    mouseUp(cell);

    expect(view.state.selection.main.head, "the cell's caret").not.toBe(TABLE_DOC.indexOf("frontend") + "frontend".length);
  });

  /// jsdom lays out nothing: a 300 by 120 border box at (10, 20) whose client
  /// box is 12 pixels narrower and shorter, the scrollbars' share.
  function scrollable(parent: HTMLElement): HTMLElement {
    const wrap = parent.querySelector<HTMLElement>(".cm-md-table-wrap")!;
    wrap.getBoundingClientRect = () => new DOMRect(10, 20, 300, 120);
    Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 288 });
    Object.defineProperty(wrap, "clientHeight", { configurable: true, value: 108 });
    return wrap;
  }

  test.each([
    { name: "on the horizontal scrollbar", init: { clientX: 150, clientY: 134 } },
    { name: "on the vertical scrollbar", init: { clientX: 304, clientY: 60 } },
    { name: "repeated on the scrollbar, as the track's paging clicks are", init: { clientX: 150, clientY: 134, detail: 2 } },
  ])("a press $name starts no hold, places no caret and keeps the grid drawn", ({ init }) => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const wrap = scrollable(parent);
    const table = parent.querySelector(".cm-md-table");
    const before = view.state.selection;

    const press = mouseDown(wrap, init);

    expect(press.defaultPrevented, "the press's default").toBe(true);
    expect(view.state.field(pointerHold), "the hold").toBeNull();
    mouseUp(wrap);
    expect(view.state.selection).toBe(before);
    expect(parent.querySelector(".cm-md-table")).toBe(table);
  });

  test("a press on the wrap inside its client box, off the cells, stays CodeMirror's", () => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const wrap = scrollable(parent);

    mouseDown(wrap, { clientX: 150, clientY: 60 });

    expect(view.state.field(pointerHold), "CodeMirror's press starts the hold").not.toBeNull();
    mouseUp(wrap);
  });

  test("a secondary press on the scrollbar keeps its default", () => {
    const { parent } = mountPressable(TABLE_DOC);
    const wrap = scrollable(parent);

    const press = mouseDown(wrap, { clientX: 150, clientY: 134, button: 2, buttons: 2 });

    expect(press.defaultPrevented).toBe(false);
    mouseUp(wrap);
  });

  test("resolves the cell against the current document after an edit above the table", () => {
    const { parent, view } = mountPressable(TABLE_DOC);
    const cell = cellWithText(parent, "syseng");

    view.dispatch({ changes: { from: 0, insert: "a new first line\n" } });
    // The widget keeps its DOM across the edit, so the cell's element carries
    // no document offset of its own.
    expect(cellWithText(parent, "syseng")).toBe(cell);

    mouseDown(cell);
    mouseUp(cell);

    const doc = view.state.doc.toString();
    expect(view.state.selection.main.head).toBe(doc.indexOf("syseng") + "syseng".length);
  });
});
