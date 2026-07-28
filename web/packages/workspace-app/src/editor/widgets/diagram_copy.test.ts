// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api/clipboard", () => ({
  writeClipboardPayload: vi.fn(async () => {}),
}));

import { writeClipboardPayload } from "../../api/clipboard";
import {
  CHECK_ICON_SVG,
  COPY_ICON_SVG,
  copyDiagramPng,
  copyDiagramSvg,
  diagramCopyButton,
  svgToPngBytes,
} from "./diagram_copy";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>';
const PNG_BYTES = [137, 80, 78, 71];

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

let canvasSize: { width: number; height: number } | null = null;

beforeEach(() => {
  canvasSize = null;
  vi.stubGlobal("Image", FakeImage);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  })) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    canvasSize = { width: this.width, height: this.height };
    cb(new Blob([new Uint8Array(PNG_BYTES)], { type: "image/png" }));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("svgToPngBytes", () => {
  test("sizes the canvas from the viewBox and returns the PNG bytes", async () => {
    const bytes = await svgToPngBytes(SVG);
    expect(canvasSize).toEqual({ width: 200, height: 100 });
    expect([...bytes]).toEqual(PNG_BYTES);
  });

  test("markup with neither viewBox nor intrinsic size is refused", async () => {
    await expect(svgToPngBytes("<svg></svg>")).rejects.toThrow(
      "no measurable size",
    );
  });
});

describe("copyDiagramPng", () => {
  test("writes an image/png payload through the clipboard bridge", async () => {
    await copyDiagramPng(SVG);
    expect(writeClipboardPayload).toHaveBeenCalledWith(
      "image/png",
      expect.any(Uint8Array),
    );
  });
});

describe("copyDiagramSvg", () => {
  test("writes the lossless SVG markup as text", async () => {
    await copyDiagramSvg(SVG);
    expect(writeClipboardPayload).toHaveBeenCalledWith(
      "text/plain;charset=utf-8",
      new TextEncoder().encode(SVG),
    );
  });
});

describe("diagramCopyButton", () => {
  test("starts hidden; click copies the resolved markup with Check feedback", async () => {
    const btn = diagramCopyButton("x-copy", () => SVG, "png", true);
    expect(btn.style.display).toBe("none");
    expect(btn.textContent).toBe("PNG");
    // Pin the shared icons by their distinctive path data.
    expect(COPY_ICON_SVG).toContain("M4 16");
    expect(CHECK_ICON_SVG).toContain("M20 6 9 17l-5-5");
    document.body.append(btn);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardPayload).toHaveBeenCalledTimes(1);
      expect(btn.innerHTML).toContain("M20 6 9 17l-5-5");
    });
  });

  test("a null markup resolution fails softly (title flip, no write)", async () => {
    const btn = diagramCopyButton("x-copy", () => null, "svg");
    document.body.append(btn);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(btn.title).toBe("copy failed");
    });
    expect(writeClipboardPayload).not.toHaveBeenCalled();
  });
});
