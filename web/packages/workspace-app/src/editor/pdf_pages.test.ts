// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
  DECK_LAYOUT_PADDING_PX,
  DECK_LAYOUT_VIEWPORT_PX,
  DECK_PAGE_BOX_PX,
  DOC_CONTENT_WIDTH_PX,
  buildDocPageElements,
  buildSlidePageDom,
  deckPageLayout,
  deckSlideLayoutBox,
  docPageGeometry,
  normalizeDocPageBreaks,
  paginateDocBlocks,
  slideBoxFit,
  type DocBlockRect,
} from "./pdf_pages";
import { RASTER_SCALE } from "./pdf_snapshot";
import { type SlideAspectRatio } from "./slides";

function block(
  top: number,
  bottom: number,
  opts: Partial<DocBlockRect> = {},
): DocBlockRect {
  return { top, bottom, heading: false, pageBreak: false, ...opts };
}

describe("docPageGeometry", () => {
  test("derives point/pixel geometry from A4 and the fixed content width", () => {
    const g = docPageGeometry();
    expect(g.printableWidthPt).toBeCloseTo(595.28 - 2 * 46.8, 2);
    expect(g.printableHeightPt).toBeCloseTo(841.89 - 2 * 46.8, 2);
    expect(g.ptPerPx).toBeCloseTo(g.printableWidthPt / DOC_CONTENT_WIDTH_PX, 6);
    expect(g.pageContentHeightPx).toBeCloseTo(
      g.printableHeightPt / g.ptPerPx,
      4,
    );
  });
});

describe("paginateDocBlocks", () => {
  const PAGE = 1000;

  test("everything fitting yields one window ending at the last bottom", () => {
    const windows = paginateDocBlocks(
      [block(0, 300), block(320, 700), block(720, 950)],
      PAGE,
    );
    expect(windows).toEqual([{ startPx: 0, endPx: 950 }]);
  });

  test("a block crossing the boundary moves whole to the next page", () => {
    const windows = paginateDocBlocks(
      [block(0, 600), block(620, 1200)],
      PAGE,
    );
    expect(windows).toEqual([
      { startPx: 0, endPx: 620 },
      { startPx: 620, endPx: 1200 },
    ]);
  });

  test("a cut shifts up past the headings directly above it", () => {
    const windows = paginateDocBlocks(
      [
        block(0, 700),
        block(720, 780, { heading: true }),
        block(800, 860, { heading: true }),
        block(880, 1400),
      ],
      PAGE,
    );
    // The cut before the overflowing block pulls both headings with it.
    expect(windows[0]).toEqual({ startPx: 0, endPx: 720 });
    expect(windows[1]).toEqual({ startPx: 720, endPx: 1400 });
  });

  test("a heading at the window start never shifts the cut to zero width", () => {
    const windows = paginateDocBlocks(
      [block(0, 80, { heading: true }), block(100, 1600)],
      PAGE,
    );
    expect(windows[0]).toEqual({ startPx: 0, endPx: 100 });
    expect(windows[1]).toEqual({ startPx: 100, endPx: 1100 });
    expect(windows[2]).toEqual({ startPx: 1100, endPx: 1600 });
  });

  test("an oversized single block hard-cuts at page height", () => {
    const windows = paginateDocBlocks([block(0, 2500)], PAGE);
    expect(windows).toEqual([
      { startPx: 0, endPx: 1000 },
      { startPx: 1000, endPx: 2000 },
      { startPx: 2000, endPx: 2500 },
    ]);
  });

  test("a page-break block forces a cut at its position", () => {
    const windows = paginateDocBlocks(
      [
        block(0, 200),
        block(210, 210, { pageBreak: true }),
        block(220, 500),
      ],
      PAGE,
    );
    expect(windows).toEqual([
      { startPx: 0, endPx: 210 },
      { startPx: 210, endPx: 500 },
    ]);
  });

  test("an empty document still yields one window", () => {
    expect(paginateDocBlocks([], PAGE)).toEqual([{ startPx: 0, endPx: 0 }]);
  });

  test("windows partition the content: contiguous, complete, page-bounded", () => {
    const blocks = [
      block(0, 80, { heading: true }),
      block(100, 700),
      block(720, 780, { heading: true }),
      block(800, 1400),
      block(1410, 1410, { pageBreak: true }),
      block(1420, 4200), // oversized: hard-cuts
      block(4220, 4500),
    ];
    const windows = paginateDocBlocks(blocks, PAGE);
    expect(windows[0]!.startPx).toBe(0);
    expect(windows.at(-1)!.endPx).toBe(4500);
    for (const [i, w] of windows.entries()) {
      expect(w.endPx).toBeGreaterThan(w.startPx);
      expect(w.endPx - w.startPx).toBeLessThanOrEqual(PAGE);
      if (i > 0) expect(w.startPx).toBe(windows[i - 1]!.endPx);
    }
  });
});

