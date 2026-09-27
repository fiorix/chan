// File preview popover. Anchored to a clicked widget (wiki / contact
// pill, image atom etc.) and shown in read-only contexts where the
// usual "click reveals source" affordance doesn't apply (user-toggled
// read mode, fs-locked file).
//
// Behavior:
//   - markdown / text files: fetch and render via the chat-bubble
//     marked + DOMPurify pipeline. Cap height at 50vh with internal
//     scroll so a long file fits comfortably on screen.
//   - image files (.png / .jpg / .jpeg / .webp / .gif / .svg):
//     render an <img> directly; the token-stamped URL goes through
//     resolveImageSrc against the host file's directory.
//   - anything else: short "binary file" placeholder.
//
// Keys + dismiss:
//   - Cmd/Ctrl+Enter or click "Open" -> caller's onOpen (with Shift
//     flagging open-in-new-pane).
//   - Esc, outside click, scroll -> dismiss.
//   - One popover at a time: opening another dismisses this one.

import { api } from "../../api/client";
import { renderMarkdown } from "../../api/markdown";
import { resolveImageSrc } from "../extensions/image";

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
]);

const TEXT_EXTS = new Set([".md", ".txt", ".markdown"]);

export interface PreviewPopoverOpts {
  /// DOM element to anchor the popover under (the clicked widget).
  anchor: HTMLElement;
  /// Workspace-rooted POSIX path of the file to preview.
  path: string;
  /// Path of the file the popover was opened FROM, when known. Used
  /// to resolve relative image refs inside the preview (mirrors the
  /// editor's wiki / image resolution).
  fromPath?: string | null;
  /// Called when the user commits to fully opening the previewed
  /// file. `openInNewPane` is true when the user held Shift on
  /// Cmd/Ctrl+Enter (or the Open button) - mirrors the existing
  /// wiki Cmd-click convention.
  onOpen: (openInNewPane: boolean) => void;
  /// Optional dismiss notifier (cleanup hooks; the popover already
  /// removes its own DOM on dismiss).
  onDismiss?: () => void;
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

// The popover on screen. Each popover takes its keys from a capture
// listener on the document, where the one added first runs first and
// stops the event, so a second popover opened over this one would
// leave the covered preview taking the Escape and Mod+Enter meant for
// the visible one.
let dismissCurrent: (() => void) | null = null;

export function openPreviewPopover(
  opts: PreviewPopoverOpts,
): { dismiss: () => void } {
  dismissCurrent?.();
  let alive = true;
  const wrap = document.createElement("div");
  wrap.className = "md-preview-popover";
  wrap.style.position = "absolute";
  wrap.style.zIndex = "30000";
  document.body.appendChild(wrap);

  const header = document.createElement("div");
  header.className = "md-preview-header";
  const pathLabel = document.createElement("span");
  pathLabel.className = "md-preview-path";
  pathLabel.textContent = opts.path;
  header.appendChild(pathLabel);
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "md-preview-open";
  openBtn.textContent = "Open ↗";
  openBtn.title = "open this file (Cmd/Ctrl+Enter)";
  openBtn.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    commit(e.metaKey || e.ctrlKey || e.shiftKey);
  });
  header.appendChild(openBtn);
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "md-preview-body";
  body.textContent = "loading...";
  wrap.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "md-preview-footer";
  footer.innerHTML =
    '<span class="md-preview-hint">⌘+Enter / Ctrl+Enter to open - Esc to close</span>';
  wrap.appendChild(footer);

  positionUnderAnchor();

  const ext = extOf(opts.path);
  if (IMAGE_EXTS.has(ext)) {
    renderImage();
  } else if (TEXT_EXTS.has(ext) || ext === "") {
    // Treat extensionless paths as text too - chan-workspace permits .md
    // / .txt only for writes, but the editor often references files
    // by stem (wiki autocomplete strips extensions on suggest); reads
    // succeed regardless.
    renderText();
  } else {
    body.innerHTML = "";
    body.appendChild(
      Object.assign(document.createElement("div"), {
        className: "md-preview-binary",
        textContent: "binary file - open it to view",
      }),
    );
    positionUnderAnchor();
  }

  function renderImage(): void {
    body.innerHTML = "";
    const img = document.createElement("img");
    img.className = "md-preview-img";
    img.src = resolveImageSrc(opts.path, opts.fromPath ?? null);
    img.alt = opts.path;
    img.onload = positionUnderAnchor;
    img.onerror = () => {
      body.textContent = "couldn't load image";
    };
    body.appendChild(img);
  }

  function renderText(): void {
    void api.read(opts.path).then(
      (resp) => {
        if (!alive) return;
        body.innerHTML = "";
        const md = document.createElement("div");
        md.className = "md-preview-md";
        md.innerHTML = renderMarkdown(resp.content ?? "");
        body.appendChild(md);
        positionUnderAnchor();
      },
      (e) => {
        if (!alive) return;
        body.innerHTML = "";
        body.textContent = `couldn't read: ${(e as Error).message}`;
      },
    );
  }

  function positionUnderAnchor(): void {
    const rect = opts.anchor.getBoundingClientRect();
    const popH = wrap.offsetHeight;
    const popW = wrap.offsetWidth;
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    const GAP = 6;
    const spaceBelow = viewH - rect.bottom;
    const spaceAbove = rect.top;
    let top: number;
    if (popH > 0 && spaceBelow < popH + GAP && spaceAbove > spaceBelow) {
      top = rect.top + window.scrollY - popH - GAP;
    } else {
      top = rect.bottom + window.scrollY + GAP;
    }
    let left = rect.left + window.scrollX;
    if (popW > 0 && left + popW > viewW - 8) {
      left = Math.max(8, viewW - popW - 8) + window.scrollX;
    }
    wrap.style.top = `${top}px`;
    wrap.style.left = `${left}px`;
  }

  function commit(openInNewPane: boolean): void {
    if (!alive) return;
    dismiss();
    opts.onOpen(openInNewPane);
  }

  function outsideClick(e: MouseEvent): void {
    if (wrap.contains(e.target as Node)) return;
    dismiss();
  }

  function keyHandler(e: KeyboardEvent): void {
    if (!alive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      commit(e.shiftKey);
    }
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    if (dismissCurrent === dismiss) dismissCurrent = null;
    document.removeEventListener("mousedown", outsideClick, true);
    document.removeEventListener("keydown", keyHandler, true);
    window.removeEventListener("scroll", dismiss, true);
    wrap.remove();
    opts.onDismiss?.();
  }

  // Defer wiring outside-click so the click that opened the popover
  // doesn't immediately count as outside (mirrors date_popover).
  setTimeout(() => {
    if (!alive) return;
    document.addEventListener("mousedown", outsideClick, true);
    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("scroll", dismiss, true);
  }, 0);

  dismissCurrent = dismiss;
  return { dismiss };
}
