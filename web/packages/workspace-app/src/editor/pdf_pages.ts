// Page composition for the PDF export engine: A4 geometry, document
// pagination over measured block rects, window-clone page elements for
// documents, and per-slide page elements for decks.
//
// Documents render portrait with 0.65in margins and their content laid
// out at a fixed printable width in CSS px, so pagination measures
// final geometry. Decks render one slide per page, A4 landscape, the
// slide box aspect-fit and centered on a page painted in the slide
// theme background; the deck page DOM lays out at a preview-reference
// pixel box and rasterizes at a compensating scale so px-sized media
// keeps its on-screen fraction of the slide (see deckPageLayout).

import {
  contentStyle,
  editorTokens,
  prepareSlideImages,
  renderSlideDiagrams,
  renderSlideMarkdown,
  slidePageBoxStyle,
  slidePreviewCss,
  type SlideDomTheme,
} from "./slide_dom";
import { buildDocDom, type DocDom } from "./doc_dom";
import { PAGE_BREAK_RE, type SlideAspectRatio, type SlidesSpec } from "./slides";
import { RASTER_SCALE, type PageBoxPx } from "./pdf_snapshot";

/// A4 in PDF points.
export const A4_PORTRAIT_PT = { widthPt: 595.28, heightPt: 841.89 };
export const A4_LANDSCAPE_PT = { widthPt: 841.89, heightPt: 595.28 };

/// Document page margins: 0.65in at 72pt/in.
export const DOC_MARGIN_PT = 0.65 * 72;

/// Fixed printable content width for documents, in CSS px.
export const DOC_CONTENT_WIDTH_PX = 669;

/// Deck pages lay out at A4 landscape in CSS px at 96dpi, so the raster
/// fills the PDF page edge to edge.
export const DECK_PAGE_BOX_PX: PageBoxPx = {
  widthPx: (A4_LANDSCAPE_PT.widthPt / 72) * 96,
  heightPx: (A4_LANDSCAPE_PT.heightPt / 72) * 96,
};

export type DocPageGeometry = {
  printableWidthPt: number;
  printableHeightPt: number;
  /// PDF points per CSS px at the fixed content width.
  ptPerPx: number;
  /// Page window height in CSS px.
  pageContentHeightPx: number;
};

export function docPageGeometry(): DocPageGeometry {
  const printableWidthPt = A4_PORTRAIT_PT.widthPt - 2 * DOC_MARGIN_PT;
  const printableHeightPt = A4_PORTRAIT_PT.heightPt - 2 * DOC_MARGIN_PT;
  const ptPerPx = printableWidthPt / DOC_CONTENT_WIDTH_PX;
  return {
    printableWidthPt,
    printableHeightPt,
    ptPerPx,
    pageContentHeightPx: printableHeightPt / ptPerPx,
  };
}

/// One measured top-level block of a document, in CSS px relative to
/// the content top.
export type DocBlockRect = {
  top: number;
  bottom: number;
  /// h1-h6: a cut never lands directly below a heading; the heading
  /// moves to the next page instead.
  heading: boolean;
  /// hr.chan-page-break: forces a cut after this block.
  pageBreak: boolean;
};

/// A page's vertical window over the document content, [startPx, endPx).
export type DocPageWindow = { startPx: number; endPx: number };

/// Choose page windows over measured blocks. Cuts land at block
/// boundaries; a cut that would orphan headings at a page bottom shifts
/// up past them; a single block taller than a page is hard-cut at page
/// height (documented v1 limit); page-break blocks force a cut.
export function paginateDocBlocks(
  blocks: readonly DocBlockRect[],
  pageHeightPx: number,
): DocPageWindow[] {
  const windows: DocPageWindow[] = [];
  let start = 0;
  const push = (end: number) => {
    if (end > start) windows.push({ startPx: start, endPx: end });
    start = end;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.pageBreak) {
      // Cut at the break marker, clamped to page height (anything
      // between the last block and a clamped cut is whitespace).
      push(Math.min(Math.max(block.top, start), start + pageHeightPx));
      continue;
    }
    while (block.bottom - start > pageHeightPx) {
      if (block.top <= start) {
        // The block itself spans past a full page: hard-cut inside it.
        push(start + pageHeightPx);
        continue;
      }
      // Cut before this block, pulling contiguous headings above it
      // onto the next page with it.
      let cut = block.top;
      for (let j = i - 1; j >= 0; j--) {
        const prev = blocks[j]!;
        if (!prev.heading || prev.top <= start) break;
        cut = prev.top;
      }
      if (cut <= start) cut = block.top;
      if (cut <= start) {
        push(start + pageHeightPx);
        continue;
      }
      push(cut);
    }
  }

  const lastBottom = blocks.length
    ? Math.max(...blocks.map((b) => b.bottom))
    : 0;
  if (lastBottom > start || windows.length === 0) {
    windows.push({ startPx: start, endPx: Math.max(lastBottom, start) });
  }
  return windows;
}