describe("normalizeDocPageBreaks", () => {
  test("rewrites @pagebreak lines and keeps break hrs verbatim", () => {
    const out = normalizeDocPageBreaks(
      'a\n@pagebreak\nb\n<hr class="chan-page-break">\nc @pagebreak c\n',
    );
    expect(out.split("\n")).toEqual([
      "a",
      '<hr class="chan-page-break">',
      "b",
      '<hr class="chan-page-break">',
      "c @pagebreak c",
      "",
    ]);
  });
});

describe("slideBoxFit", () => {
  test("16:9 fills the landscape width and letterboxes vertically", () => {
    const fit = slideBoxFit("16:9", DECK_PAGE_BOX_PX);
    expect(fit.widthPx).toBeCloseTo(DECK_PAGE_BOX_PX.widthPx, 4);
    expect(fit.heightPx).toBeCloseTo(DECK_PAGE_BOX_PX.widthPx / (16 / 9), 4);
    expect(fit.leftPx).toBeCloseTo(0, 4);
    expect(fit.topPx).toBeCloseTo(
      (DECK_PAGE_BOX_PX.heightPx - fit.heightPx) / 2,
      4,
    );
  });

  test("4:3 fills the landscape height and pillarboxes horizontally", () => {
    const fit = slideBoxFit("4:3", DECK_PAGE_BOX_PX);
    expect(fit.heightPx).toBeCloseTo(DECK_PAGE_BOX_PX.heightPx, 4);
    expect(fit.widthPx).toBeCloseTo(DECK_PAGE_BOX_PX.heightPx * (4 / 3), 4);
    expect(fit.topPx).toBeCloseTo(0, 4);
    expect(fit.leftPx).toBeCloseTo(
      (DECK_PAGE_BOX_PX.widthPx - fit.widthPx) / 2,
      4,
    );
  });
});

describe("deckSlideLayoutBox", () => {
  // The other side of the mirror: slidePreview.ts pageStyle sizes a
  // preview slide as width:min(86vw, <86*ratio>vh) with the height
  // fixed by the aspect ratio and padding clamp(22px, 4vw, 54px). The
  // preview must keep that CSS viewport-responsive, so the export
  // mirrors it as numbers at the reference viewport; this test spells
  // the preview formula out so drift on either side fails here.
  const vw = 1920;
  const vh = 1080;

  test.each([
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
  ] as [SlideAspectRatio, number][])(
    "%s mirrors the preview page box at the reference viewport",
    (aspect, ratio) => {
      expect(DECK_LAYOUT_VIEWPORT_PX).toEqual({ widthPx: vw, heightPx: vh });
      const box = deckSlideLayoutBox(aspect);
      const previewWidth = Math.min((86 / 100) * vw, (86 / 100) * vh * ratio);
      expect(box.widthPx).toBeCloseTo(previewWidth, 6);
      expect(box.heightPx).toBeCloseTo(previewWidth / ratio, 6);
    },
  );

  test("pins the concrete reference boxes", () => {
    const wide = deckSlideLayoutBox("16:9");
    expect(wide.widthPx).toBeCloseTo(1651.2, 4);
    expect(wide.heightPx).toBeCloseTo(928.8, 4);
    const narrow = deckSlideLayoutBox("4:3");
    expect(narrow.widthPx).toBeCloseTo(1238.4, 4);
    expect(narrow.heightPx).toBeCloseTo(928.8, 4);
  });

  test("the padding constant is the preview clamp at the reference viewport", () => {
    expect(DECK_LAYOUT_PADDING_PX).toBe(Math.max(22, Math.min(54, 0.04 * vw)));
  });
});

