// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  auditSelfContained,
  fitBitmap,
  inlinePageResources,
  liftPageImages,
  markerRgb,
  OFFPAGE_ATTR,
  PAGE_BOX_ATTR,
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
  imagesHaveBoxes as mockImageBoxes,
  loadedPageImages,
  settled,
  standInCanvas,
  StandInImage,
} from "../__tests__/snapshotStandIns";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function imagesHaveBoxes(): void {
  mockImageBoxes();
  vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 40, height: 20,
  } as DOMRect);
}

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
  test("prepares the selected srcset image and leaves no competing offer", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
    const root = page('<img src="/api/fs/small.png" srcset="/api/fs/large.png 2x">');
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "currentSrc", { value: "/api/fs/large.png" });

    await inlinePageResources(root);
    await liftPageImages(root, new PageImages());

    expect(fetch).toHaveBeenCalledWith("/api/fs/large.png", expect.anything());
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test("starts independent image fetches before either one settles", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
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

  test("an image that fails stops the fetches of the images after it", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, init?: RequestInit) => {
        if (String(url).includes("first")) {
          return Promise.resolve(fetchOk("<html>sign in</html>", "text/html"));
        }
        // An engine's fetch: it answers nothing and rejects when aborted.
        const signal = init!.signal!;
        signals.push(signal);
        return new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );
    const root = page(
      '<img src="/api/fs/first.png"><img src="/api/fs/second.png">' +
        '<img src="/api/fs/third.png">',
    );
    await expect(inlinePageResources(root)).rejects.toThrow(
      "image /api/fs/first.png is text/html, not an image",
    );

    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("an image that answers after another has failed is not written to the page", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL) => {
        if (String(url).includes("first")) {
          return Promise.resolve(fetchOk("<html>sign in</html>", "text/html"));
        }
        // This one answers late, whatever became of its abort.
        return new Promise<Response>((resolve) => (answer = resolve));
      }),
    );
    const root = page(
      '<svg><image href="/api/fs/first.png?t=secret"></image>' +
        '<image href="/api/fs/second.png"></image></svg>',
    );
    await expect(inlinePageResources(root)).rejects.toThrow(
      "image /api/fs/first.png is text/html, not an image",
    );

    answer(fetchOk(PNG_BYTES, "image/png"));
    await settled();
    expect(
      Array.from(root.querySelectorAll("image")).map((image) =>
        image.getAttribute("href"),
      ),
    ).toEqual(["/api/fs/first.png?t=secret", "/api/fs/second.png"]);
  });

  test("a later decode cannot write after an earlier image fails by name", async () => {
    imagesHaveBoxes();
    const decodes = heldDecodes();
    vi.stubGlobal("Image", StandInImage);
    let firstReply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string | URL) =>
      String(url).includes("first")
        ? new Promise<Response>((resolve) => (firstReply = resolve))
        : Promise.resolve(fetchOk(PNG_BYTES, "image/png")),
    ));
    const root = page(
      '<img src="/api/fs/first.png?t=secret"><img src="/api/fs/second.png">',
    );
    const preparation = inlinePageResources(root);
    await settled();
    expect(decodes).toHaveLength(1);
    firstReply(fetchOk("<html>sign in</html>", "text/html"));
    await expect(preparation).rejects.toThrow(
      "image /api/fs/first.png is text/html, not an image",
    );
    decodes[0]!.settle(true);
    await settled();
    expect(Array.from(root.querySelectorAll("img"), (img) => img.getAttribute("src"))).toEqual([
      "/api/fs/first.png?t=secret", "/api/fs/second.png",
    ]);
    vi.restoreAllMocks();
  });

  test("rewrites img srcs to data: URIs via fetch", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
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
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
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

  test("refuses an unresolvable image by its source name before the audit", async () => {
    const root = page('<img src="/api/fs/missing.png">');
    await expect(inlinePageResources(root)).rejects.toThrow(
      "image /api/fs/missing.png could not be fetched",
    );
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "/api/fs/missing.png",
    );
  });

  test.each([
    ["missing", { ok: false } as Response],
    ["wrong type", fetchOk("<html>sign in</html>", "text/html")],
  ])("a hidden image with a %s answer cannot fail the audit", async (_case, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const root = page('<div style="display:none"><img src="/api/fs/hidden.png"></div>');
    await inlinePageResources(root);
    expect(() => auditSelfContained(root)).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a hidden image that cannot decode is not decoded", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 40;
      naturalHeight = 20;
      decode() { return Promise.reject(new Error("bad image")); }
    });
    const root = page('<div style="display:none"><img src="/api/fs/hidden.png"></div>');
    await inlinePageResources(root);
    const images = new PageImages();
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(false);
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test("a hidden image does not offer its srcset to the audit", async () => {
    const root = page(
      '<div style="display:none"><img src="/api/fs/hidden.png" ' +
        'srcset="/api/fs/hidden@2x.png 2x"></div>',
    );
    await inlinePageResources(root);
    expect(() => auditSelfContained(root)).not.toThrow();
    expect(root.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a hidden picture does not offer its sources to the audit", async () => {
    const root = page(
      '<picture style="display:none">' +
        '<source srcset="/api/fs/hidden.webp" type="image/webp">' +
        '<img src="/api/fs/hidden.png"></picture>',
    );
    await inlinePageResources(root);
    expect(() => auditSelfContained(root)).not.toThrow();
    expect(root.querySelector("source")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a hidden image does not offer its CSS URL to the audit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as Response));
    const root = page(
      '<img src="/api/fs/hidden.png" ' +
        'style="display:none;background-image:url(/api/fs/hidden-bg.png)">',
    );
    await inlinePageResources(root);
    expect(() => auditSelfContained(root)).not.toThrow();
    expect(root.querySelector("img")?.style.display).toBe("none");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a broken image with no box still fails by its source name", async () => {
    const root = page('<img alt="" src="/api/fs/missing.png?t=tok">');
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    Object.defineProperty(img, "naturalHeight", { value: 0 });
    await expect(inlinePageResources(root)).rejects.toThrow(
      "image /api/fs/missing.png could not be fetched",
    );
  });

  test("a loaded image with no box is not fetched or painted", async () => {
    const root = page('<img alt="" src="/api/fs/loaded.png">');
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 40 });
    Object.defineProperty(img, "naturalHeight", { value: 20 });
    await inlinePageResources(root);
    const images = new PageImages();
    await liftPageImages(root, images);
    expect(fetch).not.toHaveBeenCalled();
    expect(images.lifted[0]!.rendered).toBe(false);
  });

  test("an SVG symbol image follows its outer svg and keeps its data href", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    const data = "data:image/png;base64,AAAA";
    const root = page(`<svg><symbol id="picture"><image href="${data}"></image></symbol><use href="#picture"></use></svg>`);
    const outer = root.querySelector("svg")!;
    const image = root.querySelector("image")!;
    Object.defineProperty(outer, "checkVisibility", { value: () => true });
    Object.defineProperty(image, "checkVisibility", { value: () => false });
    const decode = vi.spyOn(StandInImage.prototype, "decode");
    await inlinePageResources(root);
    expect(image.getAttribute("href")).toBe(data);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  test("a hidden SVG image cannot fetch when checkVisibility is unavailable", async () => {
    const root = page('<svg style="display:none"><image href="/api/fs/missing.png"></image></svg>');
    const outer = root.querySelector("svg")!;
    const image = root.querySelector("image")!;
    Object.defineProperty(outer, "checkVisibility", { value: undefined });
    Object.defineProperty(image, "checkVisibility", { value: undefined });
    await inlinePageResources(root);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => auditSelfContained(root)).not.toThrow();
  });

  test.each([
    ["fetch first", '<img src="/api/fs/missing.png"><img src="/api/fs/bad.png">', "missing"],
    ["decode first", '<img src="/api/fs/bad.png"><img src="/api/fs/missing.png">', "bad"],
  ])("%s names the first failing image", async (_case, html, first) => {
    imagesHaveBoxes();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
      String(url).includes("missing") ? { ok: false } as Response :
        fetchOk("bad", "image/png"),
    ));
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 40;
      naturalHeight = 20;
      decode() { return Promise.reject(new Error("bad image")); }
    });
    await expect(snapshotPage(page(html), { widthPx: 100, heightPx: 80 }))
      .rejects.toThrow(`image /api/fs/${first}.png`);
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
    const drawn = standInCanvas({ x: 10, y: 20, w: 80, h: 40 });
    const root = page('<p>text</p><img src="/api/fs/photo.png?t=tok">');
    const snapshot = snapshotPage(root, BOX);
    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(true);
    const result = await snapshot;

    expect(drawn.map((d) => d.what)).toEqual(["page", "markers", "image"]);
    const [bitmap, ...place] = drawn[2]!.args;
    expect((bitmap as StandInImage).src).toMatch(/^data:image\/png;base64,/);
    expect(place).toEqual([10, 20, 80, 40]);
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
    ["the first", [0, 1]],
    ["the second", [1, 0]],
  ])(
    "two images that do not decode fail by the first one's name when %s settles first",
    async (_which, order) => {
      // A retry of the export names the same image, whichever decode the
      // engine happens to finish first.
      standInCanvas({ x: 10, y: 20, w: 40, h: 20 });
      const root = page(
        '<img src="/api/fs/shots/a.png?t=tok"><img src="/api/fs/shots/b.png?t=tok">',
      );
      const snapshot = snapshotPage(root, BOX);
      let failure: unknown = null;
      snapshot.catch((err) => (failure = err));
      await settled();
      expect(decodes).toHaveLength(2);
      for (const index of order) {
        decodes[index]!.settle(false);
        await settled();
      }

      expect((failure as Error | null)?.message).toBe(
        "image /api/fs/shots/a.png could not be decoded",
      );
    },
  );

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

  test("an image with no marker remains in the page document", async () => {
    // The stand-in canvas answers a marker read with no marker at all.
    standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    const root = page('<p>text</p><img src="/api/fs/shots/lost.png?t=tok">');
    const snapshot = snapshotPage(root, BOX);
    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(true);
    await expect(snapshot).resolves.toBeDefined();
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(root.querySelector("img")!.hasAttribute("data-chan-export-image")).toBe(false);
  });
});

