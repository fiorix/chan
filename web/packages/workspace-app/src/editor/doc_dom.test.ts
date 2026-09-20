// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { DOC_CONTAINER_CLASS,
  DOC_CONTENT_CLASS, buildDocDom, docCss } from "./doc_dom";
import {
  PAGE_BREAK_ATTR,
  PAGE_BREAK_CHILD_SELECTOR,
  PAGE_BREAK_SELECTOR,
} from "./page_break";

vi.mock("./mermaid_render", () => ({
  renderMermaid: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-mermaid-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

vi.mock("./excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
  renderExcalidrawFile: vi.fn(async (_url: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-excalidraw-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("buildDocDom", () => {
  test("renders markdown into a scoped, width-fixed container", () => {
    const { root, content } = buildDocDom({
      markdown: "# Title\n\nbody text\n",
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 669,
    });
    document.body.append(root);

    expect(root.classList.contains(DOC_CONTAINER_CLASS)).toBe(true);
    expect(root.style.width).toBe("669px");
    expect(root.style.colorScheme).toBe("light");
    expect(root.querySelector("style")?.textContent).toContain(
      `.${DOC_CONTAINER_CLASS} h1`,
    );
    expect(content.querySelector("h1")?.textContent).toBe("Title");
    expect(content.textContent).toContain("body text");
  });

  test("hydrates mermaid fences through the slide renderer path", async () => {
    const { root, completion } = buildDocDom({
      markdown: "```mermaid\nflowchart LR\n  A --> B\n```\n",
      path: "notes/doc.md",
      theme: "dark",
      contentWidthPx: 669,
    });
    document.body.append(root);

    await completion;
    expect(root.querySelector("code.language-mermaid")).toBeNull();
    expect(
      root.querySelector(".md-slide-diagram svg")?.getAttribute(
        "data-mermaid-theme",
      ),
    ).toBe("dark");
  });

  test("hydrates excalidraw embeds and image grammar", async () => {
    const { root, completion } = buildDocDom({
      markdown: "![](board.excalidraw)\n\n![](photo.png#w=120&right)\n",
      path: "notes/doc.md",
      theme: "dark",
      contentWidthPx: 669,
    });
    document.body.append(root);

    // The completion waits for the images as well as the renders, and
    // jsdom never loads one, so the photo settles here.
    for (const img of Array.from(root.querySelectorAll("img"))) {
      img.dispatchEvent(new Event("load"));
    }
    await completion;
    expect(
      root.querySelector(".md-slide-excalidraw-body svg")?.getAttribute(
        "data-excalidraw-theme",
      ),
    ).toBe("dark");
    const img = root.querySelector("img")!;
    expect(img.style.width).toBe("120px");
    expect(img.classList.contains("chan-slide-align-right")).toBe(true);
  });

  test("the content box traps child margins for BFC-invariant measurement", () => {
    const { root, content } = buildDocDom({
      markdown: "# Title\n\nbody\n",
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 669,
    });
    document.body.append(root);
    // Block offsets are measured relative to the content box and
    // replayed inside clipping page clones; without a BFC on the
    // content box the first block's margin escapes during measurement
    // but is trapped in the clones, shifting every cut.
    expect(content.style.display).toBe("flow-root");
  });

  test("keeps page-break markers invisible", () => {
    const { root } = buildDocDom({
      markdown: 'a\n\n<hr class="chan-page-break">\n\nb\n',
      path: "doc.md",
      theme: "light",
      contentWidthPx: 669,
    });
    document.body.append(root);
    const hr = root.querySelector<HTMLElement>("hr.chan-page-break");
    expect(hr).not.toBeNull();
    // The rule selects the mark the composition applies, which is the
    // only way to say "and no other attribute" to CSS.
    expect(hr!.matches(PAGE_BREAK_SELECTOR)).toBe(true);
    expect(docCss()).toContain(
      `.${DOC_CONTAINER_CLASS} > .${DOC_CONTENT_CLASS} > ${PAGE_BREAK_SELECTOR}`,
    );
  });

  test("does not style a nested hr that acquires the mark later", () => {
    const { root, content } = buildDocDom({
      markdown: "a\n\n> quoted\n\nb\n",
      path: "doc.md",
      theme: "light",
      contentWidthPx: 669,
    });
    document.body.append(root);
    // Whatever runs after the marking walk, a diagram's HTML label for
    // instance, can put the attribute on an element the walk never saw.
    const hr = document.createElement("hr");
    hr.setAttribute("class", "chan-page-break");
    hr.setAttribute(PAGE_BREAK_ATTR, "");
    content.querySelector("blockquote")!.append(hr);
    expect(hr.matches(PAGE_BREAK_SELECTOR)).toBe(true);
    expect(content.querySelector(PAGE_BREAK_CHILD_SELECTOR)).toBeNull();
  });

  test("leaves a near miss as the ordinary rule it is", () => {
    const { root } = buildDocDom({
      markdown: 'a\n\n<hr class="chan-page-break extra">\n\nb\n',
      path: "doc.md",
      theme: "light",
      contentWidthPx: 669,
    });
    document.body.append(root);
    const hr = root.querySelector<HTMLElement>("hr");
    expect(hr).not.toBeNull();
    expect(hr!.matches(PAGE_BREAK_SELECTOR)).toBe(false);
  });

  test("keeps the live body override while copying the theme's em code ratio", () => {
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      backgroundColor: "rgb(255, 255, 255)",
      color: "rgb(31, 35, 40)",
      fontFamily: "sans-serif",
      fontSize: "20px",
      getPropertyValue: (name: string) =>
        name === "--chan-editor-code-size" ? "0.85em" : "",
    } as CSSStyleDeclaration);
    const { root } = buildDocDom({
      markdown: "body",
      path: "doc.md",
      theme: "light",
      contentWidthPx: 669,
    });

    expect(root.style.fontSize).toBe("var(--chan-editor-body-size,20px)");
    expect(root.style.getPropertyValue("--chan-editor-body-size")).toBe("");
    expect(root.style.getPropertyValue("--chan-editor-code-size")).toBe("0.85em");
  });
});

describe("docCss", () => {
  test("scopes every selector under the container class", () => {
    const selectors = docCss()
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter(Boolean);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim().startsWith(`.${DOC_CONTAINER_CLASS}`)).toBe(true);
      }
    }
  });
});
