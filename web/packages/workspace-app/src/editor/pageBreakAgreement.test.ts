// @vitest-environment jsdom
//
// One corpus, five surfaces, one answer per source line.
//
// A page break is decided independently by the slides regex, the source
// editor's divider, the deck split, the rendered DOM's class list, and the
// document PDF path, and per-surface tests are what let those five drift
// apart. Each case below runs one fixture through all five and asserts they
// return the same verdict, so a fix is only a fix when every surface moves
// together.
//
// The owner's ruling is the narrow one: `<hr class="chan-page-break">` is
// the page break, anything else is a near miss that gets normalized on
// write, and `@pagebreak` is an authoring macro that expands to the marker
// rather than a break in its own right. Rows the ruling settles pin their
// verdict; rows it leaves open assert agreement alone and are listed in the
// task-back.
//
// jsdom lays nothing out, so the document PDF path gets stubbed block rects
// and a page tall enough that only a forced break can cut. That is the
// whole of what is faked: the normalization, the render, the measurement
// and the pagination are the product's own.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { chanMarkdown } from "./markdown/grammar";
import { PAGE_BREAK_RE, splitSlidePages } from "./slides";
import { expandPageBreakMacro, isPageBreakLine } from "./commands/page_break";
import { buildDocDom } from "./doc_dom";
import {
  measureDocBlocks,
  normalizeDocPageBreaks,
  paginateDocBlocks,
} from "./pdf_pages";

const MARKER = '<hr class="chan-page-break">';
const BLOCK_HEIGHT_PX = 100;
const TALL_PAGE_PX = 10_000;

/// A corpus row: the body between "before" and "after", and the one line
/// whose page-break-ness the per-line detectors are asked about.
type Row = {
  name: string;
  body: string[];
  line: string;
  /// The verdict the ruling settles on, or undefined where it does not and
  /// the row asserts agreement alone.
  expected?: boolean;
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
  },
  {
    name: "single quotes and a self-closing slash",
    body: ["<hr class='chan-page-break'/>"],
    line: "<hr class='chan-page-break'/>",
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
];

let host: HTMLElement | undefined;

function source(row: Row): string {
  return ["before", "", ...row.body, "", "after"].join("\n");
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

/// Does the document PDF path cut? Normalization, render, measurement and
/// pagination are the product's; only the block rects are supplied.
function documentPdfCuts(markdown: string): boolean {
  const content = renderedDom(normalizeDocPageBreaks(markdown));
  stubBlockRects(content);
  const windows = paginateDocBlocks(measureDocBlocks(content), TALL_PAGE_PX);
  return windows.length > 1;
}

/// What each surface answers for one row.
function verdicts(row: Row): Record<string, boolean> {
  const markdown = source(row);
  const domContent = renderedDom(markdown);
  const domClass = Array.from(domContent.querySelectorAll("hr")).some((hr) =>
    hr.classList.contains("chan-page-break"),
  );
  host?.remove();
  host = undefined;
  return {
    slidesRegex: PAGE_BREAK_RE.test(row.line),
    editorDivider: isPageBreakLine(row.line),
    deckCut: splitSlidePages(markdown).length > 1,
    domClass,
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
    const answers = verdicts(row);
    if (row.expected === undefined) {
      // The ruling does not settle this row; agreement is still required.
      expect(new Set(Object.values(answers)).size).toBe(1);
      return;
    }
    expect(answers).toEqual({
      slidesRegex: row.expected,
      editorDivider: row.expected,
      deckCut: row.expected,
      domClass: row.expected,
      documentPdfCut: row.expected,
    });
  });
});

describe("a fenced code block survives the export", () => {
  test("the exported code sample still reads as the macro the author typed", () => {
    const markdown = ["before", "", "```text", "@pagebreak", "```", "", "after"].join(
      "\n",
    );
    const content = renderedDom(normalizeDocPageBreaks(markdown));
    expect(content.querySelector("code")?.textContent).toContain("@pagebreak");
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
