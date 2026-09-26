// @vitest-environment jsdom
//
// The PDF viewer owns Escape while it is open: the key closes it and goes no
// further, so it neither reaches the editor behind it nor closes an overlay
// beneath it through the app's window handler. Other keys travel on.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/transport", () => ({
  withTokenQuery: (path: string) => `${path}?t=test-token`,
}));

import { openPdfViewer } from "./pdfViewer";
import { pressInPage } from "../__tests__/keys";

function viewer(): HTMLElement | null {
  return document.querySelector(".md-pdf-viewer");
}

afterEach(() => {
  if (viewer()) pressInPage({ key: "Escape" });
  document.body.innerHTML = "";
});

describe("keys in the PDF viewer", () => {
  test("Escape closes the viewer and goes no further", () => {
    openPdfViewer("docs/spec.pdf");

    const { event, reachedDocument } = pressInPage({ key: "Escape" });

    expect(viewer()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  test("a key the viewer does not answer travels on", () => {
    openPdfViewer("docs/spec.pdf");

    const { event, reachedDocument } = pressInPage({ key: "ArrowDown" });

    expect(viewer()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
  });
});
