// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { withTokenQueryMock } = vi.hoisted(() => ({
  withTokenQueryMock: vi.fn((path: string) => `${path}?t=test-token`),
}));

vi.mock("../api/transport", () => ({
  withTokenQuery: withTokenQueryMock,
}));

import {
  AUDIO_UNSUPPORTED_MESSAGE,
  openAudioViewer,
} from "./audioViewer";

let pauseSpy: ReturnType<typeof vi.fn<() => void>>;
let loadSpy: ReturnType<typeof vi.fn<() => void>>;

function viewer(): HTMLElement | null {
  return document.querySelector(".md-audio-viewer");
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function expectTornDown(audio: HTMLAudioElement): void {
  expect(viewer()).toBeNull();
  expect(audio.getAttribute("src")).toBeNull();
  expect(pauseSpy).toHaveBeenCalledOnce();
  expect(loadSpy).toHaveBeenCalledOnce();
  expect(pressEscape().defaultPrevented).toBe(false);
}

beforeEach(() => {
  withTokenQueryMock.mockClear();
  pauseSpy = vi.fn<() => void>();
  loadSpy = vi.fn<() => void>();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pauseSpy);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(loadSpy);
});

afterEach(() => {
  if (viewer()) pressEscape();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("audio viewer", () => {
  test("creates a paused native player with a tokenized source", () => {
    openAudioViewer("media/my tone.WAV");

    expect(withTokenQueryMock).toHaveBeenCalledWith(
      "/api/fs/media/my%20tone.WAV",
    );
    const audio = viewer()!.querySelector("audio")!;
    expect(audio.controls).toBe(true);
    expect(audio.autoplay).toBe(false);
    expect(audio.preload).toBe("metadata");
    expect(audio.paused).toBe(true);
    expect(audio.getAttribute("src")).toBe(
      "/api/fs/media/my%20tone.WAV?t=test-token",
    );
  });

  test("reports a decode error without dismissing the viewer", () => {
    openAudioViewer("media/broken.wav");
    const root = viewer()!;
    const audio = root.querySelector("audio")!;
    const error = root.querySelector<HTMLElement>(".md-audio-viewer-error")!;

    expect(error.hidden).toBe(true);
    audio.dispatchEvent(new Event("error"));

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(AUDIO_UNSUPPORTED_MESSAGE);
    expect(viewer()).toBe(root);
    expect(audio.getAttribute("src")).not.toBeNull();
  });

  test("the close button tears down playback and listeners", () => {
    openAudioViewer("media/track.mp3");
    const root = viewer()!;
    const audio = root.querySelector("audio")!;

    root.querySelector<HTMLButtonElement>("button")!.click();

    expectTornDown(audio);
  });

  test("an empty-backdrop click tears down playback and listeners", () => {
    openAudioViewer("media/track.ogg");
    const root = viewer()!;
    const audio = root.querySelector("audio")!;

    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectTornDown(audio);
  });

  test("Escape tears down playback and consumes only the live key event", () => {
    openAudioViewer("media/track.aiff");
    const audio = viewer()!.querySelector("audio")!;

    expect(pressEscape().defaultPrevented).toBe(true);

    expectTornDown(audio);
  });
});
