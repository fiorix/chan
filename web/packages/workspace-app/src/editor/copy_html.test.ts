// @vitest-environment jsdom
//
// Rich copy: a selection carrying workspace image refs writes a
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
import { draftClientPath } from "../api/fileIdentity";

const MARK = String.fromCharCode(0);

test("Copy as HTML shows wikilink labels in the body", () => {
  const source = "[[note]] [[note|alias]]";
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml(source, "notes/doc.md", "/ws");
  expect(root.querySelector("p")?.textContent).toBe("note alias");
});

test("copy flavors keep the authored Markdown in text and in the wrapper attribute", () => {
  const md = "[[note|alias]] ![](./a.png)";
  const view = viewWith(md, 0, md.length);
  const ev = copyEvent();
  expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
  expect(ev.store["text/plain"]).toBe(md);
  const doc = new DOMParser().parseFromString(ev.store["text/html"], "text/html");
  expect(doc.querySelector("[data-chan-markdown]")?.getAttribute("data-chan-markdown")).toBe(md);
  expect(doc.querySelector("p")?.textContent).toContain("alias");
  expect(doc.querySelector("p")?.textContent).not.toContain("[[");
  view.destroy();
});

test("copy body labels links on both sides of a frontmatter-looking rule", () => {
  const source = "---\n# Slide 2\n[[b]] ![](./x.png)\n---\n# Slide 3\n[[c]]";
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml(source, "notes/doc.md", "/ws");
  const text = root.textContent ?? "";
  expect(text).toContain("Slide 2");
  expect(text).toContain("Slide 3");
  expect(text).not.toContain("[[b]]");
  expect(text).not.toContain("[[c]]");
  expect(text).not.toContain("[[");
  const spans = [...root.querySelectorAll("span")].map((el) => el.textContent);
  expect(spans).toContain("b");
  expect(spans).toContain("c");
});

test("a copy from the document start keeps frontmatter as typed and labels the body", () => {
  const md = '---\nup: "[[Projects/Parent]]"\n---\n\nSee [[a]] ![](./x.png)';
  const view = viewWith(md, 0, md.length);
  const ev = copyEvent();
  expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
  const doc = new DOMParser().parseFromString(ev.store["text/html"], "text/html");
  const text = doc.querySelector("[data-chan-doc]")?.textContent ?? "";
  expect(text).toContain('up: "[[Projects/Parent]]"');
  expect(text).toContain("See a");
  expect(text).not.toContain("[[a]]");
  view.destroy();
});

test("the upgrade of a copy from the document start keeps frontmatter as typed", async () => {
  const md = '---\nup: "[[Projects/Parent]]"\n---\n\nSee [[a]] ![](./x.png)';
  const view = viewWith(md, 0, md.length);
  expect(handleClipboardCopy(view, copyEvent(), ctx, false)).toBe(true);
  await vi.waitFor(() => expect(writeClipboardHtml).toHaveBeenCalledTimes(1));
  const text = docText(writeClipboardHtml.mock.calls[0]![0]);
  expect(text).toContain('up: "[[Projects/Parent]]"');
  expect(text).toContain("See a");
  view.destroy();
});

test("a copy below the start that begins at a rule labels links on both sides of it", async () => {
  const md = "# Deck\n\n---\n# Slide 2\n[[b]] ![](./x.png)\n---\n# Slide 3\n[[c]]";
  const view = viewWith(md, md.indexOf("---"), md.length);
  const ev = copyEvent();
  expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
  await vi.waitFor(() => expect(writeClipboardHtml).toHaveBeenCalledTimes(1));
  for (const [flavour, html] of [["the event's HTML", ev.store["text/html"]!], ["the upgrade's HTML", writeClipboardHtml.mock.calls[0]![0]]]) {
    const text = docText(html);
    expect(text, flavour).toContain("Slide 3");
    expect(text, flavour).not.toContain("[[");
  }
  view.destroy();
});

test("copy body leaves inline code and fenced code as typed", () => {
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml("`[[note]]`\n\n```text\n[[note]]\n```\n", "notes/doc.md", "/ws");
  expect(root.querySelector("p code")?.textContent).toBe("[[note]]");
  expect(root.querySelector("pre code")?.textContent).toBe("[[note]]\n");
});

// The copy is the one caller that keeps an author's style element, and a
// label span inside one would turn its rules into markup.
test("copy body keeps an inline style element's text as typed and labels the links around it", () => {
  const md = 'See [[a]] <style>a::after{content:"[[x]]"}</style> then [[b]] ![](./a.png)';
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml(md, "notes/doc.md", "/ws");
  // marked escapes the quotes of text between inline tags; the copy kept
  // that text so before it showed labels.
  expect(root.querySelector("[data-chan-doc] style")?.textContent).toBe("a::after{content:&quot;[[x]]&quot;}");
  expect([...root.querySelectorAll("span")].map((el) => el.textContent)).toEqual(["a", "b"]);
});

test("copy body keeps an inline SVG's style element whole", () => {
  const md = 'Text <svg><style>a{content:"[[x]]"}</style></svg> after ![](./a.png)';
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml(md, "notes/doc.md", "/ws");
  expect(root.querySelector("svg style")?.textContent).toBe('a{content:"[[x]]"}');
  expect(root.querySelector("p")?.textContent).toBe('Text a{content:"[[x]]"} after ');
});

