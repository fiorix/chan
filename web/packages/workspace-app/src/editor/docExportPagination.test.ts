// @vitest-environment jsdom
//
// Where the document export cuts its pages, and how many times it fetches
// the images it paints.
//
// Both claims are about ORDER, not about pixels, so jsdom can carry them
// with a layout model instead of a layout engine: every top-level block has
// a fixed height, an image contributes nothing until its load event and its
// full height afterwards, and the export's own measurement and pagination
// run unchanged on top of that. What the tests assert is that the export
// measures after the images have settled, and that it inlines each image
// once rather than once per page.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDocDom } from "./doc_dom";
import {
  docPageGeometry,
  measureDocBlocks,
  normalizeDocPageBreaks,
  paginateDocBlocks,
} from "./pdf_pages";
import { exportMarkdownToPdf } from "./pdf_export";
import type { PageBoxPx, PageSnapshot } from "./pdf_snapshot";

vi.mock("./mermaid_render", () => ({
  renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));
vi.mock("./excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
  renderExcalidrawFile: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));

// A valid 1x1 PNG so pdf-lib accepts the fake raster.
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const TEXT_BLOCK_PX = 40;
const IMAGE_BLOCK_PX = 400;

const IMAGE_DOC = [
  "# Gallery",
  "",
  "![](one.png)",
  "",
  "![](two.png)",
  "",
  "![](three.png)",
  "",
  "the end",
].join("\n");

const loaded = new WeakSet<Element>();

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/// A block is as tall as its image once that image has loaded, and as tall
/// as a line of text otherwise. An image that has not arrived contributes
/// nothing, which is exactly what the browser reports before the bytes
/// land.
function blockHeight(el: Element): number {
  const img = el.tagName === "IMG" ? el : el.querySelector("img");
  if (!img) return TEXT_BLOCK_PX;
  return loaded.has(img) ? IMAGE_BLOCK_PX : 0;
}

/// Stack the print content's top-level blocks. Anything else, the content
/// element included, sits at the origin, so measured tops are offsets from
/// the content top exactly as the real measurement takes them.
function layoutRect(el: Element): DOMRect {
  const parent = el.parentElement;
  if (!parent?.classList.contains("chan-print-content")) return rect(0, 0);
  let top = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) break;
    top += blockHeight(sibling);
  }
  return rect(top, top + blockHeight(el));
}

/// Deliver every image currently in the document, one macrotask from now,
/// the way a network response arrives after the export has started.
function deliverImagesLate(): void {
  setTimeout(() => {
    for (const img of Array.from(document.querySelectorAll("img"))) {
      loaded.add(img);
      img.dispatchEvent(new Event("load"));
    }
  }, 0);
}

/// The page windows the document would be cut into with every image
/// loaded: the reference the export has to match.
function windowsAfterLoad(markdown: string): number[] {
  const dom = buildDocDom({
    markdown: normalizeDocPageBreaks(markdown),
    path: "notes/doc.md",
    theme: "light",
    contentWidthPx: 800,
  });
  const host = document.createElement("div");
  host.appendChild(dom.root);
  document.body.appendChild(host);
  for (const img of Array.from(dom.content.querySelectorAll("img"))) {
    loaded.add(img);
  }
  const windows = paginateDocBlocks(
    measureDocBlocks(dom.content),
    docPageGeometry().pageContentHeightPx,
  );
  host.remove();
  return windows.map((w) => w.endPx - w.startPx);
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return layoutRect(this);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the export cuts pages where a loaded document cuts them", () => {
  test("images that arrive late still decide the page cuts", async () => {
    const heights: number[] = [];
    deliverImagesLate();
    await exportMarkdownToPdf(
      { path: "notes/doc.md", markdown: IMAGE_DOC, theme: "light" },
      {
        rasterize: async (root: HTMLElement, _box: PageBoxPx): Promise<PageSnapshot> => {
          heights.push(Math.round(parseFloat(root.style.height)));
          return { png: TINY_PNG, widthPx: 2, heightPx: 2 };
        },
      },
    );
    const reference = windowsAfterLoad(IMAGE_DOC).map((h) => Math.round(h));
    expect(heights).toEqual(reference);
  });
});

describe("the export inlines each image once", () => {
  test("three images over several pages are fetched three times", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(String(url));
        return {
          ok: true,
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        };
      }),
    );
    const pages: HTMLElement[] = [];
    deliverImagesLate();
    await exportMarkdownToPdf(
      { path: "notes/doc.md", markdown: IMAGE_DOC, theme: "light" },
      {
        rasterize: async (root: HTMLElement): Promise<PageSnapshot> => {
          pages.push(root);
          return { png: TINY_PNG, widthPx: 2, heightPx: 2 };
        },
      },
    );
    expect(fetched).toHaveLength(3);
    expect(pages.length).toBeGreaterThan(1);
    const srcs = pages.flatMap((page) =>
      Array.from(page.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? ""),
    );
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src.startsWith("data:")).toBe(true);
    }
  });
});
