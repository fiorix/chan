// Fullscreen audio viewer. The browser supplies playback controls; chan only
// provides a tokenized byte URL and lifecycle ownership for the media element.

import { fileUrl } from "../api/client";
import { openViewerOverlay } from "./viewerOverlay";

export const AUDIO_UNSUPPORTED_MESSAGE =
  "This audio format is not supported by this browser.";

/// Open a setless audio viewer for one workspace-relative path.
///
/// The player never autoplays. Dismissal tears down the media source so a
/// closed viewer cannot keep downloading or playing in the background.
export function openAudioViewer(path: string): void {
  if (!path) return;
  const src = fileUrl(path);

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.autoplay = false;
  audio.preload = "metadata";
  audio.src = src;
  audio.style.cssText = "width:min(92vw,720px);max-width:100%;";

  const error = document.createElement("p");
  error.className = "md-audio-viewer-error";
  error.textContent = AUDIO_UNSUPPORTED_MESSAGE;
  error.hidden = true;
  error.setAttribute("role", "status");
  error.style.cssText =
    "margin:0;color:#fff;font:500 14px system-ui,sans-serif;text-align:center;";

  const onError = (): void => {
    error.hidden = false;
  };
  audio.addEventListener("error", onError);

  openViewerOverlay({
    className: "md-audio-viewer",
    layout:
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "gap:0.75rem;padding:1rem;",
    surface: [audio, error],
    dismissOnBackdropClick: true,
    teardown: () => {
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
  });
}
