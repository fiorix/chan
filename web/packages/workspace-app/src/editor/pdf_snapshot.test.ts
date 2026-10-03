// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  auditSelfContained,
  inlinePageResources,
  liftPageImages,
  markerRgb,
  PageImages,
  pageSvgDocument,
  placeLiftedImage,
  readMarkerBoxes,
  SnapshotError,
  snapshotPage,
} from "./pdf_snapshot";
import {
  decodesSettleAtOnce,
  heldDecodes,
  imagesHaveBoxes,
  settled,
  standInCanvas,
  StandInImage,
} from "../__tests__/snapshotStandIns";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function fetchOk(body: BlobPart, type: string) {
  return {
    ok: true,
    blob: async () => new Blob([body], { type }),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("missing")) return { ok: false } as Response;
      if (u.endsWith(".woff2")) {
        return fetchOk(PNG_BYTES, "font/woff2");
      }
      return fetchOk(PNG_BYTES, "image/png");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll("style[data-test-fonts]")
    .forEach((el) => el.remove());
  document.body.innerHTML = "";
});

function page(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("inlinePageResources", () => {
  test("starts independent image fetches before either one settles", async () => {
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve))),
    );
    const root = page('<img src="/api/fs/a.png"><img src="/api/fs/b.png">');
    const inlined = inlinePageResources(root);
    await settled();
    const startedBeforeReply = replies.length;
    replies[0]!(fetchOk(PNG_BYTES, "image/png"));
    await settled();
    replies[1]!(fetchOk(PNG_BYTES, "image/png"));
    await inlined;

    expect(startedBeforeReply).toBe(2);
    expect(Array.from(root.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual([
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/),
    ]);
  });

  test("rewrites img srcs to data: URIs via fetch", async () => {
    const root = page('<img src="/api/fs/photo.png?t=tok">');
    await inlinePageResources(root);
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/fs/photo.png?t=tok",
      expect.anything(),
    );
  });

  test("leaves data: srcs untouched without fetching", async () => {
    const root = page('<img src="data:image/png;base64,AAAA">');
    await inlinePageResources(root);
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  test("inlines url() tokens inside page-embedded styles (excalidraw fonts)", async () => {
    const root = page(
      "<svg><style>@font-face { font-family: X; src: url(/static/excalidraw/Excalifont.woff2); }</style></svg>",
    );
    await inlinePageResources(root);
    const css = root.querySelector("style")?.textContent ?? "";
    expect(css).toContain("url(data:font/woff2;base64,");
    expect(css).not.toContain("/static/excalidraw/");
  });

  test("keeps unresolvable refs verbatim so the audit can name them", async () => {
    const root = page('<img src="/api/fs/missing.png">');
    await inlinePageResources(root);
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "/api/fs/missing.png",
    );
    expect(() => auditSelfContained(root)).toThrow(SnapshotError);
  });

  test("carries referenced app font faces onto the page, inlined", async () => {
    const style = document.createElement("style");
    style.dataset.testFonts = "1";
    style.textContent =
      '@font-face { font-family: "Test Code Font"; src: url(/static/fonts/test.woff2) format("woff2"); }';
    document.head.append(style);

    const root = page(
      '<pre style="font-family:\'Test Code Font\',monospace">x</pre>',
    );
    await inlinePageResources(root);
    const prepended = root.querySelector("style")?.textContent ?? "";
    expect(prepended).toContain("Test Code Font");
    expect(prepended).toContain("url(data:font/woff2;base64,");

    const unrelated = page("<p>no code here</p>");
    vi.mocked(fetch).mockClear();
    await inlinePageResources(unrelated);
    expect(unrelated.querySelector("style")).toBeNull();
  });
});

