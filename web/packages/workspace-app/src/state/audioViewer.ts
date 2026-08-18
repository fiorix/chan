// Fullscreen audio viewer. The browser supplies playback controls; chan only
// provides a tokenized byte URL and lifecycle ownership for the media element.

import { withTokenQuery } from "../api/transport";

export const AUDIO_UNSUPPORTED_MESSAGE =
  "This audio format is not supported by this browser.";

/// Open a setless audio viewer for one workspace-relative path.
///
/// The player never autoplays. Dismissal tears down the media source so a
/// closed viewer cannot keep downloading or playing in the background.
export function openAudioViewer(path: string): void {
  if (!path) return;
  const src = withTokenQuery(
    `/api/fs/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
  );

  const backdrop = document.createElement("div");
  backdrop.className = "md-audio-viewer";
  backdrop.style.cssText =
    "position:fixed;inset:0;z-index:40000;" +
    "background:rgba(0,0,0,0.92);" +
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:0.75rem;padding:1rem;";

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.title = "Close (Esc)";
  close.style.cssText =
    "position:absolute;top:1rem;right:1rem;z-index:1;" +
    "background:rgba(255,255,255,0.9);color:#000;" +
    "border:0;border-radius:4px;padding:4px 10px;cursor:pointer;" +
    "font:600 13px system-ui,sans-serif;";

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

  backdrop.appendChild(audio);
  backdrop.appendChild(error);
  backdrop.appendChild(close);
  document.body.appendChild(backdrop);

  const dismiss = (): void => {
    document.removeEventListener("keydown", onKey, true);
    audio.removeEventListener("error", onError);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    backdrop.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dismiss();
  };
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKey, true);
}
