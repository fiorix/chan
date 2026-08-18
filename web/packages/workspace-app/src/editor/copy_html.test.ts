// @vitest-environment jsdom
//
// WP14 rich copy: a selection carrying workspace image refs writes a
// text/plain (exact markdown) + text/html (wrapper with inlined data:
// images) payload. Text-only selections stay byte-identical to CM6's
// default (the handler returns false). The desktop clipboard path is
// mocked so the async upgrade never needs a real ClipboardItem.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const writeClipboardHtml = vi.fn().mockResolvedValue(undefined);
vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => true,
  writeClipboardHtml: (html: string, alt: string) => writeClipboardHtml(html, alt),
}));

import {
  buildBaselineHtml,
  buildInlinedHtml,
  findWorkspaceImageRefs,
  handleClipboardCopy,
  isWorkspaceImageSrc,
  splitImageSrc,
  writeDocSelectionToClipboard,
  type ChanClipboardContext,
} from "./copy_html";

const ctx: ChanClipboardContext = {
  getCurrentPath: () => "notes/foo.md",
  getUploadDir: () => "notes",
  getWorkspaceRoot: () => "/ws",
};

/// A view over `doc` with `[from,to)` selected. Read-only builds set the
/// editable facet off so the cut guard can be exercised.
function viewWith(doc: string, from: number, to: number, editable = true): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(from, to),
      extensions: editable ? [] : [EditorView.editable.of(false)],
    }),
  });
}

/// A minimal copy/cut event recording its setData calls.
function copyEvent(): ClipboardEvent & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      setData: (type: string, val: string) => {
        store[type] = val;
      },
      getData: (type: string) => store[type] ?? "",
    },
    store,
  } as unknown as ClipboardEvent & { store: Record<string, string> };
}

beforeEach(() => {
  writeClipboardHtml.mockClear();
  // Default: no network, so the async upgrade degrades to absolute URLs.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no net")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitImageSrc / isWorkspaceImageSrc", () => {
  test("splits the fragment verbatim", () => {
    expect(splitImageSrc("./a.png#w=2&left")).toEqual({
      base: "./a.png",
      fragment: "#w=2&left",
    });
    expect(splitImageSrc("./a.png")).toEqual({ base: "./a.png", fragment: "" });
  });

  test("workspace raster images only", () => {
    expect(isWorkspaceImageSrc("./a.png#w=1")).toBe(true);
    expect(isWorkspaceImageSrc("/abs/b.jpeg")).toBe(true);
    expect(isWorkspaceImageSrc("https://x/a.png")).toBe(false);
    expect(isWorkspaceImageSrc("data:image/png;base64,AA")).toBe(false);
    expect(isWorkspaceImageSrc("blob:x")).toBe(false);
    expect(isWorkspaceImageSrc("./notes.md")).toBe(false);
    expect(isWorkspaceImageSrc("./board.excalidraw")).toBe(false);
  });
});

