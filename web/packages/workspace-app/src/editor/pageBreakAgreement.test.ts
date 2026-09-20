// @vitest-environment jsdom
//
// One corpus, four surfaces, one answer per source line.
//
// A page break is decided independently by the deck split, the source
// editor's divider, the rendered document's marker and the document PDF
// path, and per-surface tests are what let those four drift apart. Each
// case below runs one fixture through all four and asserts they return the
// same verdict, so a fix is only a fix when every surface moves together.
//
// Each surface is asked at its own entry point, and asked about a whole
// document rather than a line. A line cannot be asked on its own: the
// corpus holds the canonical marker twice, once inside a fenced code block
// and once outside it, with opposite verdicts, so any probe that sees only
// the line's text has to give both rows the same answer and one of them
// would be wrong whatever the code did.
//
// A page break is a top-level `hr` whose only attribute is a class of
// exactly `chan-page-break`. Anything else is a near miss, left as the
// author wrote it and cutting nothing, and `@pagebreak` is a typing
// macro that writes the marker rather than a break in its own right.
// Every row below pins the one verdict its line gets.
//
// jsdom lays nothing out, so the document PDF path gets stubbed block rects
// and a page tall enough that only a forced break can cut. That is the
// whole of what is faked: the render, the measurement and the pagination
// are the product's own.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { chanMarkdown } from "./markdown/grammar";
import { splitSlidePages } from "./slides";
import {
  expandPageBreakMacro,
  pageBreakDecorations,
} from "./commands/page_break";
import { PAGE_BREAK_CHILD_SELECTOR, PAGE_BREAK_SELECTOR } from "./page_break";
import { buildDocDom } from "./doc_dom";
import { measureDocBlocks, paginateDocBlocks } from "./pdf_pages";
import { exportMarkdownToPdf } from "./pdf_export";
import type { PageSnapshot } from "./pdf_snapshot";

const MARKER = '<hr class="chan-page-break">';
// A valid 1x1 PNG so pdf-lib accepts the fake raster.
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const BLOCK_HEIGHT_PX = 100;
const TALL_PAGE_PX = 10_000;

/// A corpus row: the body between "before" and "after", and the one line
/// the row is about, which is where the editor's divider is looked for.
type Row = {
  name: string;
  body: string[];
  line: string;
  /// The one verdict every surface owes this line.
  expected: boolean;
};

const ROWS: Row[] = [
  { name: "the canonical marker", body: [MARKER], line: MARKER, expected: true },
  {
    name: "a trailing extra class",
    body: ['<hr class="chan-page-break extra">'],
    line: '<hr class="chan-page-break extra">',
    expected: false,
  },
  {
    name: "a leading extra class",
    body: ['<hr class="extra chan-page-break">'],
    line: '<hr class="extra chan-page-break">',
    expected: false,
  },
  {
    name: "an uppercase tag and class",
    body: ['<HR CLASS="CHAN-PAGE-BREAK">'],
    line: '<HR CLASS="CHAN-PAGE-BREAK">',
    expected: false,
  },
  {
    name: "an extra attribute",
    body: ['<hr class="chan-page-break" data-x="1">'],
    line: '<hr class="chan-page-break" data-x="1">',
    expected: false,
  },
  {
    name: "single quotes and a self-closing slash",
    body: ["<hr class='chan-page-break'/>"],
    line: "<hr class='chan-page-break'/>",
    expected: true,
  },
  {
    name: "a written @pagebreak line",
    body: ["  @pagebreak  "],
    line: "  @pagebreak  ",
    expected: false,
  },
  { name: "a written @break line", body: ["@break"], line: "@break", expected: false },
  {
    name: "@pagebreak inside a fenced code block",
    body: ["```text", "@pagebreak", "```"],
    line: "@pagebreak",
    expected: false,
  },
  {
    name: "the canonical marker inside a fenced code block",
    body: ["```text", MARKER, "```"],
    line: MARKER,
    expected: false,
  },
  {
    // The composition marks the page breaks it finds. An author can
    // write that attribute too, and the sanitizer keeps it.
    name: "a forged mark beside the class",
    body: ['<hr class="chan-page-break" data-page-break>'],
    line: '<hr class="chan-page-break" data-page-break>',
    expected: false,
  },
  {
    name: "a forged mark alone",
    body: ["<hr data-page-break>"],
    line: "<hr data-page-break>",
    expected: false,
  },
  {
    name: "a marker inside a blockquote",
    body: [`> ${MARKER}`],
    line: `> ${MARKER}`,
    expected: false,
  },
  {
    name: "a marker indented four columns",
    body: [`    ${MARKER}`],
    line: `    ${MARKER}`,
    expected: false,
  },
  {
    name: "an unquoted class value",
    body: ["<hr class=chan-page-break>"],
    line: "<hr class=chan-page-break>",
    expected: true,
  },
];

let host: HTMLElement | undefined;

function source(row: Row): string {
  return ["before", "", ...row.body, "", "after"].join("\n");
}

/// Where the row's line sits in the document `source` builds.
function lineIndexOf(row: Row): number {
  return 2 + row.body.indexOf(row.line);
}

