// @vitest-environment jsdom
//
// A video presenting outside the page leaves it as the screen lock comes up,
// or the lock would paint underneath it. Chrome has no WebKit presentation
// modes and a headless one no picture-in-picture window, so the browser check
// cannot raise these; it covers the pause, a play under the lock and autoplay.

import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installLockMediaPause } from "./lockMedia.svelte";
import { screensaver } from "./screensaver.svelte";

let teardown: () => void;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  teardown = installLockMediaPause();
});

afterEach(() => {
  screensaver.locked = false;
  flushSync();
  teardown();
  vi.restoreAllMocks();
  delete (document as { pictureInPictureElement?: unknown }).pictureInPictureElement;
  delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
  document.body.replaceChildren();
});

function lock(): void {
  screensaver.locked = true;
  flushSync();
}

function video(fields: Record<string, unknown>): HTMLVideoElement {
  const element = document.body.appendChild(document.createElement("video"));
  return Object.assign(element, fields);
}

test("a video in WebKit's fullscreen or picture-in-picture presentation returns inline", () => {
  const webkitSetPresentationMode = vi.fn();
  video({ webkitPresentationMode: "fullscreen", webkitSetPresentationMode });
  const pip = vi.fn();
  video({ webkitPresentationMode: "picture-in-picture", webkitSetPresentationMode: pip });
  lock();
  expect(webkitSetPresentationMode).toHaveBeenCalledWith("inline");
  expect(pip).toHaveBeenCalledWith("inline");
});

test("a video already inline is left in its presentation", () => {
  const webkitSetPresentationMode = vi.fn();
  video({ webkitPresentationMode: "inline", webkitSetPresentationMode });
  lock();
  expect(webkitSetPresentationMode).not.toHaveBeenCalled();
});

test("a video in WebKit's older fullscreen leaves it", () => {
  const webkitExitFullscreen = vi.fn();
  video({ webkitDisplayingFullscreen: true, webkitExitFullscreen });
  lock();
  expect(webkitExitFullscreen).toHaveBeenCalledTimes(1);
});

test("a video that enters WebKit's fullscreen as it starts under the lock leaves it", () => {
  lock();
  const webkitExitFullscreen = vi.fn();
  const element = video({ webkitDisplayingFullscreen: true, webkitExitFullscreen });
  element.dispatchEvent(new Event("play"));
  expect(webkitExitFullscreen).toHaveBeenCalledTimes(1);
});

test("a picture-in-picture window closes", () => {
  const exitPictureInPicture = vi.fn(async () => {});
  const element = video({});
  Object.defineProperty(document, "pictureInPictureElement", { configurable: true, value: element });
  Object.defineProperty(document, "exitPictureInPicture", { configurable: true, value: exitPictureInPicture });
  lock();
  expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
});