describe("liftPageImages", () => {
  beforeEach(() => {
    heldDecodes();
    vi.stubGlobal("Image", StandInImage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLImageElement.prototype as { checkVisibility?: () => boolean }).checkVisibility;
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

  test("a hidden image keeps the size measured before its source changes", async () => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page('<img src="/api/fs/hidden.png" style="visibility:hidden">');
    const img = root.querySelector("img")!;
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 80, height: 40,
    } as DOMRect);
    Object.defineProperty(img, "checkVisibility", { value: () => false });
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== img) return style;
      const small = img.getAttribute("src")?.startsWith("data:image/svg+xml,");
      return new Proxy(style, {
        get(target, property) {
          if (property === "width") return small ? "1px" : "80px";
          if (property === "height") return small ? "1px" : "40px";
          return Reflect.get(target, property);
        },
      });
    });
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    const standIn = decodeURIComponent(img.getAttribute("src")!);
    expect(standIn).toContain('width="80" height="40"');
    expect(img.getAttribute("width")).toBe("80");
    expect(images.lifted[0]!.rendered).toBe(false);
  });

  test.each([
    [false, true],
    [true, false],
  ])("keeps the first visibility answer when later answers change from %s to %s", async (first, later) => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page('<img src="/api/fs/photo.png">');
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 40 });
    Object.defineProperty(img, "naturalHeight", { value: 20 });
    Object.defineProperty(img, "complete", { value: true });
    let calls = 0;
    Object.defineProperty(img, "checkVisibility", {
      value: () => ++calls === 1 ? first : later,
    });
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(first ? 1 : 0);
  });

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
      shape: { shownHeight: 0.5 },
    });
    expect(decodeURIComponent(root.querySelector("img")!.getAttribute("src")!)).toContain(
      'width="40" height="20"',
    );
  });

  test("an image with no natural size stands in at the size its style resolves to", async () => {
    class UnsizedImage extends StandInImage {
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("Image", UnsizedImage);
    imagesHaveBoxes();
    // A slide scaled to half its size, as the export's fit does: the rect
    // is half of what the image takes in the page's layout.
    vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 20,
      height: 10,
    } as DOMRect);
    const { root } = await lifted(
      '<img src="/api/fs/viewbox.svg?t=tok" style="width:40px;height:20px">',
    );

    const img = root.querySelector("img")!;
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain(
      'width="40" height="20"',
    );
    expect(img.getAttribute("width")).toBe("40");
    expect(img.style.getPropertyValue("aspect-ratio")).toBe("40 / 20");
  });

  test("an image the page lays out wider than its natural size stands in that wide", async () => {
    // An SVG that carries only a viewBox reports a natural size in some
    // engines, and that is not the size they lay it out at: it takes the
    // width of what holds it. The image here is 40 by 20.
    imagesHaveBoxes();
    const { root } = await lifted(
      '<img src="/api/fs/viewbox.svg?t=tok" style="width:80px">',
    );

    const img = root.querySelector("img")!;
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain(
      'width="80" height="40"',
    );
    expect(img.getAttribute("width")).toBe("80");
    expect(img.style.getPropertyValue("aspect-ratio")).toBe("40 / 20");
  });

  test("an image narrower than its natural size keeps its intrinsic layout contribution", async () => {
    imagesHaveBoxes();
    const { root } = await lifted(
      '<img src="/api/fs/table.png" style="width:20px">',
    );
    const img = root.querySelector("img")!;
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain(
      'width="40" height="20"',
    );
    expect(img.getAttribute("width")).toBe("40");
  });

  test("a height-sized image restores both measured style lengths after the hint moves it", async () => {
    imagesHaveBoxes();
    decodesSettleAtOnce();
    const root = page('<img src="/api/fs/height.png" style="height:30px">');
    const img = root.querySelector("img")!;
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 225, height: 30,
    } as DOMRect);
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== img) return style;
      return new Proxy(style, {
        get(target, property) {
          if (property === "width") {
            return img.style.maxWidth === "225px" || !img.hasAttribute("width")
              ? "225px" : "669px";
          }
          if (property === "height") return "30px";
          return Reflect.get(target, property);
        },
      });
    });
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    for (const property of ["width", "min-width", "max-width"]) {
      expect(img.style.getPropertyValue(property)).toBe("225px");
    }
    for (const property of ["height", "min-height", "max-height"]) {
      expect(img.style.getPropertyValue(property)).toBe("30px");
    }
    expect(images.lifted[0]!.shape.shownHeight).toBeCloseTo(30 / 225);
  });

  test("a shown image whose style cannot regain its measured box stays in the document", async () => {
    imagesHaveBoxes();
    decodesSettleAtOnce();
    const root = page('<img src="/api/fs/unstable.png" style="height:30px">');
    const img = root.querySelector("img")!;
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 225, height: 30,
    } as DOMRect);
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== img) return style;
      return new Proxy(style, {
        get(target, property) {
          if (property === "width") return img.hasAttribute("width") ? "669px" : "225px";
          if (property === "height") return "30px";
          return Reflect.get(target, property);
        },
      });
    });
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.documentPaint).toBe(true);
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(img.hasAttribute("width")).toBe(false);
    expect(img.getAttribute("style")).toBe("height:30px");
  });

  test("a closed details image with a box is not painted", async () => {
    imagesHaveBoxes();
    Object.defineProperty(HTMLImageElement.prototype, "checkVisibility", {
      configurable: true,
      value(this: HTMLImageElement) {
        return !this.closest("details:not([open])");
      },
    });
    const { images } = await lifted(
      '<details><summary>closed</summary><img src="/api/fs/closed.png"></details>',
    );
    expect(images.lifted[0]!.rendered).toBe(false);
    expect(() => images.assertPainted()).not.toThrow();
  });

  test("an ancestor that clips the whole image records it as not shown", async () => {
    imagesHaveBoxes();
    decodesSettleAtOnce();
    const root = page(
      '<div style="height:0;overflow-x:hidden;overflow-y:hidden"><img src="/api/fs/covered.png"></div>',
    );
    vi.spyOn(root.querySelector("div")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 100, height: 0 } as DOMRect,
    );
    vi.spyOn(root.querySelector("img")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 40, height: 20 } as DOMRect,
    );
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(false);
    expect(() => images.assertPainted()).not.toThrow();
  });

  test("an absolute image skips overflow below its containing block", async () => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page(
      '<div style="position:relative"><div style="height:0;overflow-x:hidden;overflow-y:hidden">' +
        '<img src="/api/fs/absolute.png" style="position:absolute"></div></div>',
    );
    const [holder, inner] = Array.from(root.querySelectorAll("div"));
    vi.spyOn(holder!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 100, height: 100 } as DOMRect,
    );
    vi.spyOn(inner!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 100, height: 0 } as DOMRect,
    );
    vi.spyOn(root.querySelector("img")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 20, width: 40, height: 20 } as DOMRect,
    );
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(true);
  });

  test("a positioned zero-height containing block clips its absolute image", async () => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page(
      '<div style="position:relative;height:0;overflow-x:hidden;overflow-y:hidden">' +
        '<img src="/api/fs/covered.png" style="position:absolute"></div>',
    );
    vi.spyOn(root.querySelector("div")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 100, height: 0 } as DOMRect,
    );
    vi.spyOn(root.querySelector("img")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 20, width: 40, height: 20 } as DOMRect,
    );
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(false);
  });

  test("display contents has no clipping box", async () => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page(
      '<div style="display:contents;overflow-x:hidden;overflow-y:hidden"><img src="/api/fs/contents.png"></div>',
    );
    vi.spyOn(root.querySelector("div")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 0, height: 0 } as DOMRect,
    );
    vi.spyOn(root.querySelector("img")!, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 40, height: 20 } as DOMRect,
    );
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(true);
  });

  test("content-visibility auto does not hide an offscreen export", async () => {
    decodesSettleAtOnce();
    imagesHaveBoxes();
    const root = page('<img src="/api/fs/auto.png">');
    Object.defineProperty(root.querySelector("img")!, "checkVisibility", {
      value: (options?: { contentVisibilityAuto?: boolean }) => !options?.contentVisibilityAuto,
    });
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    expect(images.lifted[0]!.rendered).toBe(true);
  });

  test("reveals an image's auto-visible ancestor before measuring its box", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    const root = page('<section style="content-visibility:auto"><img src="/api/fs/auto.png"></section>');
    const section = root.querySelector("section")!;
    const img = root.querySelector("img")!;
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== section) return style;
      return new Proxy(style, {
        get(target, property) {
          if (property === "contentVisibility") {
            return section.style.getPropertyValue("content-visibility");
          }
          return Reflect.get(target, property);
        },
      });
    });
    Object.defineProperties(img, {
      complete: { value: true },
      naturalWidth: { value: 40 },
      naturalHeight: { value: 20 },
      checkVisibility: { value: () => section.style.getPropertyValue("content-visibility") === "visible" },
    });
    vi.spyOn(img, "getBoundingClientRect").mockImplementation(() => ({
      left: 0, top: 0,
      width: section.style.getPropertyValue("content-visibility") === "visible" ? 40 : 0,
      height: section.style.getPropertyValue("content-visibility") === "visible" ? 20 : 0,
    }) as DOMRect);
    vi.spyOn(img, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);

    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    expect(images.lifted[0]!.rendered).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["rotation", "transform", "matrix(-1, 0, 0, -1, 0, 0)", false],
    ["clip path", "clipPath", "inset(0 0 20% 0)", false],
    ["mask", "maskImage", "linear-gradient(black, transparent)", false],
    ["translation", "transform", "matrix(1, 0, 0, 1, 30, 0)", false],
    ["scale", "transform", "matrix(2, 0, 0, 2, 0, 0)", true],
  ])("an ancestor's %s leaves the image to the right painter", async (
    _case, property, value, shouldLift,
  ) => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
    const root = page('<div><img src="/api/fs/photo.png"></div>');
    const holder = root.querySelector("div")!;
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== holder) return style;
      return new Proxy(style, {
        get(target, key) {
          return key === property ? value : Reflect.get(target, key);
        },
      });
    });

    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    expect(images.lifted).toHaveLength(shouldLift ? 1 : 0);
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(
      shouldLift ? /^data:image\/svg\+xml,/ : /^data:image\/png;base64,/,
    );
  });

  test("a fitted deck slide keeps its image lift with centered scale", async () => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
    const root = page(`<article ${PAGE_BOX_ATTR}><div class="md-slide-preview-content"><img src="/api/fs/photo.png"></div></article>`);
    const holder = root.querySelector(".md-slide-preview-content")!;
    const originalStyle = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = originalStyle(el, pseudo);
      if (el !== holder) return style;
      return new Proxy(style, {
        get(target, key) {
          return key === "transform" ? "matrix(0.8, 0, 0, 0.8, 30, 0)" : Reflect.get(target, key);
        },
      });
    });

    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    expect(images.lifted).toHaveLength(1);
  });

  test("an unsized shown image with no measurable box stays in the document", async () => {
    class UnsizedImage extends StandInImage {
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("Image", UnsizedImage);
    imagesHaveBoxes();
    const { root, images } = await lifted('<img src="/api/fs/unplaced.svg?t=tok">');
    expect(images.lifted).toHaveLength(0);
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
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
    loadedPageImages();
    const { images } = await lifted('<img src="/api/fs/photo.png">');
    expect(images.lifted).toHaveLength(1);
    expect(() => images.assertPainted()).not.toThrow();
  });

  test("an image still loading when measured stays in the page after its decode", async () => {
    decodesSettleAtOnce();
    const root = page('<img alt="" src="/api/fs/pending.png?t=tok">');
    const img = root.querySelector("img")!;
    Object.defineProperty(img, "complete", { value: false });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    Object.defineProperty(img, "naturalHeight", { value: 0 });
    await inlinePageResources(root);
    const images = new PageImages();
    await liftPageImages(root, images);
    expect(images.lifted).toHaveLength(0);
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("an image under a root outside the document is one the page must paint", async () => {
    // An engine resolves no style for an element outside a document:
    // every property reads as the empty string, and that is not an
    // opacity of zero.
    const resolved = getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) =>
      el.isConnected
        ? resolved(el, pseudo)
        : (new Proxy({}, { get: () => "" }) as CSSStyleDeclaration),
    );
    decodesSettleAtOnce();
    const root = document.createElement("div");
    root.innerHTML = '<img src="/api/fs/shots/loose.png?t=tok">';
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    expect(images.lifted).toHaveLength(1);
    expect(images.lifted[0]!.rendered).toBe(true);
    expect(() => images.assertPainted()).toThrow(
      "image has no place on the page: /api/fs/shots/loose.png",
    );
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
  // An image half as tall as wide that fills a box of its own proportions.
  const NATURAL = {
    shownHeight: 0.5,
    bitmap: { x: 0, y: 0, width: 1, height: 0.5 },
  };

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

  test("a marker narrower than the recorded shape has no exact placement", () => {
    expect(
      placeLiftedImage({ x: 30, y: 50, width: 60, height: 50 }, NATURAL, 0, 100),
    ).toBeNull();
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

  // A parent shows the top quarter of the image's box: 100 by 12.5 of a
  // box 100 by 50.
  const TOP_QUARTER = {
    shownHeight: 0.125,
    bitmap: { x: 0, y: 0, width: 1, height: 0.5 },
  };

  test("a box of the shape the page composed is whole, though the bitmap is taller", () => {
    expect(
      placeLiftedImage({ x: 30, y: 50, width: 200, height: 25 }, TOP_QUARTER, 0),
    ).toEqual({ x: 30, y: 50, width: 200, height: 100, shownPx: 25, done: true });
  });

  test("a box shorter than the shape the page composed is a page's cut", () => {
    const first = placeLiftedImage(
      { x: 30, y: 50, width: 200, height: 10 },
      TOP_QUARTER,
      0,
    );
    expect(first).toEqual({
      x: 30,
      y: 50,
      width: 200,
      height: 100,
      shownPx: 10,
      done: false,
    });
    // The next page shows the 15 rows that were left.
    expect(
      placeLiftedImage({ x: 30, y: 0, width: 200, height: 15 }, TOP_QUARTER, 10),
    ).toEqual({ x: 30, y: -10, width: 200, height: 100, shownPx: 25, done: true });
  });

  test("a bitmap that lies inside its box keeps its place when the box is cut", () => {
    // The bitmap takes the middle half of a box as tall as wide.
    const inside = {
      shownHeight: 1,
      bitmap: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    };
    expect(
      placeLiftedImage({ x: 0, y: 0, width: 100, height: 40 }, inside, 30),
    ).toEqual({ x: 25, y: -5, width: 50, height: 50, shownPx: 70, done: false });
  });
});

describe("fitBitmap", () => {
  const BOX = { x: 10, y: 20, width: 200, height: 50 };
  const NATURAL = { width: 100, height: 100 };

  test.each([
    ["fill", { x: 10, y: 20, width: 200, height: 50 }],
    ["contain", { x: 85, y: 20, width: 50, height: 50 }],
    ["cover", { x: 10, y: -55, width: 200, height: 200 }],
    ["none", { x: 60, y: -5, width: 100, height: 100 }],
    ["scale-down", { x: 85, y: 20, width: 50, height: 50 }],
  ])("%s", (fit, place) => {
    expect(fitBitmap(fit, BOX, NATURAL)).toEqual(place);
  });

  test("scale-down leaves a bitmap smaller than its box at its own size", () => {
    expect(fitBitmap("scale-down", BOX, { width: 40, height: 20 })).toEqual({
      x: 90,
      y: 35,
      width: 40,
      height: 20,
    });
  });

  test("a bitmap with no natural size fills the box whatever the fit", () => {
    expect(fitBitmap("contain", BOX, { width: 0, height: 0 })).toEqual(BOX);
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

    const first = standInCanvas({ x: 10, y: 68, w: 80, h: 12 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, { images });
    expect(first.at(-1)!.args.slice(1)).toEqual([10, 68, 80, 40]);

    vi.restoreAllMocks();
    imagesHaveBoxes();
    const second = standInCanvas({ x: 10, y: 0, w: 80, h: 28 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
      images,
      lastPage: true,
    });
    expect(second.at(-1)!.args.slice(1)).toEqual([10, -12, 80, 40]);
  });

  test("a page that shows none of the document's images draws no marker raster twice over", async () => {
    const root = page('<img src="/api/fs/photo.png">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    const first = standInCanvas({ x: 10, y: 20, w: 80, h: 40 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, { images });
    expect(first.map((d) => d.what)).toEqual(["page", "markers", "image"]);

    vi.restoreAllMocks();
    imagesHaveBoxes();
    const second = standInCanvas({ x: 10, y: 20, w: 80, h: 40 });
    await snapshotPage(root.cloneNode(true) as HTMLElement, BOX, {
      images,
      lastPage: true,
    });
    expect(second.map((d) => d.what)).toEqual(["page"]);
  });

  test("a document image with no marker remains in its page document", async () => {
    const root = page('<img src="/api/fs/shots/lost.png?t=tok">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);

    standInCanvas({ x: 0, y: 0, w: 0, h: 0 });
    const first = root.cloneNode(true) as HTMLElement;
    await snapshotPage(first, BOX, { images });
    expect(first.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    const last = root.cloneNode(true) as HTMLElement;
    await snapshotPage(last, BOX, { images, lastPage: true });
    expect(last.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  test("an image beyond the last page window is left to that page", async () => {
    const root = page('<img src="/api/fs/shots/beyond.png">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    const last = root.cloneNode(true) as HTMLElement;
    last.querySelector("img")!.setAttribute(OFFPAGE_ATTR, "");
    standInCanvas({ x: 0, y: 0, w: 0, h: 0 });

    await expect(snapshotPage(last, BOX, { images, lastPage: true })).resolves.toBeDefined();
    expect(last.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(() => images.assertPainted()).not.toThrow();
  });

  test("a deck page leaves an image it cuts to its document", async () => {
    const root = page('<img src="/api/fs/shots/cut.png?t=tok">');
    standInCanvas({ x: 10, y: 68, w: 80, h: 12 });

    await expect(snapshotPage(root, BOX)).resolves.toBeDefined();
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  test("a document's last page leaves a remaining cut to its document", async () => {
    const root = page('<img src="/api/fs/shots/cut.png?t=tok">');
    const images = new PageImages();
    await inlinePageResources(root);
    await liftPageImages(root, images);
    standInCanvas({ x: 10, y: 68, w: 80, h: 12 });

    const last = root.cloneNode(true) as HTMLElement;
    await expect(snapshotPage(last, BOX, { images, lastPage: true })).resolves.toBeDefined();
    expect(last.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("an image the page shows in a box of another shape than its own", () => {
  const BOX = { widthPx: 100, heightPx: 80 };

  beforeEach(() => {
    decodesSettleAtOnce();
    vi.stubGlobal("Image", StandInImage);
    imagesHaveBoxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /// Give an element the box an engine laid it out at; jsdom lays out
  /// nothing.
  function laidOut(
    el: Element,
    box: { left: number; top: number; width: number; height: number },
  ): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(box as DOMRect);
  }

  /// Snapshot the page as a whole export and return where its one image
  /// was drawn. The image is 40 by 20; the page is drawn at two raster px
  /// for one of its own.
  async function drawnAt(root: HTMLElement): Promise<unknown[]> {
    const drawn = standInCanvas(MARKER);
    const snapshot = snapshotPage(root, BOX);
    await expect(snapshot).resolves.toBeDefined();
    expect(drawn.map((d) => d.what)).toEqual(["page", "markers", "image"]);
    return drawn[2]!.args.slice(1);
  }

  let MARKER: { x: number; y: number; w: number; h: number };

  test("a width and a height squash it: it is whole, and drawn over that box", async () => {
    const root = page(
      '<img src="/api/fs/shots/wide.png" style="width:40px;height:10px">',
    );
    laidOut(root.querySelector("img")!, { left: 0, top: 0, width: 40, height: 10 });
    MARKER = { x: 10, y: 20, w: 80, h: 20 };

    expect(await drawnAt(root)).toEqual([10, 20, 80, 20]);
  });

  test.each([
    // The image keeps its proportions inside the box: half as wide.
    ["contain", [30, 20, 40, 20]],
    // The image covers the box and the box shows its middle rows.
    ["cover", [10, 10, 80, 40]],
  ])("object-fit %s places it in that box as the page does", async (fit, place) => {
    const root = page(
      `<img src="/api/fs/shots/wide.png" style="width:40px;height:10px;object-fit:${fit}">`,
    );
    laidOut(root.querySelector("img")!, { left: 0, top: 0, width: 40, height: 10 });
    MARKER = { x: 10, y: 20, w: 80, h: 20 };

    expect(await drawnAt(root)).toEqual(place);
  });

  test("the box is the image's content box, inside its border and padding", async () => {
    // A border box 60 by 40 around a content box 40 by 20: read as one
    // shape, the marker of the content box would be short of it.
    const root = page(
      '<img src="/api/fs/shots/wide.png" style="border:4px solid;padding:6px">',
    );
    laidOut(root.querySelector("img")!, { left: 0, top: 0, width: 60, height: 40 });
    MARKER = { x: 10, y: 20, w: 80, h: 40 };

    expect(await drawnAt(root)).toEqual([10, 20, 80, 40]);
  });

  test("a box of the page's own leaves a cut image in the document", async () => {
    const root = page(
      `<article ${PAGE_BOX_ATTR} style="height:6px;overflow-x:hidden;overflow-y:hidden">` +
        '<img src="/api/fs/shots/cut.png?t=tok"></article>',
    );
    laidOut(root.querySelector("article")!, { left: 0, top: 0, width: 100, height: 6 });
    laidOut(root.querySelector("img")!, { left: 0, top: 0, width: 40, height: 20 });
    standInCanvas({ x: 10, y: 68, w: 80, h: 12 });

    await expect(snapshotPage(root, BOX)).resolves.toBeDefined();
    expect(root.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  test("a parent that hides what overflows it shows its top: it is whole there", async () => {
    const root = page(
      '<div style="height:5px;overflow-x:hidden;overflow-y:hidden">' +
        '<img src="/api/fs/shots/wide.png"></div>',
    );
    laidOut(root.querySelector("div")!, { left: 0, top: 0, width: 100, height: 5 });
    laidOut(root.querySelector("img")!, { left: 0, top: 0, width: 40, height: 20 });
    // The page shows 5 of the image's 20 rows, and no page cut it.
    MARKER = { x: 10, y: 20, w: 80, h: 10 };

    expect(await drawnAt(root)).toEqual([10, 20, 80, 40]);
  });

  test("a fractional CSS box scales a bitmap by its exact used size", async () => {
    const root = page(
      '<img src="/api/fs/shots/fit.png" style="width:10.4px;height:10.4px;object-fit:none">',
    );
    laidOut(root.querySelector("img")!, {
      left: 0, top: 0, width: 20.8, height: 20.8,
    });
    MARKER = { x: 10, y: 20, w: 80, h: 80 };
    const place = await drawnAt(root);
    expect(place[2]).toBeCloseTo(80 * 80 / 20.8, 1);
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
    imagesHaveBoxes();
    const root = page('<img src="/api/fs/shots/photo.webp?t=tok">');
    const decodes = heldDecodes();
    vi.stubGlobal("Image", StandInImage);
    let failure: unknown = null;
    const preparation = inlinePageResources(root).catch(
      (err) => (failure = err),
    );
    await settled();
    expect(decodes[0]!.src).toMatch(/^data:application\/octet-stream;base64,/);
    decodes[0]!.settle(false);
    await preparation;
    expect((failure as Error).message).toBe(
      "image /api/fs/shots/photo.webp could not be decoded",
    );
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "/api/fs/shots/photo.webp?t=tok",
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
