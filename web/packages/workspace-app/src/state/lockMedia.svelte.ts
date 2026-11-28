// Sound and moving pictures stop when the screen lock comes up, and stay
// stopped after it lifts: nothing resumes, and each player keeps its position.
// The rule is for every <video> and <audio> in the page rather than for each
// viewer, since rendered markdown can hold its own.
//
// A YouTube embed's frame is cross-origin, so the page reaches its player only
// through the player's API, which the embed's src enables (api/embed.ts): the
// lock posts each such frame the player's pause, which keeps the position,
// addressed to the embed origin so that a frame showing any other document
// receives nothing. A map's frame, an extension's and a frame on any other
// origin are sent nothing; the page knows no command of theirs. A player's
// start cannot be heard across origins, so a YouTube embed that loads while
// the lock is up, new or reloading, is sent the pause as it loads, which holds
// off a player that would start by itself. Nothing the frame posts is read.
//
// Element fullscreen is viewerLayer's. A video can also present outside the
// page, in picture-in-picture or in WebKit's own video fullscreen, where the
// lock would paint underneath it, so those end here.

import { isYouTubeEmbedSrc, YOUTUBE_EMBED_ORIGIN } from "../api/embed";
import { screensaver } from "./screensaver.svelte";

/// The player API's pause command, as YouTube's embed reads a posted message.
const YOUTUBE_PAUSE = JSON.stringify({ event: "command", func: "pauseVideo", args: [] });

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

function pauseYouTubeEmbed(frame: HTMLIFrameElement): void {
  if (isYouTubeEmbedSrc(frame.src)) frame.contentWindow?.postMessage(YOUTUBE_PAUSE, YOUTUBE_EMBED_ORIGIN);
}

function stopAllMedia(): void {
  for (const media of document.querySelectorAll<HTMLMediaElement>("video, audio")) stopMedia(media);
  for (const frame of document.querySelectorAll("iframe")) pauseYouTubeEmbed(frame);
  if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
}

/// Stop every player as the lock comes up, any that starts while it is up,
/// and any YouTube embed that loads while it is up (neither `play` nor a
/// frame's `load` bubbles, so both are caught on their way down). Returns the
/// teardown.
export function installLockMediaPause(): () => void {
  const onPlay = (event: Event): void => {
    if (screensaver.locked && event.target instanceof HTMLMediaElement) stopMedia(event.target);
  };
  const onLoad = (event: Event): void => {
    if (screensaver.locked && event.target instanceof HTMLIFrameElement) pauseYouTubeEmbed(event.target);
  };
  document.addEventListener("play", onPlay, true);
  document.addEventListener("load", onLoad, true);
  const stopEffect = $effect.root(() => {
    $effect(() => {
      if (screensaver.locked) stopAllMedia();
    });
  });
  return () => {
    document.removeEventListener("play", onPlay, true);
    document.removeEventListener("load", onLoad, true);
    stopEffect();
  };
}