describe("findWorkspaceImageRefs", () => {
  test("captures alt, base, fragment, ordinal and offsets", () => {
    const md = "![alt](./x.png#w=200&left)";
    const [r] = findWorkspaceImageRefs(md);
    expect(r.ordinal).toBe(0);
    expect(r.alt).toBe("alt");
    expect(r.base).toBe("./x.png");
    expect(r.fragment).toBe("#w=200&left");
    expect(md.slice(r.srcStart, r.srcEnd)).toBe("./x.png#w=200&left");
    expect(md.slice(r.start, r.end)).toBe(md);
  });

  test("skips http / data / non-image refs and does not consume their ordinal", () => {
    const md =
      "![a](./x.png) x ![](https://c/y.png) ![](data:image/png;base64,AAAA) ![b](./z%20w.jpg)";
    const refs = findWorkspaceImageRefs(md);
    expect(refs.map((r) => r.base)).toEqual(["./x.png", "./z%20w.jpg"]);
    expect(refs.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  test("encoded name offsets round-trip", () => {
    const md = "prefix ![](./My%20Photo.png#w=250) suffix";
    const [r] = findWorkspaceImageRefs(md);
    expect(r.base).toBe("./My%20Photo.png");
    expect(md.slice(r.srcStart, r.srcEnd)).toBe("./My%20Photo.png#w=250");
  });
});

describe("buildBaselineHtml (wrapper + resolution + tagging)", () => {
  test("wrapper attributes round-trip through the paste-side parser", () => {
    const md = 'title "quoted" & <b> #hash\n![](./a.png)';
    const html = buildBaselineHtml(md, "notes/foo.md", "/ws");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector("[data-chan-markdown]");
    expect(root?.getAttribute("data-chan-markdown")).toBe(md);
    expect(root?.getAttribute("data-chan-workspace")).toBe("/ws");
    expect(root?.getAttribute("data-chan-path")).toBe("notes/foo.md");
    expect(root?.getAttribute("data-chan-doc")).toBe("1");
  });

  test("resolves srcs to absolute tokenless URLs and tags ordinals", () => {
    const md = "![](./a.png#w=250)\n\n![](./b.png)";
    const html = buildBaselineHtml(md, "notes/foo.md", "/ws");
    expect(html).toContain('data-chan-ref="0"');
    expect(html).toContain('data-chan-ref="1"');
    expect(html).toContain("http://localhost:3000/api/fs/notes/a.png");
    expect(html).toContain("http://localhost:3000/api/fs/notes/b.png");
  });

  test("count guard: a reference-style image the regex misses skips tagging", () => {
    // marked renders the `<img>` but findWorkspaceImageRefs's inline regex
    // does not match `![alt][id]`, so the counts differ and no ordinal is
    // tagged; the markdown attribute still carries everything.
    const md = "![alt][id]\n\n[id]: ./a.png";
    const html = buildBaselineHtml(md, "notes/foo.md", "/ws");
    expect(html).not.toContain("data-chan-ref");
    expect(html).toContain("/api/fs/notes/a.png");
  });
});

describe("buildInlinedHtml (fetch + degrade + budget)", () => {
  test("inlines a fetched image and keeps a failed fetch on its URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("a.png")) {
          return {
            ok: true,
            blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
          };
        }
        return { ok: false };
      }),
    );
    const md = "![](./a.png)\n\n![](./missing.png)";
    const html = await buildInlinedHtml(md, "notes/foo.md", "/ws");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("/api/fs/notes/missing.png");
  });

  test("an over-budget image keeps its absolute URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 21 * 1024 * 1024 }) })),
    );
    const html = await buildInlinedHtml("![](./big.png)", "notes/foo.md", "/ws");
    expect(html).not.toContain("data:");
    expect(html).toContain("/api/fs/notes/big.png");
  });
});

describe("handleClipboardCopy", () => {
  test("text-only selection returns false and does not preventDefault", () => {
    const view = viewWith("hello world", 0, 5);
    const ev = copyEvent();
    expect(handleClipboardCopy(view, ev, ctx, false)).toBe(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(ev.store["text/html"]).toBeUndefined();
    view.destroy();
  });

  test("selection with an image ref writes both flavors and preventDefaults", () => {
    const md = "text ![](./a.png#w=250) more";
    const view = viewWith(md, 0, md.length);
    const ev = copyEvent();
    expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.store["text/plain"]).toBe(md);
    expect(ev.store["text/html"]).toContain("data-chan-markdown");
    expect(ev.store["text/html"]).toContain('data-chan-ref="0"');
    view.destroy();
  });

  test("cut deletes the selection when editable", () => {
    const md = "x ![](./a.png) y";
    const view = viewWith(md, 0, md.length, true);
    handleClipboardCopy(view, copyEvent(), ctx, true);
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  test("read-only cut writes but does NOT delete", () => {
    const md = "x ![](./a.png) y";
    const view = viewWith(md, 0, md.length, false);
    const ev = copyEvent();
    handleClipboardCopy(view, ev, ctx, true);
    expect(ev.store["text/html"]).toContain("data-chan-markdown");
    expect(view.state.doc.toString()).toBe(md);
    view.destroy();
  });
});

describe("writeDocSelectionToClipboard (desktop path)", () => {
  test("writes html + the exact markdown through the native IPC", async () => {
    await writeDocSelectionToClipboard("![](./a.png#w=1)", ctx);
    expect(writeClipboardHtml).toHaveBeenCalledTimes(1);
    const [html, plain] = writeClipboardHtml.mock.calls[0]!;
    expect(plain).toBe("![](./a.png#w=1)");
    expect(html).toContain("data-chan-markdown");
  });
});