/// Measure the top-level blocks of an ATTACHED document content element.
export function measureDocBlocks(content: HTMLElement): DocBlockRect[] {
  const contentTop = content.getBoundingClientRect().top;
  return Array.from(content.children).map((child) => {
    const rect = child.getBoundingClientRect();
    return {
      top: rect.top - contentTop,
      bottom: rect.bottom - contentTop,
      heading: /^H[1-6]$/.test(child.tagName),
      pageBreak:
        child.tagName === "HR" && child.classList.contains("chan-page-break"),
    };
  });
}

/// Build one detached page element per window: a clone of the document
/// root clipped at the WINDOW length with its content shifted up by the
/// window start, so each page shows exactly [startPx, endPx) of the
/// ORIGINAL layout and the windows partition the content across pages.
/// A window shorter than the page leaves a transparent tail in the
/// raster; the exporter paints the page background behind it.
export function buildDocPageElements(
  doc: DocDom,
  windows: readonly DocPageWindow[],
): HTMLElement[] {
  return windows.map((window) => {
    const page = doc.root.cloneNode(true) as HTMLElement;
    page.style.height = `${window.endPx - window.startPx}px`;
    page.style.overflow = "hidden";
    const content = page.querySelector<HTMLElement>(".chan-print-content");
    if (content) content.style.marginTop = `-${window.startPx}px`;
    return page;
  });
}

/// Normalize @pagebreak shorthand lines to the page-break hr, which is
/// what the rendered document exposes to the block measurer.
export function normalizeDocPageBreaks(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      PAGE_BREAK_RE.test(line) ? '<hr class="chan-page-break">' : line,
    )
    .join("\n");
}

/// Aspect-fit a slide of `aspectRatio` into a page box, centered.
export function slideBoxFit(
  aspectRatio: SlideAspectRatio,
  page: PageBoxPx,
): { widthPx: number; heightPx: number; leftPx: number; topPx: number } {
  const [w, h] = aspectRatio.split(":").map(Number);
  const ratio = w! / h!;
  let widthPx = page.widthPx;
  let heightPx = widthPx / ratio;
  if (heightPx > page.heightPx) {
    heightPx = page.heightPx;
    widthPx = heightPx * ratio;
  }
  return {
    widthPx,
    heightPx,
    leftPx: (page.widthPx - widthPx) / 2,
    topPx: (page.heightPx - heightPx) / 2,
  };
}

/// Reference viewport for the deck layout box: the common 1920x1080
/// desktop screen the fullscreen preview is typically seen on.
export const DECK_LAYOUT_VIEWPORT_PX = { widthPx: 1920, heightPx: 1080 };

/// The preview page padding at the reference viewport: the overlay's
/// clamp(22px, 4vw, 54px) resolves to 54px there (4vw = 76.8px).
export const DECK_LAYOUT_PADDING_PX = 54;

/// The preview overlay's page box evaluated at the reference viewport:
/// slidePreview.ts pageStyle sizes a preview slide as
/// width:min(86vw, <86*ratio>vh) with the height fixed by the aspect
/// ratio. That CSS must stay viewport-responsive, so the formula is
/// mirrored here as numbers; pdf_pages.test.ts pins both sides of the
/// mirror so drift in either place fails the test.
export function deckSlideLayoutBox(aspectRatio: SlideAspectRatio): PageBoxPx {
  const [w, h] = aspectRatio.split(":").map(Number);
  const ratio = w! / h!;
  const widthPx = Math.min(
    0.86 * DECK_LAYOUT_VIEWPORT_PX.widthPx,
    0.86 * DECK_LAYOUT_VIEWPORT_PX.heightPx * ratio,
  );
  return { widthPx, heightPx: widthPx / ratio };
}

