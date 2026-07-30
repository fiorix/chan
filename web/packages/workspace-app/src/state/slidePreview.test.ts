// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import appSource from "../App.svelte?raw";
import { openSlidePreview } from "./slidePreview";

vi.mock("../editor/mermaid_render", () => ({
  renderMermaid: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-mermaid-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

vi.mock("../editor/excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-excalidraw-diagram-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
  renderExcalidrawFile: vi.fn(async (_url: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-excalidraw-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

const SOURCE = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

one

<hr class="chan-page-break">

# Slide 2

two

<hr class="chan-page-break">

# Slide 3

three
`;

function backdrop(): HTMLElement | null {
  return document.querySelector(".md-slide-preview");
}

function pageText(): string {
  return document.querySelector(".md-slide-preview-page")?.textContent ?? "";
}

function counterText(): string {
  return document.querySelector(".md-slide-preview-counter")?.textContent ?? "";
}

function pageStyleText(): string {
  return document.querySelector(".md-slide-preview-page")?.getAttribute("style") ?? "";
}

function slideContent(): HTMLElement | null {
  return document.querySelector(".md-slide-preview-content");
}

function contentStyleText(): string {
  return slideContent()?.getAttribute("style") ?? "";
}

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.querySelectorAll(".md-slide-preview").forEach((node) => node.remove());
});

describe("openSlidePreview", () => {
  test("opens on the slide that contains the current line", () => {
    openSlidePreview({
      source: SOURCE,
      currentLine: 13,
      fromPath: "slides-test.md",
      theme: "dark",
    });

    expect(backdrop()).toBeTruthy();
    expect(pageText()).toContain("Slide 2");
    expect(counterText()).toBe("2 / 3");
  });

  test("keyboard shortcuts move between slides and Escape closes", () => {
    const onClose = vi.fn();
    openSlidePreview({
      source: SOURCE,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
      onClose,
    });

    const next = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      cancelable: true,
    });
    document.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(true);
    expect(pageText()).toContain("Slide 2");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", cancelable: true }));
    expect(pageText()).toContain("Slide 3");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", cancelable: true }),
    );
    expect(pageText()).toContain("Slide 2");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(pageText()).toContain("Slide 1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("prev and next buttons clamp at the ends", () => {
    openSlidePreview({
      source: SOURCE,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });

    const prev = document.querySelector(".md-slide-preview-prev") as HTMLButtonElement;
    const next = document.querySelector(".md-slide-preview-next") as HTMLButtonElement;

    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    next.click();
    expect(pageText()).toContain("Slide 3");
    expect(next.disabled).toBe(true);
  });

  test("play mode hides preview chrome, keeps shortcuts, and requests fullscreen", () => {
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const originalRequestFullscreen = proto.requestFullscreen;
    const requestFullscreen = vi.fn(async () => {});
    Object.defineProperty(proto, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });

    try {
      const handle = openSlidePreview({
        source: SOURCE,
        currentLine: 0,
        fromPath: "slides-test.md",
        theme: "dark",
        mode: "play",
      });

      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(backdrop()?.dataset.mode).toBe("play");
      expect(pageStyleText()).toContain("width: 100vw");
      expect(pageStyleText()).toContain("max-width: 177.78vh");
      expect(pageStyleText()).toContain("max-height: 100vh");
      expect(pageStyleText()).toContain("box-shadow: none");
      expect(pageStyleText()).toContain("border-radius: 0");
      expect(
        (document.querySelector(".md-slide-preview-prev") as HTMLElement).hidden,
      ).toBe(true);
      expect(
        (document.querySelector(".md-slide-preview-next") as HTMLElement).hidden,
      ).toBe(true);
      expect(
        (document.querySelector(".md-slide-preview-counter") as HTMLElement).hidden,
      ).toBe(true);
      expect(counterText()).toBe("");

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
      );
      expect(pageText()).toContain("Slide 2");
      expect(counterText()).toBe("");

      handle?.update({ mode: "preview" });
      expect(backdrop()?.dataset.mode).toBe("preview");
      expect(pageStyleText()).toContain("max-height: 86vh");
      expect(
        (document.querySelector(".md-slide-preview-prev") as HTMLElement).hidden,
      ).toBe(false);
    } finally {
      if (originalRequestFullscreen) {
        Object.defineProperty(proto, "requestFullscreen", {
          configurable: true,
          value: originalRequestFullscreen,
        });
      } else {
        delete proto.requestFullscreen;
      }
    }
  });

  test("on chan-desktop play/preview drive the native window, not element fullscreen", async () => {
    // WKWebView disables element.requestFullscreen(), so on desktop the player
    // toggles the native window through Tauri's core:window set_fullscreen
    // command instead. Web keeps the HTML path (covered by the test above).
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const originalRequestFullscreen = proto.requestFullscreen;
    const requestFullscreen = vi.fn(async () => {});
    Object.defineProperty(proto, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke },
      configurable: true,
    });

    try {
      const handle = openSlidePreview({
        source: SOURCE,
        currentLine: 0,
        fromPath: "slides-test.md",
        theme: "dark",
        mode: "play",
      });

      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("plugin:window|set_fullscreen", {
          value: true,
        }),
      );
      expect(requestFullscreen).not.toHaveBeenCalled();

      handle?.update({ mode: "preview" });
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenLastCalledWith("plugin:window|set_fullscreen", {
          value: false,
        }),
      );
      expect(requestFullscreen).not.toHaveBeenCalled();
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
      if (originalRequestFullscreen) {
        Object.defineProperty(proto, "requestFullscreen", {
          configurable: true,
          value: originalRequestFullscreen,
        });
      } else {
        delete proto.requestFullscreen;
      }
    }
  });

  test("applies and updates the editor light/dark scheme", () => {
    const handle = openSlidePreview({
      source: SOURCE,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });
    expect(handle).toBeTruthy();

    const page = document.querySelector(".md-slide-preview-page") as HTMLElement;
    expect(backdrop()?.dataset.theme).toBe("dark");
    // Opaque backdrop (no editor bleed-through / two-tone seam).
    expect(backdrop()?.style.background).toContain("rgb(0, 0, 0)");
    expect(backdrop()?.style.background).not.toContain("rgba");
    expect(page.style.colorScheme).toBe("dark");

    handle?.update({ theme: "light" });
    expect(backdrop()?.dataset.theme).toBe("light");
    expect(backdrop()?.style.background).toContain("rgb(238, 241, 245)");
    expect(backdrop()?.style.background).not.toContain("rgba");
    expect(page.style.colorScheme).toBe("light");
  });

  test("applies the slide zoom factor from frontmatter", () => {
    const handle = openSlidePreview({
      source: SOURCE,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });
    expect(handle).toBeTruthy();
    expect(slideContent()?.dataset.zoomFactor).toBe("2");
    expect(contentStyleText()).toContain("zoom: 2");
    expect(contentStyleText()).toContain("width: 100%");

    handle?.update({
      source: SOURCE.replace(
        'aspect_ratio: "16:9"',
        'aspect_ratio: "16:9"\n    zoom_factor: 150%',
      ),
    });
    expect(slideContent()?.dataset.zoomFactor).toBe("1.5");
    expect(contentStyleText()).toContain("zoom: 1.5");
    expect(contentStyleText()).toContain("width: 100%");
  });

  test("reports the visible slide when it opens and changes", () => {
    const changes: number[] = [];
    const handle = openSlidePreview({
      source: SOURCE,
      currentLine: 0,
      initialIndex: 2,
      fromPath: "slides-test.md",
      theme: "dark",
      onSlideChange: (index) => changes.push(index),
    });
    expect(handle).toBeTruthy();
    expect(pageText()).toContain("Slide 3");
    expect(changes).toEqual([2]);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }),
    );
    expect(pageText()).toContain("Slide 2");
    expect(changes).toEqual([2, 1]);

    handle?.update({ initialIndex: 0 });
    expect(pageText()).toContain("Slide 1");
    expect(changes).toEqual([2, 1, 0]);
  });

  test("preserves extra blank lines as visible slide spacing", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1



after gap
`;

    openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "light",
    });

    expect(
      document.querySelectorAll(".md-slide-preview-page .chan-slide-blank-line"),
    ).toHaveLength(2);
    expect(pageText()).toContain("after gap");
  });

  test("a slide after a page break starts at its heading with no spacer band", () => {
    // Two blank lines follow the break; they are separator whitespace,
    // not authored top padding, so the slide must open on its H1.
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

one

<hr class="chan-page-break">


# Next

body
`;

    openSlidePreview({
      source,
      currentLine: 0,
      initialIndex: 1,
      fromPath: "slides-test.md",
      theme: "light",
    });

    const content = slideContent();
    expect(
      content?.querySelectorAll(".chan-slide-blank-line"),
    ).toHaveLength(0);
    expect(content?.firstElementChild?.tagName).toBe("H1");
    expect(pageText()).toContain("Next");
    expect(pageText()).toContain("body");
  });

  test("applies image alignment in slide previews", () => {
    const source = `---
chan:
  kind: slides
---

# Slide 1

![](photo.png#w=120&right)
`;

    openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "light",
    });

    const img = document.querySelector(".md-slide-preview-page img") as
      | HTMLImageElement
      | null;
    expect(img?.style.width).toBe("120px");
    expect(img?.classList.contains("chan-slide-align-right")).toBe(true);
    // The media-chrome wrap sits between the img and its aligned
    // paragraph; the paragraph still carries the flex alignment classes.
    expect(img?.parentElement?.classList.contains("md-slide-media-wrap")).toBe(
      true,
    );
    const media = img?.closest("p");
    expect(media?.classList.contains("chan-slide-media")).toBe(true);
    expect(media?.classList.contains("chan-slide-align-right")).toBe(true);
  });

  test("renders mermaid fences as themed slide diagrams", async () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

\`\`\`mermaid left
flowchart LR
  A --> B
\`\`\`
`;

    const handle = openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });

    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-diagram svg")
          ?.getAttribute("data-mermaid-theme"),
      ).toBe("dark");
    });
    expect(
      document
        .querySelector(".md-slide-diagram")
        ?.classList.contains("chan-slide-align-left"),
    ).toBe(true);
    expect(document.querySelector("code.language-mermaid")).toBeNull();

    handle?.update({ theme: "light" });
    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-diagram svg")
          ?.getAttribute("data-mermaid-theme"),
      ).toBe("light");
    });
  });

  test("renders excalidraw image embeds as themed slide diagrams", async () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

![](board.excalidraw#w=360&right)
`;

    const handle = openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });

    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-excalidraw svg")
          ?.getAttribute("data-excalidraw-theme"),
      ).toBe("dark");
    });
    expect(document.querySelector(".md-slide-preview-page img")).toBeNull();
    expect(
      document
        .querySelector(".md-slide-excalidraw")
        ?.classList.contains("chan-slide-align-right"),
    ).toBe(true);
    expect(
      (document.querySelector(".md-slide-excalidraw-body") as HTMLElement).style
        .width,
    ).toBe("360px");

    handle?.update({ theme: "light" });
    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-excalidraw svg")
          ?.getAttribute("data-excalidraw-theme"),
      ).toBe("light");
    });
  });

  test("renders mermaid-to-excalidraw fences as themed slide diagrams", async () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

\`\`\`mermaid-to-excalidraw
flowchart LR
  A --> B
\`\`\`
`;

    const handle = openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "slides-test.md",
      theme: "dark",
    });

    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-diagram svg")
          ?.getAttribute("data-excalidraw-diagram-theme"),
      ).toBe("dark");
    });
    expect(
      document.querySelector("code.language-mermaid-to-excalidraw"),
    ).toBeNull();

    handle?.update({ theme: "light" });
    await vi.waitFor(() => {
      expect(
        document
          .querySelector(".md-slide-diagram svg")
          ?.getAttribute("data-excalidraw-diagram-theme"),
      ).toBe("light");
    });
  });

  test("layout persistence tracks preview open state and slide index", () => {
    expect(appSource).toMatch(
      /void t\.slidePreview\?\.open;[\s\S]*void t\.slidePreview\?\.index;[\s\S]*void t\.slidePreview\?\.mode;/,
    );
  });

  test("editor background token is scoped to light and dark body themes", () => {
    const baseThemeCss = readFileSync("src/editor/themes/base.css", "utf8");
    expect(baseThemeCss).toMatch(
      /:root\[data-theme="dark"\],[\s\S]*:root \[data-theme="light"\] \{[\s\S]*--chan-editor-bg:\s*var\(--bg\);/,
    );
  });
});
