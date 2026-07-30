// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { renderExcalidrawFile } from "../excalidraw_render";
import { writeClipboardPayload } from "../../api/clipboard";
import { computeBubbleSpec } from "../bubbles/triggers";
import { imageDecorations } from "./image";

vi.mock("../excalidraw_render", () => ({
  renderExcalidrawFile: vi.fn(async (_url: string, dark: boolean) => ({
    ok: true,
    svg: `<svg data-excalidraw-theme="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

vi.mock("../../api/clipboard", () => ({
  writeClipboardPayload: vi.fn(async () => {}),
}));

function mount(
  doc: string,
  dark: boolean,
  onDiagramView?: (svg: string) => void,
): { parent: HTMLElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        chanMarkdown(),
        imageDecorations({
          getCurrentPath: () => "slides-test.md",
          isDark: () => dark,
          onDiagramView,
        }),
      ],
    }),
  });
  return { parent, view };
}

function actionButton(parent: HTMLElement, label: string): HTMLButtonElement {
  const btn = [
    ...parent.querySelectorAll<HTMLButtonElement>(".cm-md-image-action"),
  ].find((b) => b.textContent === label);
  if (!btn) throw new Error(`no ${label} action button`);
  return btn;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("excalidraw image embeds", () => {
  test("render a .excalidraw image source as a themed static SVG", async () => {
    const { parent, view } = mount("![](board.excalidraw#w=320)", true);
    try {
      await vi.waitFor(() => {
        expect(
          parent
            .querySelector(".cm-md-excalidraw-embed svg")
            ?.getAttribute("data-excalidraw-theme"),
        ).toBe("dark");
      });
      expect(parent.querySelector(".cm-md-image-wrap[data-excalidraw='true']")).toBeTruthy();
      expect(parent.querySelector(".cm-md-image-wrap img")).toBeNull();
      expect(parent.querySelector<HTMLElement>(".cm-md-excalidraw-embed")?.style.width).toBe(
        "320px",
      );
      expect(renderExcalidrawFile).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/board.excalidraw"),
        true,
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  test("resize handle persists the width fragment", async () => {
    const { parent, view } = mount("![](board.excalidraw#w=320)", true);
    try {
      await vi.waitFor(() => {
        expect(parent.querySelector(".cm-md-excalidraw-embed svg")).toBeTruthy();
      });
      const embed = parent.querySelector<HTMLElement>(".cm-md-excalidraw-embed");
      const handle = parent.querySelector<HTMLElement>(".cm-md-image-handle");
      expect(embed).toBeTruthy();
      expect(handle).toBeTruthy();
      embed!.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: parseInt(embed!.style.width || "320", 10),
          bottom: 120,
          width: parseInt(embed!.style.width || "320", 10),
          height: 120,
          toJSON: () => {},
        }) as DOMRect;

      handle!.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          clientX: 10,
        }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: 70 }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(view.state.doc.toString()).toBe("![](board.excalidraw#w=380)");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  test("View opens the diagram overlay with the rendered SVG (light editor)", async () => {
    const onDiagramView = vi.fn();
    const { parent, view } = mount("![](board.excalidraw)", false, onDiagramView);
    try {
      await vi.waitFor(() => {
        expect(parent.querySelector(".cm-md-excalidraw-embed svg")).toBeTruthy();
      });
      const viewBtn = actionButton(parent, "View");
      // Revealed once the render succeeded (hidden until then so an
      // errored diagram is never offered).
      expect(viewBtn.style.display).toBe("");
      viewBtn.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      expect(onDiagramView).toHaveBeenCalledWith(
        '<svg data-excalidraw-theme="light"></svg>',
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  test("View from a dark editor re-renders the light face for the overlay", async () => {
    const onDiagramView = vi.fn();
    const { parent, view } = mount("![](board.excalidraw)", true, onDiagramView);
    try {
      await vi.waitFor(() => {
        expect(
          parent
            .querySelector(".cm-md-excalidraw-embed svg")
            ?.getAttribute("data-excalidraw-theme"),
        ).toBe("dark");
      });
      actionButton(parent, "View").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      // The overlay presents on a light panel, so the dark embed's face is
      // never handed over; a fresh light render is.
      await vi.waitFor(() => {
        expect(onDiagramView).toHaveBeenCalledWith(
          '<svg data-excalidraw-theme="light"></svg>',
        );
      });
      expect(renderExcalidrawFile).toHaveBeenCalledWith(
        expect.stringContaining("/api/files/board.excalidraw"),
        false,
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("excalidraw embed error face", () => {
  test("a failed render marks the wrap and a click reveals the source", async () => {
    vi.mocked(renderExcalidrawFile).mockImplementationOnce(async () => ({
      ok: false,
      error: "fetch failed: 404",
    }));
    const doc = "![](missing.excalidraw)";
    const { parent, view } = mount(doc, false);
    try {
      await vi.waitFor(() => {
        expect(
          parent.querySelector(".cm-md-excalidraw-embed-error"),
        ).toBeTruthy();
      });
      // The wrap carries the error marker (drives the pointer cursor).
      expect(
        parent.querySelector(
          ".cm-md-image-wrap[data-excalidraw-error='true']",
        ),
      ).toBeTruthy();
      const face = parent.querySelector<HTMLElement>(
        ".cm-md-excalidraw-embed-error",
      )!;
      face.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      // The caret lands strictly inside the URL slot (urlFrom + 1), the
      // same landing the broken-raster badge uses, so the user can fix
      // the path instead of being trapped by an inert face.
      expect(view.state.selection.main.head).toBe(doc.indexOf("(") + 2);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("excalidraw embed copy", () => {
  /// jsdom's Image never decodes; this stand-in fires onload as soon as a
  /// src lands, which is the browser contract the rasterizer relies on.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;

  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    };
    // The rasterizer needs a measurable size; the file-wide default mock
    // SVG has no viewBox, so override with one that does.
    vi.mocked(renderExcalidrawFile).mockImplementation(
      async (_url: string, dark: boolean) => ({
        ok: true,
        svg: `<svg viewBox="0 0 80 40" data-excalidraw-theme="${dark ? "dark" : "light"}"></svg>`,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLCanvasElement.prototype.getContext = origGetContext;
    HTMLCanvasElement.prototype.toBlob = origToBlob;
    // Restore the file-wide default implementation for later describes.
    vi.mocked(renderExcalidrawFile).mockImplementation(
      async (_url: string, dark: boolean) => ({
        ok: true,
        svg: `<svg data-excalidraw-theme="${dark ? "dark" : "light"}"></svg>`,
      }),
    );
  });

  test("copy hides until the render succeeds, then writes a PNG payload", async () => {
    const { parent, view } = mount("![](board.excalidraw)", false);
    try {
      const copyBtn = parent.querySelector<HTMLButtonElement>(
        ".cm-md-image-action.cm-md-image-copy",
      );
      expect(copyBtn).toBeTruthy();
      // Same gating as View: hidden until the async render lands.
      expect(copyBtn!.style.display).toBe("none");
      await vi.waitFor(() => {
        expect(copyBtn!.style.display).toBe("");
      });
      copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(writeClipboardPayload).toHaveBeenCalledWith(
          "image/png",
          expect.any(Uint8Array),
        );
      });
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  test("a dark editor copies a fresh light render", async () => {
    const { parent, view } = mount("![](board.excalidraw)", true);
    try {
      const copyBtn = parent.querySelector<HTMLButtonElement>(
        ".cm-md-image-action.cm-md-image-copy",
      )!;
      await vi.waitFor(() => {
        expect(copyBtn.style.display).toBe("");
      });
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // The embed rendered dark; the copy path re-renders light before
      // rasterizing, matching the View button's discipline.
      await vi.waitFor(() => {
        expect(renderExcalidrawFile).toHaveBeenCalledWith(
          expect.stringContaining("/api/files/board.excalidraw"),
          false,
        );
        expect(writeClipboardPayload).toHaveBeenCalledTimes(1);
      });
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  test("the embed row offers Copy SVG beside the PNG copy", async () => {
    const { parent, view } = mount("![](board.excalidraw)", false);
    try {
      const svgBtn = parent.querySelector<HTMLButtonElement>(
        ".cm-md-image-copy-svg",
      );
      expect(svgBtn).toBeTruthy();
      // Same render-success gating as View and the PNG copy.
      expect(svgBtn!.style.display).toBe("none");
      await vi.waitFor(() => {
        expect(svgBtn!.style.display).toBe("");
      });
      svgBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(writeClipboardPayload).toHaveBeenCalledWith(
          "text/plain;charset=utf-8",
          new TextEncoder().encode(
            '<svg viewBox="0 0 80 40" data-excalidraw-theme="light"></svg>',
          ),
        );
      });
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("excalidraw edit reveals source with no raster image bubble", () => {
  /// A parsed markdown state with the caret at `pos`, no view mount -
  /// exactly what the bubble controller hands computeBubbleSpec.
  function stateAt(doc: string, pos: number): EditorState {
    const state = EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [chanMarkdown()],
    });
    ensureSyntaxTree(state, doc.length, 10000);
    return state;
  }

  test("caret inside an .excalidraw image URL opens NO bubble", () => {
    const doc = "![](board.excalidraw)";
    // Caret one char past the `(` - where the Edit button parks it.
    const pos = doc.indexOf("(") + 2;
    expect(computeBubbleSpec(stateAt(doc, pos))).toBeNull();
  });

  test("caret inside a raster image URL still opens the raw image bubble", () => {
    const doc = "![](photo.png)";
    const pos = doc.indexOf("(") + 2;
    expect(computeBubbleSpec(stateAt(doc, pos))).toMatchObject({
      kind: "image",
      templateMode: "raw",
    });
  });
});