/// Give every top-level block a height so the pagination has something to
/// cut; the page is tall enough that only a forced break can.
function stubBlockRects(content: HTMLElement): void {
  const rect = (top: number, bottom: number): DOMRect =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(content, "getBoundingClientRect", {
    value: () => rect(0, 0),
    configurable: true,
  });
  Array.from(content.children).forEach((child, i) => {
    Object.defineProperty(child, "getBoundingClientRect", {
      value: () => rect(i * BLOCK_HEIGHT_PX, (i + 1) * BLOCK_HEIGHT_PX),
      configurable: true,
    });
  });
}

/// The rendered document, as the browser and the CSS selector see it.
function renderedDom(markdown: string): HTMLElement {
  const dom = buildDocDom({
    markdown,
    path: "notes/doc.md",
    theme: "light",
    contentWidthPx: 800,
  });
  host = document.createElement("div");
  host.appendChild(dom.root);
  document.body.appendChild(host);
  return dom.content;
}

/// Does the document PDF path cut? The render, the measurement and the
/// pagination are the product's; only the block rects are supplied.
function documentPdfCuts(markdown: string): boolean {
  const content = renderedDom(markdown);
  stubBlockRects(content);
  const windows = paginateDocBlocks(measureDocBlocks(content), TALL_PAGE_PX);
  return windows.length > 1;
}

/// Does the source editor draw its divider on the row's line? Asked of a
/// real view, because the divider is a block widget the decoration field
/// emits, and the field reads the whole document.
function editorDraws(markdown: string, lineIndex: number): boolean {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: markdown,
      extensions: [pageBreakDecorations()],
    }),
    parent,
  });
  try {
    const line = view.state.doc.line(lineIndex + 1);
    let drawn = false;
    view.state
      .facet(EditorView.decorations)
      .forEach((value) => {
        if (typeof value === "function") return;
        value.between(line.from, line.to, () => {
          drawn = true;
        });
      });
    return drawn;
  } finally {
    view.destroy();
    parent.remove();
  }
}

/// What each surface answers for one row.
function verdicts(row: Row): Record<string, boolean> {
  const markdown = source(row);
  const domContent = renderedDom(markdown);
  const domMarker = domContent.querySelector(PAGE_BREAK_CHILD_SELECTOR) !== null;
  host?.remove();
  host = undefined;
  return {
    deckCut: splitSlidePages(markdown).length > 1,
    editorDivider: editorDraws(markdown, lineIndexOf(row)),
    domMarker,
    documentPdfCut: documentPdfCuts(markdown),
  };
}

afterEach(() => {
  host?.remove();
  host = undefined;
  document.body.innerHTML = "";
});

describe("every surface gives one source line the same answer", () => {
  test.each(ROWS)("$name", (row) => {
    expect(verdicts(row)).toEqual({
      deckCut: row.expected,
      editorDivider: row.expected,
      domMarker: row.expected,
      documentPdfCut: row.expected,
    });
  });
});

describe("a fenced code block survives the export", () => {
  // Asked of the export itself, not of a composition built beside it: the
  // claim is that nothing between the author's file and the page rewrites
  // a line the author is showing rather than writing.
  //
  // What this can catch is a transform back between the file and the
  // composition: the code sample stops reading as the author typed it,
  // and a marker element appears on the page. What it cannot catch is a
  // page COUNT, because jsdom gives every block a zero rect, so a forced
  // cut lands at zero and pagination always emits its one tail window.
  test("the exported code sample still reads as the macro the author typed", async () => {
    const markdown = ["before", "", "```text", "@pagebreak", "```", "", "after"].join(
      "\n",
    );
    const pages: HTMLElement[] = [];
    await exportMarkdownToPdf(
      { path: "notes/doc.md", markdown, theme: "light" },
      {
        rasterize: async (root: HTMLElement): Promise<PageSnapshot> => {
          pages.push(root);
          return { png: TINY_PNG, widthPx: 2, heightPx: 2 };
        },
      },
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.querySelector("code")?.textContent).toContain("@pagebreak");
      expect(page.querySelector(PAGE_BREAK_SELECTOR)).toBeNull();
    }
  });
});

describe("the authoring macro", () => {
  let view: EditorView | undefined;
  let parent: HTMLElement | undefined;

  function mount(doc: string): EditorView {
    parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [chanMarkdown()],
      }),
      parent,
    });
    forceParsing(view, view.state.doc.length, 5000);
    return view;
  }

  afterEach(() => {
    view?.destroy();
    parent?.remove();
    view = undefined;
    parent = undefined;
  });

  test("@pagebreak on its own line expands to the canonical marker", () => {
    const v = mount("before\n\n@pagebreak");
    expect(expandPageBreakMacro(v)).toBe(true);
    expect(v.state.doc.toString()).toContain(MARKER);
  });

  test("@break expands to the canonical marker too", () => {
    const v = mount("before\n\n@break");
    expect(expandPageBreakMacro(v)).toBe(true);
    expect(v.state.doc.toString()).toContain(MARKER);
  });

  test("@pagebreak inside a fenced code block stays literal", () => {
    const doc = "```text\n@pagebreak";
    const v = mount(doc);
    const fired = expandPageBreakMacro(v);
    expect(v.state.doc.toString()).toBe(doc);
    expect(fired).toBe(false);
  });
});
