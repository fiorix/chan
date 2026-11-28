// @vitest-environment jsdom
//
// A video presenting outside the page leaves it as the screen lock comes up,
// or the lock would paint underneath it. Chrome has no WebKit presentation
// modes and a headless one no picture-in-picture window, so the browser check
// cannot raise these; it covers the pause, a play under the lock and autoplay.
//
// A YouTube embed is paused by a command posted to its cross-origin frame. The
// tests here read what the page posts and to which frames; that a real player
// obeys it is the networked reading's.

import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { embedIframeHtml } from "../api/embed";
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

function unlock(): void {
  screensaver.locked = false;
  flushSync();
}

/// YouTube's player API pause, which a probe of a real embed showed the
/// player obeys at once with no handshake, and the origin it is addressed to.
const PAUSE = '{"event":"command","func":"pauseVideo","args":[]}';
const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

const YOUTUBE = embedIframeHtml("https://youtu.be/dQw4w9WgXcQ")!;
/// An author's raw iframe the sanitizer keeps, with no player parameter.
const YOUTUBE_RAW = '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>';
/// A map, an extension's tab, and a frame on another origin: the shape of an
/// Excalidraw board's video embed.
const NOT_YOUTUBE = [
  embedIframeHtml("https://www.google.com/maps/embed?pb=!1m18!1m12!1m3")!,
  '<iframe src="/ext/echo/index.html" sandbox="allow-forms allow-scripts"></iframe>',
  '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1"></iframe>',
];

/// A frame in the page, with every message posted to its window recorded.
function frame(html: string) {
  const holder = document.body.appendChild(document.createElement("div"));
  holder.innerHTML = html;
  const element = holder.querySelector("iframe")!;
  return { element, posts: vi.spyOn(element.contentWindow!, "postMessage") };
}

/// A frame's document finished loading; the event does not bubble.
function load(element: HTMLIFrameElement): void {
  element.dispatchEvent(new Event("load"));
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

test("at the lock every YouTube embed frame is sent the player's pause, addressed to the embed origin", () => {
  const rendered = frame(YOUTUBE);
  const raw = frame(YOUTUBE_RAW);
  expect(rendered.posts).not.toHaveBeenCalled();
  lock();
  expect(rendered.posts.mock.calls).toEqual([[PAUSE, EMBED_ORIGIN]]);
  expect(raw.posts.mock.calls).toEqual([[PAUSE, EMBED_ORIGIN]]);
});

test("at the lock a map, an extension and a frame on any other origin are sent nothing", () => {
  const youtube = frame(YOUTUBE);
  const others = NOT_YOUTUBE.map(frame);
  lock();
  expect(youtube.posts).toHaveBeenCalledTimes(1);
  for (const other of others) expect(other.posts, other.element.src).not.toHaveBeenCalled();
});

test("nothing is sent to an embed when the lock lifts", () => {
  const youtube = frame(YOUTUBE);
  lock();
  expect(youtube.posts).toHaveBeenCalledTimes(1);
  unlock();
  expect(youtube.posts).toHaveBeenCalledTimes(1);
});

test("a YouTube embed that arrives while the lock is up is sent the pause as it loads", () => {
  lock();
  const rendered = frame(YOUTUBE);
  const raw = frame(YOUTUBE_RAW);
  expect(rendered.posts).not.toHaveBeenCalled();
  load(rendered.element);
  load(raw.element);
  expect(rendered.posts.mock.calls).toEqual([[PAUSE, EMBED_ORIGIN]]);
  expect(raw.posts.mock.calls).toEqual([[PAUSE, EMBED_ORIGIN]]);
});

test("a YouTube embed that reloads under the lock is sent the pause again", () => {
  const youtube = frame(YOUTUBE);
  lock();
  load(youtube.element);
  expect(youtube.posts.mock.calls).toEqual([
    [PAUSE, EMBED_ORIGIN],
    [PAUSE, EMBED_ORIGIN],
  ]);
});

test("a YouTube embed that loads with no lock up is sent nothing, before a lock or after one", () => {
  const youtube = frame(YOUTUBE);
  load(youtube.element);
  expect(youtube.posts).not.toHaveBeenCalled();
  lock();
  unlock();
  load(youtube.element);
  expect(youtube.posts).toHaveBeenCalledTimes(1);
});

test("under the lock a map, an extension and a frame on any other origin are sent nothing as they load", () => {
  lock();
  const youtube = frame(YOUTUBE);
  const others = NOT_YOUTUBE.map(frame);
  for (const each of [youtube, ...others]) load(each.element);
  expect(youtube.posts).toHaveBeenCalledTimes(1);
  for (const other of others) expect(other.posts, other.element.src).not.toHaveBeenCalled();
});
