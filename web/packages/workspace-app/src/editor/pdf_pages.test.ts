// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
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
  fitSlideContent,
  paginateDocBlocks,
  slideBoxFit,
  slideFitScale,
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
  // playing slide as width:100vw capped at max-width:<100*ratio>vh, with
  // the height fixed by the aspect ratio and padding clamp(22px, 4vw,
  // 54px). Play must keep that CSS viewport-responsive, so the export
  // mirrors it as numbers at the reference viewport; this test spells
  // play's formula out so drift on either side fails here.
  const vw = 1920;
  const vh = 1080;

  test.each([
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
  ] as [SlideAspectRatio, number][])(
    "%s mirrors the box a slide plays in at the reference viewport",
    (aspect, ratio) => {
      expect(DECK_LAYOUT_VIEWPORT_PX).toEqual({ widthPx: vw, heightPx: vh });
      const box = deckSlideLayoutBox(aspect);
      const playWidth = Math.min(vw, vh * ratio);
      expect(box.widthPx).toBeCloseTo(playWidth, 6);
      expect(box.heightPx).toBeCloseTo(playWidth / ratio, 6);
    },
  );

  test("pins the concrete reference boxes", () => {
    const wide = deckSlideLayoutBox("16:9");
    expect(wide.widthPx).toBeCloseTo(1920, 4);
    expect(wide.heightPx).toBeCloseTo(1080, 4);
    const narrow = deckSlideLayoutBox("4:3");
    expect(narrow.widthPx).toBeCloseTo(1440, 4);
    expect(narrow.heightPx).toBeCloseTo(1080, 4);
  });

  test("the padding constant is play's clamp at the reference viewport", () => {
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

  test("a code block of the page grows to its longest line instead of scrolling", async () => {
    const dom = buildSlidePageDom({
      markdown: "```sh\none long line\n```\n",
      fromPath: null,
      spec: { aspectRatio: "16:9", zoomFactor: 2 },
      theme: "light",
    });
    await dom.completion;
    document.body.append(dom.root);

    const pre = dom.root.querySelector("pre")!;
    const style = getComputedStyle(pre);
    expect(style.overflow).toBe("visible");
    expect(style.width).toBe("max-content");
    // No narrower than the slide's content, padding included.
    expect(style.minWidth).toBe("100%");
    expect(style.boxSizing).toBe("border-box");
    dom.root.remove();
  });
});

describe("slideFitScale", () => {
  const BOX = { widthPx: 900, heightPx: 480 };

  test("content that fits keeps its size", () => {
    expect(slideFitScale({ widthPx: 900, heightPx: 300 }, BOX)).toBe(1);
    expect(slideFitScale({ widthPx: 900, heightPx: 480 }, BOX)).toBe(1);
  });

  test("content taller than the box is scaled to the box's height", () => {
    expect(slideFitScale({ widthPx: 900, heightPx: 600 }, BOX)).toBeCloseTo(
      0.8,
      10,
    );
  });

  test("content wider than the box is scaled to the box's width", () => {
    expect(slideFitScale({ widthPx: 1200, heightPx: 300 }, BOX)).toBeCloseTo(
      0.75,
      10,
    );
  });

  test("the axis that overflows more decides", () => {
    expect(slideFitScale({ widthPx: 1200, heightPx: 960 }, BOX)).toBeCloseTo(
      0.5,
      10,
    );
  });

  test("a box or a content with no size scales nothing", () => {
    const none = { widthPx: 0, heightPx: 0 };
    expect(slideFitScale(none, none)).toBe(1);
    expect(slideFitScale({ widthPx: 900, heightPx: 600 }, none)).toBe(1);
  });
});

describe("fitSlideContent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /// A deck page whose content element answers with the sizes given:
  /// jsdom lays out nothing, so the engine's answers are stood in.
  function pageOf(sizes: {
    box: [number, number];
    extent: [number, number];
  }): { root: HTMLElement; content: HTMLElement; heldAt: string[] } {
    const dom = buildSlidePageDom({
      markdown: "# Title\n\nbody\n",
      fromPath: null,
      spec: { aspectRatio: "16:9", zoomFactor: 2 },
      theme: "light",
    });
    document.body.append(dom.root);
    const content = dom.root.querySelector<HTMLElement>(
      ".md-slide-preview-content",
    )!;
    // The height the content was held at for each reading.
    const heldAt: string[] = [];
    const answer = (value: number) =>
      function (this: Element): number {
        if (this === content) heldAt.push(content.style.height);
        return this === content ? value : 0;
      };
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      answer(sizes.box[0]),
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      answer(sizes.box[1]),
    );
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(
      answer(sizes.extent[0]),
    );
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
      answer(sizes.extent[1]),
    );
    return { root: dom.root, content, heldAt };
  }

  test("content that fits is left as it is", () => {
    const { root, content } = pageOf({ box: [900, 480], extent: [900, 300] });
    expect(fitSlideContent(root)).toBe(1);
    expect(content.style.transform).toBe("");
  });

  test("content taller than the slide is scaled from its top and centered", () => {
    const { root, content } = pageOf({ box: [900, 480], extent: [900, 600] });
    expect(fitSlideContent(root)).toBeCloseTo(0.8, 10);
    // 0.8 of the width is drawn, so a tenth of it is left on each side.
    expect(content.style.transform).toBe("translateX(10%) scale(0.8)");
    expect(content.style.transformOrigin).toBe("top left");
  });

  test("content wider than the slide is scaled to span it", () => {
    const { root, content } = pageOf({ box: [900, 480], extent: [1200, 300] });
    expect(fitSlideContent(root)).toBeCloseTo(0.75, 10);
    expect(content.style.transform).toBe("translateX(0%) scale(0.75)");
  });

  test("an extent one px past the box is rounding, not an overflow", () => {
    const { root, content } = pageOf({ box: [900, 480], extent: [901, 481] });
    expect(fitSlideContent(root)).toBe(1);
    expect(content.style.transform).toBe("");
  });

  test("every size is read with the content held at the slide's height", () => {
    const { root, content, heldAt } = pageOf({
      box: [900, 480],
      extent: [900, 600],
    });
    fitSlideContent(root);
    expect(heldAt.length).toBeGreaterThanOrEqual(4);
    expect(new Set(heldAt)).toEqual(new Set(["100%"]));
    expect(content.style.height).toBe("");
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

  test("each page asks to paint only images crossing its window", () => {
    const doc = fakeDoc();
    doc.content.innerHTML = [0, 1, 2]
      .map((id) => `<img data-chan-export-image="${id}" src="data:image/png;base64,AAAA">`)
      .join("");
    vi.spyOn(doc.content, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    const boxes = [
      { top: 150, bottom: 200 },
      { top: 950, bottom: 1050 },
      { top: 1150, bottom: 1200 },
    ];
    Array.from(doc.content.querySelectorAll("img")).forEach((img, id) => {
      vi.spyOn(img, "getBoundingClientRect").mockReturnValue(boxes[id] as DOMRect);
    });

    const pages = buildDocPageElements(doc, [
      { startPx: 0, endPx: 900 },
      { startPx: 900, endPx: 1400 },
    ]);
    const active = pages.map((page) =>
      Array.from(page.querySelectorAll("img[data-chan-export-image]")).map((img) =>
        img.getAttribute("data-chan-export-image"),
      ),
    );
    expect(active).toEqual([["0", "1"], ["1", "2"]]);
  });
});
