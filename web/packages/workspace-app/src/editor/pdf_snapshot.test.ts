// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  auditSelfContained,
  inlinePageResources,
  pageSvgDocument,
  SnapshotError,
} from "./pdf_snapshot";

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
});