test("copy body gives a markup-carrying label no element", () => {
  const label = '<img src=x onerror="alert(1)">';
  const root = document.createElement("div");
  root.innerHTML = buildBaselineHtml(`[[note|${label}]]`, "notes/doc.md", "/ws");
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("p")?.textContent).toContain(label);
});

const ctx: ChanClipboardContext = {
  getCurrentPath: () => "notes/foo.md",
  getUploadDir: () => "notes",
  getWorkspaceRoot: () => "/ws",
};

/// The text of a copied payload's chan-doc wrapper.
function docText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").querySelector("[data-chan-doc]")?.textContent ?? "";
}

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
  test("keeps headings inside a list item and a quote", () => {
    const html = buildBaselineHtml("- # foo\n\n> # foo", null, null);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("li > h1")?.textContent).toBe("foo");
    expect(doc.querySelector("blockquote > h1")?.textContent).toBe("foo");
  });

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

  test("resolves srcs to absolute URLs with no query and tags ordinals", () => {
    const md = "![](./a.png#w=250)\n\n![](./b.png)";
    const html = buildBaselineHtml(md, "notes/foo.md", "/ws");
    expect(html).toContain('data-chan-ref="0"');
    expect(html).toContain('data-chan-ref="1"');
    // Exact, not `toContain`: a prefix match cannot see a query appended
    // to the src, which is where a session bearer would ride along. The
    // tokened case, where this environment has no bearer to leak, is
    // copyHtmlToken.test.ts.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const srcs = Array.from(doc.querySelectorAll("img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(srcs).toEqual([
      "http://localhost:3000/api/fs/notes/a.png",
      "http://localhost:3000/api/fs/notes/b.png",
    ]);
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

describe("the wrapper's origin", () => {
  function wrapperOf(html: string): Element {
    const el = new DOMParser().parseFromString(html, "text/html").querySelector("[data-chan-doc]");
    if (!el) throw new Error("no wrapper");
    return el;
  }

  test("a draft's is its root, its path in the drafts and its lifetime id, never its client path", () => {
    const from = draftClientPath({ path: "untitled/draft.md", draft_id: "life-untitled" });
    const html = buildBaselineHtml("![a](./a.png)", from, "/ws");
    const el = wrapperOf(html);

    expect.soft(el.getAttribute("data-chan-path")).toBe("untitled/draft.md");
    expect.soft(el.getAttribute("data-chan-root")).toBe("draft");
    expect.soft(el.getAttribute("data-chan-draft-id")).toBe("life-untitled");
    expect.soft(el.getAttribute("data-chan-workspace")).toBe("/ws");
    expect.soft(html.includes(MARK), "the mark is not written to the clipboard").toBe(false);
  });

  test("the inlined payload names a draft the same way", async () => {
    const from = draftClientPath({ path: "untitled/draft.md", draft_id: "life-untitled" });
    const html = await buildInlinedHtml("![a](./a.png)", from, "/ws");
    const el = wrapperOf(html);

    expect.soft(el.getAttribute("data-chan-path")).toBe("untitled/draft.md");
    expect.soft(el.getAttribute("data-chan-draft-id")).toBe("life-untitled");
    expect.soft(html.includes(MARK)).toBe(false);
  });

  test("a workspace document's is its path alone", () => {
    const el = wrapperOf(buildBaselineHtml("![a](./a.png)", "notes/foo.md", "/ws"));

    expect(el.getAttribute("data-chan-path")).toBe("notes/foo.md");
    expect(el.hasAttribute("data-chan-root")).toBe(false);
    expect(el.hasAttribute("data-chan-draft-id")).toBe(false);
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

  test("the inlined payload keeps frontmatter as typed when asked", async () => {
    const md = '---\nup: "[[Projects/Parent]]"\n---\n\nSee [[a]] ![](./x.png)';
    const html = await buildInlinedHtml(md, "notes/doc.md", "/ws", true);
    const root = document.createElement("div");
    root.innerHTML = html;
    const text = root.querySelector("[data-chan-doc]")?.textContent ?? "";
    expect(text).toContain('up: "[[Projects/Parent]]"');
    expect(text).toContain("See a");
    expect(text).not.toContain("[[a]]");
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

  // The copied HTML leaves the app, so an author's style element goes with
  // it: it is built in elements never connected to the app's document.
  test("the copied HTML keeps a style element, on the copy event and through the native IPC", async () => {
    const md = "text ![](./a.png)\n\n<style>p{color:red}</style>\n\nafter";
    const view = viewWith(md, 0, md.length);
    const ev = copyEvent();
    expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
    const copied = new DOMParser().parseFromString(ev.store["text/html"]!, "text/html");
    expect(copied.querySelector("[data-chan-doc] style")?.textContent, "the text/html flavour").toBe("p{color:red}");

    await vi.waitFor(() => expect(writeClipboardHtml).toHaveBeenCalledTimes(1));
    const [native] = writeClipboardHtml.mock.calls[0]!;
    const written = new DOMParser().parseFromString(native, "text/html");
    expect(written.querySelector("[data-chan-doc] style")?.textContent, "the native clipboard's HTML").toBe("p{color:red}");
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

  test("keeps frontmatter as typed in the HTML it hands the native write when asked", async () => {
    await writeDocSelectionToClipboard('---\nup: "[[Projects/Parent]]"\n---\n\nSee [[a]] ![](./x.png)', ctx, true);
    expect(writeClipboardHtml).toHaveBeenCalledTimes(1);
    const text = docText(writeClipboardHtml.mock.calls[0]![0]);
    expect(text).toContain('up: "[[Projects/Parent]]"');
    expect(text).toContain("See a");
  });
});
