// Sound and moving pictures stop when the screen lock comes up, and stay
// stopped after it lifts: nothing resumes, and each player keeps its position.
// The rule is for every <video> and <audio> in the page rather than for each
// viewer, since rendered markdown can hold its own. A cross-origin embed's or
// an extension's frame is out of the page's reach.
//
// Element fullscreen is viewerLayer's. A video can also present outside the
// page, in picture-in-picture or in WebKit's own video fullscreen, where the
// lock would paint underneath it, so those end here.

import { screensaver } from "./screensaver.svelte";

/// WebKit's own video presentation, which the standard types do not name.
type WebKitVideo = HTMLMediaElement & {
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitDisplayingFullscreen?: boolean;
  webkitExitFullscreen?: () => void;
};

function stopMedia(media: HTMLMediaElement): void {
  media.pause();
  const video = media as WebKitVideo;
  if (video.webkitPresentationMode && video.webkitPresentationMode !== "inline") {
    video.webkitSetPresentationMode?.("inline");
  } else if (video.webkitDisplayingFullscreen) {
    video.webkitExitFullscreen?.();
  }
}

function stopAllMedia(): void {
  for (const media of document.querySelectorAll<HTMLMediaElement>("video, audio")) stopMedia(media);
  if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
}

/// Stop every player as the lock comes up, and any that starts while it is
/// up (`play` does not bubble, so it is caught on its way down). Returns the
/// teardown.
export function installLockMediaPause(): () => void {
  const onPlay = (event: Event): void => {
    if (screensaver.locked && event.target instanceof HTMLMediaElement) stopMedia(event.target);
  };
  document.addEventListener("play", onPlay, true);
  const stopEffect = $effect.root(() => {
    $effect(() => {
      if (screensaver.locked) stopAllMedia();
    });
  });
  return () => {
    document.removeEventListener("play", onPlay, true);
    stopEffect();
  };
}