describe("auditSelfContained", () => {
  test("passes a fully inlined page and allows anchors and fragments", () => {
    const root = page(
      '<a href="https://example.com">link</a>' +
        '<img src="data:image/png;base64,AAAA">' +
        '<svg><use href="#glyph"></use></svg>',
    );
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test("throws naming a leaked absolute image URL", () => {
    const root = page('<img src="https://cdn.example.com/x.png">');
    expect(() => auditSelfContained(root)).toThrow(
      /img src https:\/\/cdn\.example\.com\/x\.png/,
    );
  });

  test("throws on external url() in style attributes and style elements", () => {
    const inline = page('<div style="background:url(/api/fs/bg.png)">x</div>');
    expect(() => auditSelfContained(inline)).toThrow(/inline style url\(\)/);

    const styled = page("<style>.x { background: url(http://e.com/i.png); }</style>");
    expect(() => auditSelfContained(styled)).toThrow(/style url\(\)/);
  });

  test("throws on svg image hrefs and disallowed elements", () => {
    const image = page('<svg><image href="/api/fs/pic.png"></image></svg>');
    expect(() => auditSelfContained(image)).toThrow(/image href/);

    const script = page("<script>1</script>");
    expect(() => auditSelfContained(script)).toThrow(/disallowed element <script>/);
  });
});

describe("pageSvgDocument", () => {
  test("wraps serialized XHTML in a sized foreignObject document", () => {
    const root = page("<p>hi</p>");
    const doc = pageSvgDocument(root, { widthPx: 800, heightPx: 600 });
    expect(doc).toContain('width="800"');
    expect(doc).toContain('height="600"');
    expect(doc).toContain("<foreignObject");
    expect(doc).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(doc).toContain("<p>hi</p>");
  });

  test("the document hides the scrollbar of anything that overflows", () => {
    // A raster has nothing to scroll, and an element styled to scroll
    // would still paint its scrollbar into it.
    const root = page('<pre style="overflow:auto">one long line</pre>');
    const doc = new DOMParser().parseFromString(
      pageSvgDocument(root, { widthPx: 800, heightPx: 600 }),
      "image/svg+xml",
    );
    expect(doc.querySelector("parsererror")).toBeNull();
    const css = Array.from(doc.querySelectorAll("foreignObject > style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(css).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none/);
    expect(css).toMatch(/\*::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
    // The page itself still follows the stylesheet.
    expect(doc.querySelector("foreignObject > div > pre")?.textContent).toBe(
      "one long line",
    );
  });
});

describe("snapshotPage", () => {
  const BOX = { widthPx: 100, heightPx: 80 };

  let decodes: ReturnType<typeof heldDecodes>;

  beforeEach(() => {
    decodes = heldDecodes();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("nothing is drawn before every image of the page has decoded", async () => {
    const drawn = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    const root = page(
      '<p>text</p><img src="/api/fs/one.png?t=tok"><img src="/api/fs/two.png?t=tok">',
    );
    const snapshot = snapshotPage(root, BOX);
    let failure: unknown = null;
    snapshot.catch((err) => (failure = err));

    await settled();
    expect(failure).toBeNull();
    const startedBeforeReply = decodes.length;
    expect(drawn).toEqual([]);

    decodes[0]!.settle(true);
    await settled();
    expect(decodes).toHaveLength(2);
    expect(drawn).toEqual([]);

    decodes[1]!.settle(true);
    await snapshot;
    expect(startedBeforeReply).toBe(2);
    expect(drawn.map((d) => d.what)).toContain("page");
  });

  test("an image is painted from its decoded bitmap where the page holds it", async () => {
    const drawn = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    const root = page('<p>text</p><img src="/api/fs/photo.png?t=tok">');
    const snapshot = snapshotPage(root, BOX);
    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(true);
    const result = await snapshot;

    expect(drawn.map((d) => d.what)).toEqual(["page", "markers", "image"]);
    const [bitmap, ...place] = drawn[2]!.args;
    expect((bitmap as StandInImage).src).toMatch(/^data:image\/png;base64,/);
    expect(place).toEqual([10, 20, 40, 20]);
    expect(result.widthPx).toBe(200);
    expect(result.heightPx).toBe(160);
  });

  test("an image that does not decode fails the snapshot by its name", async () => {
    const drawn = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    const root = page('<p>text</p><img src="/api/fs/shots/broken.png?t=tok">');
    const snapshot = snapshotPage(root, BOX);
    let failure: unknown = null;
    snapshot.catch((err) => (failure = err));
    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(false);
    await settled();

    expect(failure).toBeInstanceOf(SnapshotError);
    expect((failure as Error).message).toContain("/api/fs/shots/broken.png");
    expect((failure as Error).message).not.toContain("tok");
    expect(drawn).toEqual([]);
  });

  test.each([
    ["display:none", '<div style="display:none"><img src="/api/fs/hidden.png"></div>'],
    ["visibility:hidden", '<div style="visibility:hidden"><img src="/api/fs/hidden.png"></div>'],
    ["opacity:0", '<div style="opacity:0"><img src="/api/fs/hidden.png"></div>'],
    ["image opacity:0", '<img src="/api/fs/hidden.png" style="opacity:0">'],
  ])("does not paint an image hidden by %s", async (_style, html) => {
    const drawn = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    decodesSettleAtOnce();
    await snapshotPage(page(html), BOX);

    expect(drawn.map((d) => d.what)).toEqual(["page"]);
  });

  test("an image with no place on the page fails the snapshot by its name", async () => {
    // The stand-in canvas answers a marker read with no marker at all.
    standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    const root = page('<p>text</p><img src="/api/fs/shots/lost.png?t=tok">');
    const snapshot = snapshotPage(root, BOX);
    let failure: unknown = null;
    snapshot.catch((err) => (failure = err));
    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(true);
    await settled();

    expect(failure).toBeInstanceOf(SnapshotError);
    expect((failure as Error).message).toContain("/api/fs/shots/lost.png");
    expect((failure as Error).message).not.toContain("tok");
  });
});

describe("liftPageImages", () => {
  beforeEach(() => {
    heldDecodes();
    vi.stubGlobal("Image", StandInImage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function lifted(html: string): Promise<{
    root: HTMLElement;
    images: PageImages;
  }> {
    decodesSettleAtOnce();
    const root = page(html);
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    return { root, images };
  }

  test("leaves a stand-in of the image's size where the image was", async () => {
    imagesHaveBoxes();
    const { root, images } = await lifted('<img src="/api/fs/photo.png?t=tok">');
    const img = root.querySelector("img")!;
    const standIn = decodeURIComponent(img.getAttribute("src")!);
    expect(standIn).toMatch(/^data:image\/svg\+xml,<svg /);
    expect(standIn).toContain('width="40"');
    expect(standIn).toContain('height="20"');
    expect(img.getAttribute("width")).toBe("40");
    expect(img.style.getPropertyValue("aspect-ratio")).toBe("40 / 20");
    expect(images.lifted).toHaveLength(1);
    expect(images.lifted[0]!.name).toBe("/api/fs/photo.png");
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test("keeps the width, height and ratio an author gave", async () => {
    imagesHaveBoxes();
    const { root } = await lifted(
      '<img src="/api/fs/a.png" height="10">' +
        '<img src="/api/fs/b.png" style="aspect-ratio: 1 / 1">',
    );
    const [a, b] = Array.from(root.querySelectorAll("img"));
    expect(a!.hasAttribute("width")).toBe(false);
    expect(a!.getAttribute("height")).toBe("10");
    expect(b!.style.getPropertyValue("aspect-ratio")).toBe("1 / 1");
  });

  test("lifts an SVG with no natural size at its composed box", async () => {
    class UnsizedImage extends StandInImage {
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("Image", UnsizedImage);
    imagesHaveBoxes();
    vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 40,
      height: 20,
    } as DOMRect);
    const { root, images } = await lifted(
      '<img src="/api/fs/viewbox.svg?t=tok" style="width:40px;height:20px">',
    );

    expect(images.lifted).toHaveLength(1);
    expect(images.lifted[0]).toMatchObject({
      name: "/api/fs/viewbox.svg",
      widthPx: 40,
      heightPx: 20,
    });
    expect(decodeURIComponent(root.querySelector("img")!.getAttribute("src")!)).toContain(
      'width="40" height="20"',
    );
  });

  test("names an unsized image the page shows that gives no measurable box", async () => {
    class UnsizedImage extends StandInImage {
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("Image", UnsizedImage);
    imagesHaveBoxes();
    await expect(
      lifted('<img src="/api/fs/unplaced.svg?t=tok">'),
    ).rejects.toThrow("image /api/fs/unplaced.svg has no measurable size");
  });

  test("an unsized image the page does not show is lifted, and is no failure", async () => {
    class UnsizedImage extends StandInImage {
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("Image", UnsizedImage);
    // jsdom gives no element a box, which is what a closed <details> or a
    // parent that is not displayed does to its image in an engine.
    const lift = lifted(
      '<div style="display:none"><img src="/api/fs/hidden.svg?t=tok"></div>',
    );
    await expect(lift).resolves.toBeDefined();

    const { root, images } = await lift;
    expect(images.lifted).toHaveLength(1);
    expect(images.lifted[0]).toMatchObject({
      name: "/api/fs/hidden.svg",
      rendered: false,
    });
    expect(() => images.assertPainted()).not.toThrow();
    // Its place holds a stand-in, so a page cloned from this one decodes
    // nothing, and the page is still self-contained.
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(
      /^data:image\/svg\+xml,/,
    );
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test("lifts an image once: a second pass over the page decodes nothing", async () => {
    imagesHaveBoxes();
    const { root, images } = await lifted('<img src="/api/fs/photo.png">');
    const held = heldDecodes();
    await liftPageImages(root.cloneNode(true) as HTMLElement, images);
    expect(held).toEqual([]);
    expect(images.lifted).toHaveLength(1);
  });

  test("an attached image with no box is not one the page must paint", async () => {
    // jsdom gives no element a box, which is what a closed <details> does
    // to its image in an engine.
    const { images } = await lifted('<img src="/api/fs/photo.png">');
    expect(images.lifted).toHaveLength(1);
    expect(() => images.assertPainted()).not.toThrow();
  });

  test("an image with a box that no page painted fails by name", async () => {
    imagesHaveBoxes();
    const { images } = await lifted('<img src="/api/fs/shots/a.png?t=tok">');
    expect(() => images.assertPainted()).toThrow(
      "image has no place on the page: /api/fs/shots/a.png",
    );
  });
});

describe("readMarkerBoxes", () => {
  const WIDTH = 12;
  const HEIGHT = 10;

  function raster(
    blocks: { slot: number; x: number; y: number; w: number; h: number; alpha?: number }[],
  ): Uint8ClampedArray {
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (const block of blocks) {
      const [red, green, blue] = markerRgb(block.slot);
      for (let y = block.y; y < block.y + block.h; y++) {
        for (let x = block.x; x < block.x + block.w; x++) {
          data.set([red, green, blue, block.alpha ?? 255], (y * WIDTH + x) * 4);
        }
      }
    }
    return data;
  }

  test("reads each slot's box and null for a slot with no pixel", () => {
    const data = raster([
      { slot: 0, x: 1, y: 2, w: 4, h: 3 },
      { slot: 2, x: 6, y: 0, w: 5, h: 9 },
    ]);
    expect(readMarkerBoxes(data, WIDTH, HEIGHT, 3)).toEqual([
      { x: 1, y: 2, width: 4, height: 3 },
      null,
      { x: 6, y: 0, width: 5, height: 9 },
    ]);
  });

  test("a pixel less than half covered is not part of a box", () => {
    const data = raster([
      { slot: 0, x: 2, y: 2, w: 4, h: 3 },
      { slot: 0, x: 6, y: 2, w: 1, h: 3, alpha: 100 },
    ]);
    expect(readMarkerBoxes(data, WIDTH, HEIGHT, 1)).toEqual([
      { x: 2, y: 2, width: 4, height: 3 },
    ]);
  });

  test("a colour that is no marker's is not read as one", () => {
    const data = raster([{ slot: 1, x: 2, y: 2, w: 4, h: 3 }]);
    // Ink of the page: opaque, and neither a marker nor near one.
    data.set([16, 16, 16, 255], 0);
    data.set([255, 255, 255, 255], 4);
    // The blend of two neighbouring markers lies between two slots.
    const [a] = markerRgb(1);
    const [b] = markerRgb(2);
    const blend = (a + b) / 2;
    data.set([blend, 255 - blend, 128, 255], 8);
    // A marker's red with another green, and a marker's red and green
    // with another blue: each channel has to agree.
    const [red, green, blue] = markerRgb(0);
    data.set([red, green - 60, blue, 255], 12);
    data.set([red, green, blue - 60, 255], 16);
    expect(readMarkerBoxes(data, WIDTH, HEIGHT, 3)).toEqual([
      null,
      { x: 2, y: 2, width: 4, height: 3 },
      null,
    ]);
  });

  test("a slot beyond the ones asked for is not read", () => {
    const data = raster([{ slot: 3, x: 2, y: 2, w: 4, h: 3 }]);
    expect(readMarkerBoxes(data, WIDTH, HEIGHT, 3)).toEqual([null, null, null]);
  });
});

describe("placeLiftedImage", () => {
  const NATURAL = { widthPx: 400, heightPx: 200 };

  test("a box of the image's proportions is filled with the whole image", () => {
    expect(
      placeLiftedImage({ x: 30, y: 50, width: 100, height: 50 }, NATURAL, 0),
    ).toEqual({ x: 30, y: 50, width: 100, height: 50, shownPx: 50, done: true });
  });

  test("a box a pixel off the proportions is still the whole image", () => {
    const place = placeLiftedImage(
      { x: 30, y: 50, width: 101, height: 50 },
      NATURAL,
      0,
    );
    expect(place).toMatchObject({ width: 101, height: 50, done: true });
  });

  test("a shorter box shows the top of the image at its full height", () => {
    // The page cuts the image after 30 of its 50 rows.
    expect(
      placeLiftedImage({ x: 30, y: 50, width: 100, height: 30 }, NATURAL, 0),
    ).toEqual({ x: 30, y: 50, width: 100, height: 50, shownPx: 30, done: false });
  });

  test("the next page starts where the page before left off", () => {
    expect(
      placeLiftedImage({ x: 30, y: 0, width: 100, height: 20 }, NATURAL, 30),
    ).toEqual({ x: 30, y: -30, width: 100, height: 50, shownPx: 50, done: true });
  });

  test("a box taller than the proportions stretches the image over it", () => {
    expect(
      placeLiftedImage({ x: 0, y: 0, width: 100, height: 80 }, NATURAL, 0),
    ).toEqual({ x: 0, y: 0, width: 100, height: 80, shownPx: 80, done: true });
  });
});

describe("a document's images across its pages", () => {
  const BOX = { widthPx: 100, heightPx: 80 };

  beforeEach(() => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("an image cut by a page continues on the next, from where it was cut", async () => {
    // The image is 40 by 20; at a box 40 wide each page shows 12 of its
    // 20 rows at most.
    const root = page('<img src="/api/fs/tall.png">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    const first = standInCanvas({ x: 10, y: 68, w: 40, h: 12 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, { images });
    expect(first.at(-1)!.args.slice(1)).toEqual([10, 68, 40, 20]);

    vi.restoreAllMocks();
    imagesHaveBoxes();
    const second = standInCanvas({ x: 10, y: 0, w: 40, h: 8 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
      images,
      lastPage: true,
    });
    expect(second.at(-1)!.args.slice(1)).toEqual([10, -12, 40, 20]);
  });

  test("a page that shows none of the document's images draws no marker raster twice over", async () => {
    const root = page('<img src="/api/fs/photo.png">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    const first = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, { images });
    expect(first.map((d) => d.what)).toEqual(["page", "markers", "image"]);

    vi.restoreAllMocks();
    imagesHaveBoxes();
    const second = standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
      images,
      lastPage: true,
    });
    expect(second.map((d) => d.what)).toEqual(["page"]);
  });

  test("the last page fails by name for an image no page showed", async () => {
    const root = page('<img src="/api/fs/shots/lost.png?t=tok">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, { images });
    await expect(
      snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
        images,
        lastPage: true,
      }),
    ).rejects.toThrow("image has no place on the page: /api/fs/shots/lost.png");
  });

  test("a deck page fails by name when it cuts the end of an image", async () => {
    const root = page('<img src="/api/fs/shots/cut.png?t=tok">');
    standInCanvas({ x: 10, y: 68, w: 40, h: 12 });

    await expect(snapshotPage(root, BOX)).rejects.toThrow(
      "image has no place on the page: /api/fs/shots/cut.png",
    );
  });

  test("a document's last page fails when an image is still cut", async () => {
    const root = page('<img src="/api/fs/shots/cut.png?t=tok">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    standInCanvas({ x: 10, y: 68, w: 40, h: 12 });

    await expect(
      snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
        images,
        lastPage: true,
      }),
    ).rejects.toThrow("image has no place on the page: /api/fs/shots/cut.png");
  });
});

describe("what an image's address answers with", () => {
  function fetchAnswers(type: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fetchOk("<html>sign in</html>", type)),
    );
  }

  test("a body that is not an image refuses the page and names the image", async () => {
    fetchAnswers("text/html");
    const root = page('<img src="/api/fs/shots/photo.png?t=tok">');
    let failure: unknown = null;
    await inlinePageResources(root).catch((err) => (failure = err));
    expect(failure).toBeInstanceOf(SnapshotError);
    const message = (failure as Error).message;
    expect(message).toContain("/api/fs/shots/photo.png");
    expect(message).toContain("text/html");
    expect(message).not.toContain("tok");
  });

  test("the same holds for an <image> inside an inline SVG", async () => {
    fetchAnswers("text/html; charset=utf-8");
    const root = page(
      '<svg><image href="/api/fs/shots/pic.png?t=tok"></image></svg>',
    );
    let failure: unknown = null;
    await inlinePageResources(root).catch((err) => (failure = err));
    expect(failure).toBeInstanceOf(SnapshotError);
    const message = (failure as Error).message;
    expect(message).toContain("/api/fs/shots/pic.png");
    expect(message).toContain("text/html");
    expect(message).not.toContain("tok");
  });

  test("a body of no declared type is inlined, and its decode decides", async () => {
    // A server with no media type for an extension answers this, and an
    // engine reads an image by its bytes, not by the type it came with.
    fetchAnswers("application/octet-stream");
    const root = page('<img src="/api/fs/shots/photo.webp?t=tok">');
    await inlinePageResources(root);
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:application\/octet-stream;base64,/,
    );
    expect(() => auditSelfContained(root)).not.toThrow();

    const decodes = heldDecodes();
    vi.stubGlobal("Image", StandInImage);
    let failure: unknown = null;
    const lift = liftPageImages(root, new PageImages()).catch(
      (err) => (failure = err),
    );
    await settled();
    decodes[0]!.settle(false);
    await lift;
    expect((failure as Error).message).toBe(
      "image /api/fs/shots/photo.webp could not be decoded",
    );
  });
});

describe("auditSelfContained on images", () => {
  test("refuses a data: URI that is not an image's, on <img> and on <image>", () => {
    const img = page('<img src="data:text/html,%3Cp%3Ehi%3C/p%3E">');
    expect(() => auditSelfContained(img)).toThrow(
      /img src data:text\/html is not an image/,
    );

    const image = page(
      '<svg><image href="data:application/json;base64,e30="></image></svg>',
    );
    expect(() => auditSelfContained(image)).toThrow(
      /image href data:application\/json is not an image/,
    );
  });

  test("names a leaked image without the query its address carries", () => {
    const root = page('<img src="/api/fs/shots/missing.png?t=tok">');
    let message = "";
    try {
      auditSelfContained(root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("img src /api/fs/shots/missing.png");
    expect(message).not.toContain("tok");
  });

  test("refuses an <img> that carries a srcset and names its candidates", () => {
    const root = page(
      '<img src="data:image/png;base64,AAAA" ' +
        'srcset="/api/fs/a.png?t=tok 1x, /api/fs/a@2x.png?t=tok 2x">',
    );
    let message = "";
    try {
      auditSelfContained(root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("img srcset /api/fs/a.png, /api/fs/a@2x.png");
    expect(message).not.toContain("tok");
  });

  test("refuses a <picture> by the candidates its sources offer", () => {
    const root = page(
      "<picture>" +
        '<source srcset="/api/fs/wide.webp?t=tok" media="(min-width: 800px)">' +
        '<img src="data:image/png;base64,AAAA">' +
        "</picture>",
    );
    let message = "";
    try {
      auditSelfContained(root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("source srcset /api/fs/wide.webp");
    expect(message).not.toContain("tok");
    expect(message).not.toContain("disallowed element");
  });
});

describe("an <image> inside an inline SVG", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", StandInImage);
  });

  test("is decoded before the page is drawn, and fails by name when it does not", async () => {
    const decodes = heldDecodes();
    const drawn = standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    const root = page(
      '<svg><image href="/api/fs/shots/pic.png?t=tok"></image></svg>',
    );
    let failure: unknown = null;
    const snapshot = snapshotPage(root, { widthPx: 100, heightPx: 80 }).catch(
      (err) => (failure = err),
    );
    await settled();
    expect(decodes).toHaveLength(1);
    expect(drawn).toEqual([]);

    decodes[0]!.settle(false);
    await snapshot;
    expect((failure as Error).message).toBe(
      "image /api/fs/shots/pic.png could not be decoded",
    );
    expect(drawn).toEqual([]);
    vi.restoreAllMocks();
  });

  test("stays in the page's document once it has decoded", async () => {
    decodesSettleAtOnce();
    const drawn = standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    const root = page(
      '<svg><image href="/api/fs/shots/pic.png?t=tok"></image></svg>',
    );
    await snapshotPage(root, { widthPx: 100, heightPx: 80 });
    expect(root.querySelector("image")?.getAttribute("href")).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(drawn.map((d) => d.what)).toEqual(["page"]);
    vi.restoreAllMocks();
  });
});
