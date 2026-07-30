// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
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
    // The image hook is synchronous with show(); the diagram row lands
    // once the mocked render settles.
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
    await vi.waitFor(() => {
      expect(imageRow()).toBeTruthy();
      expect(diagramRow()).toBeTruthy();
    });
    handle.close();
  });

  test("image View opens the viewer; Escape closes only the viewer", async () => {
    const handle = open();
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
});
