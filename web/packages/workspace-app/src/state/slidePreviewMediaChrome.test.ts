// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { renderMermaid } from "../editor/mermaid_render";
import { slidePreviewCss } from "../editor/slide_dom";
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

const SOURCE = [
  "---",
  "chan:",
  "  kind: slides",
  '  slides:',
  '    aspect_ratio: "16:9"',
  "---",
  "",
  "# Slide 1",
  "",
  "![shot](shot.png)",
  "",
  "```mermaid",
  "graph TD;",
  "```",
  "",
  '<hr class="chan-page-break">',
  "",
  "# Slide 2",
  "",
  "two",
  "",
].join("\n");

function slideBackdrop(): HTMLElement | null {
  return document.querySelector(".md-slide-preview");
}

function imageViewer(): HTMLElement | null {
  return document.querySelector(".md-image-zoom:not(.md-slide-preview)");
}

function counterText(): string {
  return document.querySelector(".md-slide-preview-counter")?.textContent ?? "";
}

function imageRow(): HTMLElement | null {
  return document.querySelector(".md-slide-media-wrap .md-slide-media-actions");
}

function diagramRow(): HTMLElement | null {
  return document.querySelector(".md-slide-diagram .md-slide-media-actions");
}

function clickView(row: HTMLElement): void {
  const view = Array.from(row.querySelectorAll("button")).find(
    (b) => b.textContent === "View",
  )!;
  view.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/// jsdom never loads images, and the image chrome is load-gated; fire
/// the slide img's load event the way a real fetch completion would.
function loadSlideImage(): void {
  document
    .querySelectorAll<HTMLImageElement>(".md-slide-preview-page img")
    .forEach((img) => img.dispatchEvent(new Event("load")));
}

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
  );
}

afterEach(() => {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => null,
  });
  pressEscape();
  pressEscape();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function open(theme: "light" | "dark" = "light") {
  return openSlidePreview({
    source: SOURCE,
    currentLine: 0,
    fromPath: "deck.md",
    theme,
  })!;
}

