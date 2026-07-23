// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  contentStyle,
  prepareSlideImages,
  renderSlideDiagrams,
  renderSlideMarkdown,
  slideMediaCss,
  slidePageBoxStyle,
  slidePreviewCss,
} from "./slide_dom";

const deferred = vi.hoisted(() => ({
  resolveMermaid: undefined as
    | ((value: { ok: boolean; svg?: string; error?: string }) => void)
    | undefined,
  resolveExcalidrawFile: undefined as
    | ((value: { ok: boolean; svg?: string; error?: string }) => void)
    | undefined,
}));

vi.mock("./mermaid_render", () => ({
  renderMermaid: vi.fn(
    () =>
      new Promise((resolve) => {
        deferred.resolveMermaid = resolve;
      }),
  ),
}));

vi.mock("./excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-excalidraw-diagram-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
  renderExcalidrawFile: vi.fn(
    () =>
      new Promise((resolve) => {
        deferred.resolveExcalidrawFile = resolve;
      }),
  ),
}));

afterEach(() => {
  deferred.resolveMermaid = undefined;
  deferred.resolveExcalidrawFile = undefined;
  document.body.innerHTML = "";
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("renderSlideMarkdown", () => {
  test("preserves extra blank lines as spacer divs", () => {
    const html = renderSlideMarkdown("# T\n\n\n\nafter gap\n");
    const root = mount(html);
    expect(root.querySelectorAll(".chan-slide-blank-line")).toHaveLength(2);
    expect(root.textContent).toContain("after gap");
  });

  test("collapses a leading blank run without spacers", () => {
    // Blank lines above the first content line are page-separator
    // whitespace retained by the deck split, not authored spacing.
    const html = renderSlideMarkdown("\n\n# T\n\nbody\n");
    const root = mount(html);
    expect(root.querySelectorAll(".chan-slide-blank-line")).toHaveLength(0);
    expect(root.firstElementChild?.tagName).toBe("H1");
    expect(root.textContent).toContain("body");
  });

  test("collapses a trailing blank run without spacers", () => {
    const html = renderSlideMarkdown("# T\n\nbody\n\n\n");
    const root = mount(html);
    expect(root.querySelectorAll(".chan-slide-blank-line")).toHaveLength(0);
    expect(root.textContent).toContain("body");
  });

  test("keeps blank lines inside fences literal", () => {
    const html = renderSlideMarkdown("```\na\n\n\nb\n```\n");
    const root = mount(html);
    expect(root.querySelectorAll(".chan-slide-blank-line")).toHaveLength(0);
    expect(root.querySelector("pre")?.textContent).toContain("a\n\n\nb");
  });
});

describe("renderSlideDiagrams completion", () => {
  test("the returned promise resolves only after the diagram painted", async () => {
    const markdown = "```mermaid\nflowchart LR\n  A --> B\n```\n";
    const root = mount(renderSlideMarkdown(markdown));

    let settled = false;
    const completion = renderSlideDiagrams(root, markdown, "dark", () => true).then(
      () => {
        settled = true;
      },
    );

    // The fence is replaced by the shell synchronously; the render is
    // still pending, so the completion promise must not have settled.
    expect(root.querySelector("code.language-mermaid")).toBeNull();
    expect(root.querySelector(".md-slide-diagram-body")?.textContent).toBe(
      "rendering...",
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    deferred.resolveMermaid!({ ok: true, svg: "<svg data-done></svg>" });
    await completion;
    expect(settled).toBe(true);
    expect(root.querySelector(".md-slide-diagram-body svg")).not.toBeNull();
  });

  test("a failed render resolves the completion with the error shell", async () => {
    const markdown = "```mermaid\nbroken\n```\n";
    const root = mount(renderSlideMarkdown(markdown));

    const completion = renderSlideDiagrams(root, markdown, "light", () => true);
    deferred.resolveMermaid!({ ok: false, error: "parse error" });
    await completion;

    const body = root.querySelector(".md-slide-diagram-body");
    expect(body?.classList.contains("md-slide-diagram-error")).toBe(true);
    expect(body?.textContent).toContain("parse error");
  });

  test("a stale isCurrent guard skips the apply but still settles", async () => {
    const markdown = "```mermaid\nflowchart LR\n  A --> B\n```\n";
    const root = mount(renderSlideMarkdown(markdown));

    const completion = renderSlideDiagrams(root, markdown, "dark", () => false);
    deferred.resolveMermaid!({ ok: true, svg: "<svg data-stale></svg>" });
    await completion;
    expect(root.querySelector(".md-slide-diagram-body svg")).toBeNull();
    expect(root.querySelector(".md-slide-diagram-body")?.textContent).toBe(
      "rendering...",
    );
  });
});

describe("prepareSlideImages", () => {
  test("resolves plain image srcs synchronously and applies the size grammar", () => {
    const root = mount('<p><img src="photo.png#w=120&right"></p>');
    void prepareSlideImages(root, "notes/deck.md", "light", () => true);

    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).not.toContain("#w=");
    expect(img.style.width).toBe("120px");
    expect(img.classList.contains("chan-slide-align-right")).toBe(true);
    expect(img.parentElement?.classList.contains("chan-slide-media")).toBe(true);
  });

  test("completion tracks async Excalidraw embed renders", async () => {
    const root = mount('<p><img src="board.excalidraw"></p>');

    let settled = false;
    const completion = prepareSlideImages(root, "notes/deck.md", "dark", () => true).then(
      () => {
        settled = true;
      },
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".md-slide-excalidraw-body")?.textContent).toBe(
      "rendering...",
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    deferred.resolveExcalidrawFile!({ ok: true, svg: "<svg data-board></svg>" });
    await completion;
    expect(settled).toBe(true);
    expect(root.querySelector(".md-slide-excalidraw-body svg")).not.toBeNull();
  });

  test("retargets links to a new tab", () => {
    const root = mount('<p><a href="https://example.com">x</a></p>');
    void prepareSlideImages(root, null, "light", () => true);
    const link = root.querySelector("a")!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("slidePageBoxStyle", () => {
  test("emits an explicit pixel box with the padding clamp resolved", () => {
    const style = slidePageBoxStyle(
      { widthPx: 1123, heightPx: 794 },
      null,
      "dark",
    );
    expect(style).toContain("width:1123px");
    expect(style).toContain("height:794px");
    expect(style).toContain("overflow:hidden");
    expect(style).toContain("color-scheme:dark");
    // clamp(22, 4% of 1123 = 44.92, 54)
    expect(style).toContain("padding:44.92px");
  });

  test("clamps padding at both ends", () => {
    expect(
      slidePageBoxStyle({ widthPx: 400, heightPx: 300 }, null, "light"),
    ).toContain("padding:22px");
    expect(
      slidePageBoxStyle({ widthPx: 2000, heightPx: 1500 }, null, "light"),
    ).toContain("padding:54px");
  });

  test("an explicit padding overrides the box-derived clamp", () => {
    // The deck export resolves the preview's viewport clamp itself and
    // passes the result, so the box width no longer implies the padding.
    expect(
      slidePageBoxStyle({ widthPx: 1238.4, heightPx: 928.8 }, null, "light", 54),
    ).toContain("padding:54px");
  });
});

describe("slide page css", () => {
  test("contentStyle zooms via the CSS zoom property", () => {
    expect(contentStyle(1.5)).toContain("zoom:1.5");
    expect(contentStyle(Number.NaN)).toContain("zoom:2");
  });

  test("slidePreviewCss includes the shared media rules under the page scope", () => {
    const css = slidePreviewCss();
    expect(css).toContain(".md-slide-preview-page .chan-slide-media {");
    expect(css).toContain(
      ".md-slide-preview-page .md-slide-diagram-body svg {",
    );
  });

  test("slideMediaCss scopes every rule under the given scope", () => {
    const css = slideMediaCss(".x-scope");
    const selectors = css
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter(Boolean);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim().startsWith(".x-scope ")).toBe(true);
      }
    }
  });
});
