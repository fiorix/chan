// @vitest-environment jsdom

import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { openImageZoom } from "./imageZoom";
import { chanMarkdown } from "../editor/markdown/grammar";
import { collectDocImageSrcs } from "../editor/widgets/image";
import { pressInPage } from "../__tests__/keys";

function backdrop(): HTMLElement | null {
  return document.querySelector(".md-image-zoom");
}
function imgSrc(): string | null {
  return backdrop()?.querySelector("img")?.getAttribute("src") ?? null;
}

afterEach(() => {
  document.querySelectorAll(".md-image-zoom").forEach((e) => e.remove());
});

const SET = [
  { src: "https://x/1.png", fromPath: null },
  { src: "https://x/2.png", fromPath: null },
  { src: "https://x/3.png", fromPath: null },
];

describe("openImageZoom prev/next", () => {
  test("a multi-image set shows prev/next + a counter, opened at src", () => {
    openImageZoom("https://x/2.png", null, SET);
    const bd = backdrop()!;
    expect(bd.querySelector(".md-image-zoom-prev")).toBeTruthy();
    expect(bd.querySelector(".md-image-zoom-next")).toBeTruthy();
    expect(imgSrc()).toBe("https://x/2.png");
    expect(bd.querySelector(".md-image-zoom-counter")?.textContent).toBe("2 / 3");
  });

  test("ArrowRight advances and wraps at the end", () => {
    openImageZoom("https://x/3.png", null, SET);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(imgSrc()).toBe("https://x/1.png"); // wrapped past the last
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(imgSrc()).toBe("https://x/3.png"); // wrapped back before the first
  });

  test("clicking next advances without dismissing the viewer", () => {
    openImageZoom("https://x/1.png", null, SET);
    (backdrop()!.querySelector(".md-image-zoom-next") as HTMLButtonElement).click();
    expect(imgSrc()).toBe("https://x/2.png");
    expect(backdrop()).toBeTruthy();
  });

  test("a single image shows no nav controls", () => {
    openImageZoom("https://x/only.png", null);
    const bd = backdrop()!;
    expect(bd.querySelector(".md-image-zoom-prev")).toBeNull();
    expect(bd.querySelector(".md-image-zoom-counter")).toBeNull();
  });
});

describe("collectDocImageSrcs (editor set)", () => {
  test("returns every image src in document order", () => {
    const doc = [
      "# heading",
      "",
      "![a](one.png)",
      "",
      "text ![b](two.png) more",
      "",
      "![c](three.png)",
    ].join("\n");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [chanMarkdown()] }),
    });
    // collectDocImageSrcs walks the whole syntaxTree, which is parsed lazily
    // within a time budget; force a full parse so the assertion does not flake
    // under CPU load (an incomplete tree would yield only the first image).
    forceParsing(view, view.state.doc.length, 1e9);
    expect(collectDocImageSrcs(view)).toEqual([
      "one.png",
      "two.png",
      "three.png",
    ]);
    view.destroy();
    parent.remove();
  });
});

describe("keys in the image viewer", () => {
  test.each(["Escape", "ArrowRight", "ArrowLeft"])("%s acts in the viewer and goes no further", (key) => {
    openImageZoom("https://x/2.png", null, SET);

    const { event, reachedDocument } = pressInPage({ key });

    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
    if (backdrop()) pressInPage({ key: "Escape" });
  });

  test("Escape closes the viewer", () => {
    openImageZoom("https://x/2.png", null, SET);

    pressInPage({ key: "Escape" });

    expect(backdrop()).toBeNull();
  });

  test("an arrow in a single-image viewer travels on", () => {
    openImageZoom("https://x/1.png", null);

    const { event, reachedDocument } = pressInPage({ key: "ArrowRight" });

    expect(backdrop()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
    pressInPage({ key: "Escape" });
  });
});