describe("deckPageLayout", () => {
  const ASPECTS: SlideAspectRatio[] = ["16:9", "4:3"];

  test.each(ASPECTS)(
    "%s: the slide surface is the layout box at the scaled A4 fit position",
    (aspect) => {
      const layout = deckPageLayout(aspect);
      const fit = slideBoxFit(aspect, DECK_PAGE_BOX_PX);
      const box = deckSlideLayoutBox(aspect);
      const upscale = box.widthPx / fit.widthPx;
      expect(layout.slide.widthPx).toBeCloseTo(box.widthPx, 6);
      expect(layout.slide.heightPx).toBeCloseTo(box.heightPx, 6);
      expect(layout.slide.leftPx).toBeCloseTo(fit.leftPx * upscale, 6);
      expect(layout.slide.topPx).toBeCloseTo(fit.topPx * upscale, 6);
      expect(layout.pageBox.widthPx).toBeCloseTo(
        DECK_PAGE_BOX_PX.widthPx * upscale,
        6,
      );
      expect(layout.pageBox.heightPx).toBeCloseTo(
        DECK_PAGE_BOX_PX.heightPx * upscale,
        6,
      );
    },
  );

  test.each(ASPECTS)(
    "%s: the raster scale maps the layout box onto the unchanged bitmap",
    (aspect) => {
      const layout = deckPageLayout(aspect);
      const fit = slideBoxFit(aspect, DECK_PAGE_BOX_PX);
      const box = deckSlideLayoutBox(aspect);
      expect(layout.rasterScale).toBeCloseTo(
        (fit.widthPx * RASTER_SCALE) / box.widthPx,
        10,
      );
      // Output device px stay what the DECK_PAGE_BOX_PX layout
      // produced before, so PDF size/quality is unchanged.
      expect(Math.ceil(layout.pageBox.widthPx * layout.rasterScale)).toBe(
        Math.ceil(DECK_PAGE_BOX_PX.widthPx * RASTER_SCALE),
      );
      expect(Math.ceil(layout.pageBox.heightPx * layout.rasterScale)).toBe(
        Math.ceil(DECK_PAGE_BOX_PX.heightPx * RASTER_SCALE),
      );
      // The slide surface still spans its old A4-fit raster region.
      expect(layout.slide.widthPx * layout.rasterScale).toBeCloseTo(
        fit.widthPx * RASTER_SCALE,
        6,
      );
    },
  );
});

describe("buildSlidePageDom", () => {
  test("lays the page out at the layout box with the reference padding", async () => {
    const dom = buildSlidePageDom({
      markdown: "# Title\n\nbody\n",
      fromPath: null,
      spec: { aspectRatio: "16:9", zoomFactor: 2 },
      theme: "light",
    });
    await dom.completion;

    const layout = deckPageLayout("16:9");
    expect(dom.box).toEqual(layout.pageBox);
    expect(dom.rasterScale).toBe(layout.rasterScale);
    expect(parseFloat(dom.root.style.width)).toBeCloseTo(
      layout.pageBox.widthPx,
      2,
    );
    expect(parseFloat(dom.root.style.height)).toBeCloseTo(
      layout.pageBox.heightPx,
      2,
    );

    const slide = dom.root.querySelector<HTMLElement>(".md-slide-preview-page")!;
    expect(parseFloat(slide.style.width)).toBeCloseTo(layout.slide.widthPx, 2);
    expect(parseFloat(slide.style.height)).toBeCloseTo(
      layout.slide.heightPx,
      2,
    );
    expect(slide.style.padding).toBe(`${DECK_LAYOUT_PADDING_PX}px`);

    // The content wrapper and its zoom are unchanged (contentStyle is
    // pinned in slide_dom.test.ts); only the box it fills grew.
    expect(
      slide.querySelector<HTMLElement>(".md-slide-preview-content"),
    ).not.toBeNull();
  });
});

describe("buildDocPageElements", () => {
  function fakeDoc() {
    const root = document.createElement("div");
    root.className = "chan-print-page";
    const content = document.createElement("div");
    content.className = "chan-print-content";
    content.innerHTML = "<p>one</p><p>two</p>";
    root.appendChild(content);
    return { root, content, completion: Promise.resolve() };
  }

  test("each page clips at its window length with shifted content", () => {
    const doc = fakeDoc();
    const pages = buildDocPageElements(doc, [
      { startPx: 0, endPx: 900 },
      { startPx: 900, endPx: 1400 },
    ]);

    expect(pages).toHaveLength(2);
    expect(pages[0]!.style.height).toBe("900px");
    expect(pages[1]!.style.height).toBe("500px");
    for (const page of pages) {
      expect(page.style.overflow).toBe("hidden");
    }
    expect(
      pages[0]!.querySelector<HTMLElement>(".chan-print-content")?.style
        .marginTop,
    ).toBe("0px");
    expect(
      pages[1]!.querySelector<HTMLElement>(".chan-print-content")?.style
        .marginTop,
    ).toBe("-900px");
    // Clones are independent of the original.
    expect(doc.root.style.height).toBe("");
  });

  test("clip geometry realizes the cut geometry: visible bands partition", () => {
    const windows = paginateDocBlocks(
      [
        block(0, 700),
        block(720, 780, { heading: true }),
        block(800, 1400),
        block(1420, 4200),
      ],
      1000,
    );
    const pages = buildDocPageElements(fakeDoc(), windows);
    expect(pages).toHaveLength(windows.length);
    for (const [i, page] of pages.entries()) {
      const content = page.querySelector<HTMLElement>(".chan-print-content")!;
      const shift = -parseFloat(content.style.marginTop || "0");
      const clip = parseFloat(page.style.height);
      // Visible band [shift, shift + clip) is exactly this page's window.
      expect(shift).toBeCloseTo(windows[i]!.startPx, 6);
      expect(shift + clip).toBeCloseTo(windows[i]!.endPx, 6);
    }
  });
});