describe("slide overlay media chrome", () => {
  test("View/copy rows mount on image and diagram media in preview and play", async () => {
    const handle = open();
    // The image chrome is load-gated; the diagram row lands once the
    // mocked render settles.
    expect(imageRow()).toBeNull();
    loadSlideImage();
    expect(imageRow()).toBeTruthy();
    await vi.waitFor(() => {
      expect(diagramRow()).toBeTruthy();
    });
    // Image row: View + PNG copy (no SVG button for a raster source).
    const imageLabels = Array.from(imageRow()!.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(imageLabels).toEqual(["View", "PNG"]);
    // Diagram row: View + both formats.
    const diagramLabels = Array.from(
      diagramRow()!.querySelectorAll("button"),
    ).map((b) => b.textContent);
    expect(diagramLabels).toEqual(["View", "SVG", "PNG"]);
    // Play mode re-renders the slide; the chrome stays available
    // (hover-revealed by CSS, so presence is the contract here).
    handle.update({ mode: "play" });
    loadSlideImage();
    await vi.waitFor(() => {
      expect(imageRow()).toBeTruthy();
      expect(diagramRow()).toBeTruthy();
    });
    handle.close();
  });

  test("image View opens the viewer; Escape closes only the viewer", async () => {
    const handle = open();
    loadSlideImage();
    expect(imageRow()).toBeTruthy();
    clickView(imageRow()!);
    expect(imageViewer()).toBeTruthy();
    // The slide overlay's own document-capture handler yields while the
    // viewer is up: one Escape closes the viewer, not the slides.
    pressEscape();
    expect(imageViewer()).toBeNull();
    expect(slideBackdrop()).toBeTruthy();
    pressEscape();
    expect(slideBackdrop()).toBeNull();
    handle.close();
  });

  test("arrow keys do not step slides under an open viewer", async () => {
    const handle = open();
    loadSlideImage();
    expect(counterText()).toBe("1 / 2");
    clickView(imageRow()!);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
    );
    expect(counterText()).toBe("1 / 2");
    pressEscape();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
    );
    expect(counterText()).toBe("2 / 2");
    handle.close();
  });

  test("diagram View opens the diagram viewer with a light render", async () => {
    const handle = open("dark");
    await vi.waitFor(() => {
      expect(diagramRow()).toBeTruthy();
    });
    // The slide face rendered dark; the viewer must get a light render.
    expect(
      document.querySelector(".md-slide-diagram-body svg")?.getAttribute(
        "data-mermaid-theme",
      ),
    ).toBe("dark");
    clickView(diagramRow()!);
    await vi.waitFor(() => {
      expect(document.querySelector(".md-diagram-zoom")).toBeTruthy();
    });
    expect(
      document
        .querySelector(".md-diagram-zoom svg")
        ?.getAttribute("data-mermaid-theme"),
    ).toBe("light");
    pressEscape();
    handle.close();
  });

  test("viewers mount inside the fullscreen element when one is active", async () => {
    const handle = open();
    loadSlideImage();
    const backdrop = slideBackdrop()!;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => backdrop,
    });
    clickView(imageRow()!);
    const viewer = imageViewer()!;
    expect(viewer.parentElement).toBe(backdrop);
    pressEscape();
    handle.close();
  });

  test("dismissing the image viewer inside fullscreen leaves the slides open", async () => {
    const handle = open();
    loadSlideImage();
    const backdrop = slideBackdrop()!;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => backdrop,
    });
    clickView(imageRow()!);
    const viewer = imageViewer()!;
    expect(viewer.parentElement).toBe(backdrop);
    // The viewer's click-to-dismiss must stop at the viewer boundary:
    // as a child of the slide backdrop its click would otherwise bubble
    // into the slide dismiss handler and close the presentation too.
    viewer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(imageViewer()).toBeNull();
    expect(slideBackdrop()).toBeTruthy();
    pressEscape();
    expect(slideBackdrop()).toBeNull();
    handle.close();
  });

  test("diagram viewer interaction inside fullscreen never closes the slides", async () => {
    const handle = open();
    loadSlideImage();
    await vi.waitFor(() => {
      expect(diagramRow()).toBeTruthy();
    });
    const backdrop = slideBackdrop()!;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => backdrop,
    });
    clickView(diagramRow()!);
    await vi.waitFor(() => {
      expect(document.querySelector(".md-diagram-zoom")).toBeTruthy();
    });
    const viewer = document.querySelector<HTMLElement>(".md-diagram-zoom")!;
    expect(viewer.parentElement).toBe(backdrop);
    // A non-dismissing interaction (click on the diagram panel) stays
    // inside the viewer: neither overlay closes.
    const panel = viewer.querySelector<HTMLElement>(".md-diagram-zoom-panel")!;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".md-diagram-zoom")).toBeTruthy();
    expect(slideBackdrop()).toBeTruthy();
    // The dismissing click (backdrop itself) closes at most the viewer.
    viewer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".md-diagram-zoom")).toBeNull();
    expect(slideBackdrop()).toBeTruthy();
    handle.close();
  });

  test("a mixed-content paragraph image keeps its alignment after load", async () => {
    // `before ![](...) after` is mixed content: the paragraph never
    // receives the standalone flex classes, so post-load alignment
    // rides entirely on the wrapper's own margins.
    const source = [
      "---",
      "chan:",
      "  kind: slides",
      '  slides:',
      '    aspect_ratio: "16:9"',
      "---",
      "",
      "# Slide 1",
      "",
      "before ![shot](photo.png#right) after",
      "",
    ].join("\n");
    const handle = openSlidePreview({
      source,
      currentLine: 0,
      fromPath: "deck.md",
      theme: "light",
    })!;
    loadSlideImage();
    const wrap = document.querySelector<HTMLElement>(".md-slide-media-wrap")!;
    const img = wrap.querySelector("img")!;
    expect(img.classList.contains("chan-slide-align-right")).toBe(true);
    // The wrap mirrors the authored alignment class...
    expect(wrap.classList.contains("chan-slide-align-right")).toBe(true);
    // ...because the paragraph carries no flex alignment to lean on.
    expect(wrap.closest("p")?.classList.contains("chan-slide-media")).toBe(
      false,
    );
    // And the overlay CSS holds the wrapper-level margin rules that
    // implement left/right for exactly this case.
    const css = slidePreviewCss();
    expect(css).toMatch(
      /\.md-slide-media-wrap\.chan-slide-align-right\s*\{[^}]*margin-left:\s*auto/,
    );
    expect(css).toMatch(
      /\.md-slide-media-wrap\.chan-slide-align-left\s*\{[^}]*margin-right:\s*auto/,
    );
    handle.close();
  });

  test("a deferred diagram View never opens over a different slide", async () => {
    // Dark theme: View must re-render the light face, which is the
    // asynchronous path that can lose the race with a slide change.
    const handle = open("dark");
    loadSlideImage();
    await vi.waitFor(() => {
      expect(diagramRow()).toBeTruthy();
    });
    // Park the light re-render so the slide can change underneath it.
    let resolveLight!: (value: { ok: boolean; svg?: string }) => void;
    vi.mocked(renderMermaid).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLight = resolve;
        }) as ReturnType<typeof renderMermaid>,
    );
    clickView(diagramRow()!);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
    );
    expect(counterText()).toBe("2 / 2");
    resolveLight({ ok: true, svg: "<svg data-stale></svg>" });
    // Give the resolution a macrotask to (wrongly) mount the viewer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".md-diagram-zoom")).toBeNull();
    handle.close();
  });
});
