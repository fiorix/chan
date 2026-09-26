// @vitest-environment jsdom
//
// The video viewer owns Escape while it is open: the key closes it and goes
// no further, so it neither reaches the editor behind it nor closes an
// overlay beneath it through the app's window handler. Other keys travel on.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/transport", () => ({
  withTokenQuery: (path: string) => `${path}?t=test-token`,
}));

import { openVideoViewer } from "./videoViewer";
import { pressInPage } from "../__tests__/keys";

function viewer(): HTMLElement | null {
  return document.querySelector(".md-video-viewer");
}

beforeEach(() => {
  // jsdom implements neither; the viewer pauses and reloads the element on
  // close to drop the stream.
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  if (viewer()) pressInPage({ key: "Escape" });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("keys in the video viewer", () => {
  test("Escape closes the viewer and goes no further", () => {
    openVideoViewer("media/clip.mp4");

    const { event, reachedDocument } = pressInPage({ key: "Escape" });

    expect(viewer()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  test("a key the viewer does not answer travels on", () => {
    openVideoViewer("media/clip.mp4");

    const { event, reachedDocument } = pressInPage({ key: "ArrowDown" });

    expect(viewer()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
  });

  test("a modified Escape travels on and leaves the viewer open", () => {
    openVideoViewer("media/clip.mp4");

    const { event, reachedDocument } = pressInPage({ key: "Escape", altKey: true });

    expect(viewer()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
  });
});