export type DeckPageLayout = {
  /// CSS-px box the deck page DOM lays out at: DECK_PAGE_BOX_PX scaled
  /// up so the aspect-fit slide surface lands on the layout box.
  pageBox: PageBoxPx;
  /// The slide surface inside pageBox: deckSlideLayoutBox, placed at
  /// the A4 fit's position scaled by the same factor.
  slide: { widthPx: number; heightPx: number; leftPx: number; topPx: number };
  /// Device px per CSS px for the raster. Cancels the layout upscale,
  /// so the output bitmap stays DECK_PAGE_BOX_PX * RASTER_SCALE and
  /// maps onto the A4 page exactly as before.
  rasterScale: number;
};

/// Deck page layout: diagrams and #w= images size at min(native px,
/// container px), so a slide laid out directly in the A4-px box shows
/// them at a different fraction of the slide than the on-screen
/// preview. Deck pages therefore LAY OUT at the preview-reference box
/// and rasterize at the compensating scale; the PDF page geometry and
/// the raster pixel size are unchanged.
export function deckPageLayout(aspectRatio: SlideAspectRatio): DeckPageLayout {
  const fit = slideBoxFit(aspectRatio, DECK_PAGE_BOX_PX);
  const layout = deckSlideLayoutBox(aspectRatio);
  // Widths are equivalent to heights here: the fit and the layout box
  // share the aspect ratio by construction, so one factor maps both
  // axes exactly.
  const upscale = layout.widthPx / fit.widthPx;
  return {
    pageBox: {
      widthPx: DECK_PAGE_BOX_PX.widthPx * upscale,
      heightPx: DECK_PAGE_BOX_PX.heightPx * upscale,
    },
    slide: {
      widthPx: layout.widthPx,
      heightPx: layout.heightPx,
      leftPx: fit.leftPx * upscale,
      topPx: fit.topPx * upscale,
    },
    rasterScale: (fit.widthPx * RASTER_SCALE) / layout.widthPx,
  };
}

export type SlidePageDom = {
  root: HTMLElement;
  /// The CSS-px box `root` lays out at; pass it to the rasterizer.
  box: PageBoxPx;
  /// Raster scale mapping `box` onto the standard deck page bitmap.
  rasterScale: number;
  /// Resolves when the slide's diagram and image renders settled.
  completion: Promise<void>;
};

/// Build a deck page: the page box painted in the slide theme
/// background with the slide surface aspect-fit and centered, reusing
/// the preview's page classes so slides render identically. The page
/// lays out at deckPageLayout's preview-reference box (NOT the A4 box)
/// with the preview's reference padding, so media keeps its preview
/// fraction; the caller rasterizes at the returned scale to land on
/// the unchanged A4 bitmap.
export function buildSlidePageDom(opts: {
  markdown: string;
  fromPath: string | null;
  spec: SlidesSpec;
  theme: SlideDomTheme;
  styleSource?: Element | null;
}): SlidePageDom {
  const layout = deckPageLayout(opts.spec.aspectRatio);
  const tokens = editorTokens(opts.styleSource, opts.theme);

  const root = document.createElement("div");
  root.style.cssText = [
    `width:${layout.pageBox.widthPx}px`,
    `height:${layout.pageBox.heightPx}px`,
    `background:${tokens.bg}`,
    "position:relative",
    "overflow:hidden",
  ].join(";");

  const style = document.createElement("style");
  style.textContent = slidePreviewCss();
  root.appendChild(style);

  const slide = document.createElement("article");
  slide.className = "md-slide-preview-page";
  slide.style.cssText =
    slidePageBoxStyle(
      { widthPx: layout.slide.widthPx, heightPx: layout.slide.heightPx },
      opts.styleSource,
      opts.theme,
      DECK_LAYOUT_PADDING_PX,
    ) +
    `;position:absolute;left:${layout.slide.leftPx}px;top:${layout.slide.topPx}px`;
  root.appendChild(slide);

  const content = document.createElement("div");
  content.className = "md-slide-preview-content";
  content.style.cssText = contentStyle(opts.spec.zoomFactor);
  content.innerHTML = renderSlideMarkdown(opts.markdown);
  slide.appendChild(content);

  const completion = Promise.all([
    prepareSlideImages(content, opts.fromPath, opts.theme, () => true),
    renderSlideDiagrams(content, opts.markdown, opts.theme, () => true),
  ]).then(() => undefined);

  return {
    root,
    box: layout.pageBox,
    rasterScale: layout.rasterScale,
    completion,
  };
}

export { buildDocDom };
