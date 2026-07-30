// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TreeEntry } from "../api/types";
import { dirImageSet, openMediaViewer } from "./mediaOpen";
import { tree } from "./store.svelte";

function seed(...paths: string[]): void {
  tree.entries = paths.map(
    (path) => ({ path, is_dir: false }) as TreeEntry,
  );
}

function imageViewer(): HTMLElement | null {
  return document.querySelector(".md-image-zoom");
}

function anyViewer(): HTMLElement | null {
  return document.querySelector(
    ".md-image-zoom, .md-video-viewer, .md-pdf-viewer",
  );
}

function pressEscape(): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  document.dispatchEvent(ev);
  return ev;
}

// jsdom leaves HTMLMediaElement.pause/load unimplemented; the video
// viewer's dismissal calls both, so stub exactly those two (they also
// serve as the stream-teardown probes below).
let pauseSpy: ReturnType<typeof vi.fn<() => void>>;
let loadSpy: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  pauseSpy = vi.fn<() => void>();
  loadSpy = vi.fn<() => void>();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pauseSpy);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(loadSpy);
});

afterEach(() => {
  // Close mounted viewers through their own Escape path so each one
  // runs its dismiss closure (document-capture keydown removal, video
  // stream teardown); a bare innerHTML wipe would leak them.
  if (anyViewer()) pressEscape();
  expect(anyViewer()).toBeNull();
  // Observable proof the listeners are gone, not silently leaked: a
  // probe Escape after cleanup must reach no viewer handler.
  expect(pressEscape().defaultPrevented).toBe(false);
  vi.restoreAllMocks();
  tree.entries = [];
  document.body.innerHTML = "";
});

describe("openMediaViewer routing", () => {
  test("an image opens the zoom with the same-directory set in display order", () => {
    seed("a/1.png", "a/2.jpg", "a/sub/3.png", "a/notes.txt", "b/4.png");
    expect(openMediaViewer("a/2.jpg")).toBe(true);
    const viewer = imageViewer()!;
    expect(viewer).toBeTruthy();
    // The sibling set holds only a/'s images (no recursion, no other
    // dirs, no non-images), so the opened image is 2 of 2.
    expect(viewer.querySelector(".md-image-zoom-counter")?.textContent).toBe(
      "2 / 2",
    );
    expect(viewer.querySelector("img")?.src).toContain("/api/files/a/2.jpg");
  });

  test("an svg routes to the image zoom like any image", () => {
    seed("icons/logo.svg");
    expect(openMediaViewer("icons/logo.svg")).toBe(true);
    expect(imageViewer()).toBeTruthy();
  });

  test("video opens its viewer and the open-attempt fallback never runs", () => {
    seed("media/clip.mp4");
    const fallback = vi.fn();
    // The FileTree funnel shape: media success returns before onOpen,
    // so the openInActivePane text probe (and its "not a text file"
    // toast) is unreachable for video.
    if (!openMediaViewer("media/clip.mp4")) fallback("media/clip.mp4");
    expect(document.querySelector(".md-video-viewer")).toBeTruthy();
    expect(fallback).not.toHaveBeenCalled();
  });

  test("pdf opens its setless viewer", () => {
    seed("docs/spec.pdf", "docs/other.pdf");
    expect(openMediaViewer("docs/spec.pdf")).toBe(true);
    expect(document.querySelector(".md-pdf-viewer")).toBeTruthy();
    // Setless: no image-zoom nav chrome rides along.
    expect(document.querySelector(".md-image-zoom-nav")).toBeNull();
  });

  test("text, markdown, and audio stay outside the router", () => {
    seed("notes/readme.md", "notes/plain.txt", "media/song.mp3");
    const fallback = vi.fn();
    for (const path of ["notes/readme.md", "notes/plain.txt", "media/song.mp3"]) {
      if (!openMediaViewer(path)) fallback(path);
    }
    // All three fall through to the caller's open attempt, exactly as
    // before; no viewer overlay mounted.
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(imageViewer()).toBeNull();
    expect(document.querySelector(".md-video-viewer")).toBeNull();
    expect(document.querySelector(".md-pdf-viewer")).toBeNull();
  });
});

describe("viewer dismissal lifecycle", () => {
  test("Escape dismissal runs each viewer's own teardown", () => {
    seed("a/pic.png", "media/clip.mp4", "docs/spec.pdf");

    // Image: the live viewer consumes Escape (capture listener armed)...
    openMediaViewer("a/pic.png");
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(imageViewer()).toBeNull();
    // ...and a follow-up Escape reaches no handler: the listener was
    // removed with the viewer, not leaked.
    expect(pressEscape().defaultPrevented).toBe(false);

    // Video: dismissal also tears the stream down - pause, src detach,
    // and the reload that drops the buffer.
    openMediaViewer("media/clip.mp4");
    const video = document.querySelector<HTMLVideoElement>(
      ".md-video-viewer video",
    )!;
    expect(video.getAttribute("src")).toContain("/api/files/media/clip.mp4");
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(document.querySelector(".md-video-viewer")).toBeNull();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(video.getAttribute("src")).toBeNull();
    expect(pressEscape().defaultPrevented).toBe(false);

    // PDF: same listener discipline.
    openMediaViewer("docs/spec.pdf");
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(document.querySelector(".md-pdf-viewer")).toBeNull();
    expect(pressEscape().defaultPrevented).toBe(false);
  });
});

describe("dirImageSet", () => {
  test("same-directory images only, display order, browser-shaped entries", () => {
    seed("a/z.png", "a/deep/n.png", "a/a.jpg", "a/song.mp3", "root.png");
    expect(dirImageSet("a/z.png")).toEqual([
      { src: "a/z.png", fromPath: null },
      { src: "a/a.jpg", fromPath: null },
    ]);
    // A root-level file sets a root-level directory scope.
    expect(dirImageSet("root.png")).toEqual([
      { src: "root.png", fromPath: null },
    ]);
  });
});
