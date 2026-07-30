// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { writeClipboardPayload } from "../../api/clipboard";
import { imageDecorations } from "./image";
import { copyImagePixels } from "./image_copy";

vi.mock("../../api/clipboard", () => ({
  writeClipboardPayload: vi.fn(async () => {}),
}));

function mount(doc: string): { view: EditorView; cleanup: () => void } {
  const target = document.createElement("div");
  document.body.append(target);
  const state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [chanMarkdown(), imageDecorations({ getCurrentPath: () => null })],
  });
  const view = new EditorView({ state, parent: target });
  return {
    view,
    cleanup: () => {
      view.destroy();
      target.remove();
    },
  };
}

function stubFetch(body: { bytes?: Uint8Array; text?: string; mime?: string }) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    headers: new Headers({ "content-type": body.mime ?? "image/png" }),
    arrayBuffer: async () => (body.bytes ?? new Uint8Array([1])).buffer,
    text: async () => body.text ?? "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function loadImage(view: EditorView): void {
  view.dom
    .querySelector<HTMLImageElement>(".cm-md-image-wrap img")!
    .dispatchEvent(new Event("load"));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("image widget pixel copy", () => {
  test("a raster image offers Copy PNG only, hidden until the img loads", () => {
    const { view, cleanup } = mount("![a](b.png)");
    const png = view.dom.querySelector<HTMLButtonElement>(
      ".cm-md-image-copy-png",
    );
    expect(png).toBeTruthy();
    expect(view.dom.querySelector(".cm-md-image-copy-svg")).toBeNull();
    expect(png!.style.display).toBe("none");
    loadImage(view);
    expect(png!.style.display).toBe("");
    cleanup();
  });

  test("Copy PNG fetches the resolved bytes and writes an image payload", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const fetchMock = stubFetch({ bytes, mime: "image/jpeg" });
    const { view, cleanup } = mount("![a](b.jpg)");
    loadImage(view);
    view.dom
      .querySelector<HTMLButtonElement>(".cm-md-image-copy-png")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardPayload).toHaveBeenCalledWith(
        "image/jpeg",
        expect.any(Uint8Array),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/files/b.jpg"),
    );
    cleanup();
  });

  test("an .svg source gains Copy SVG, which writes the fetched markup as text", async () => {
    const markup = '<svg viewBox="0 0 10 10"></svg>';
    stubFetch({ text: markup, mime: "image/svg+xml" });
    const { view, cleanup } = mount("![a](pic.svg)");
    const svgBtn = view.dom.querySelector<HTMLButtonElement>(
      ".cm-md-image-copy-svg",
    );
    expect(svgBtn).toBeTruthy();
    expect(view.dom.querySelector(".cm-md-image-copy-png")).toBeTruthy();
    loadImage(view);
    svgBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardPayload).toHaveBeenCalledWith(
        "text/plain;charset=utf-8",
        new TextEncoder().encode(markup),
      );
    });
    cleanup();
  });

  test("the width fragment does not defeat .svg detection", () => {
    const { view, cleanup } = mount("![a](pic.svg#w=200)");
    expect(view.dom.querySelector(".cm-md-image-copy-svg")).toBeTruthy();
    cleanup();
  });

  test("unknown bytes with an unusable Content-Type never reach the clipboard", async () => {
    // No image/* Content-Type and no recognizable extension: labelling
    // these bytes image/png would put a corrupt PNG on the clipboard,
    // so the copy must fail through the button's failure surface.
    stubFetch({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "application/octet-stream",
    });
    await expect(
      copyImagePixels("/api/files/mystery.bin", false),
    ).rejects.toThrow("unrecognized image type");
    expect(writeClipboardPayload).not.toHaveBeenCalled();
  });

  test("the markdown copy button survives unchanged beside the pixel buttons", () => {
    const { view, cleanup } = mount("![a](b.png)");
    const md = view.dom.querySelector<HTMLButtonElement>(
      ".cm-md-image-action.cm-md-image-copy",
    );
    expect(md).toBeTruthy();
    expect(md!.title).toBe("copy image to clipboard");
    // Order: View then SVG/PNG, markdown copy stays last.
    const actions = view.dom.querySelector(".cm-md-image-actions")!;
    expect(actions.lastElementChild).toBe(md);
    cleanup();
  });
});
