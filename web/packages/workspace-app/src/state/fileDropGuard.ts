// SPA-global file-drop guard.
//
// Without it, dropping an OS file anywhere the SPA doesn't intercept
// makes the webview navigate into a bare file view with no way back
// (chan-desktop builds with Tauri's drag-drop handler DISABLED so DOM
// DnD keeps working; WKWebView's and WebKitGTK's default drop-navigation
// then fires on any unhandled drop -- and a plain browser tab behaves
// the same).
//
// Design: the guard acts ONLY on OS file drags, in the two shapes an
// engine hands a page: `dataTransfer.types` includes "Files" (Chrome,
// WKWebView, WebView2), or, on the desktop, it includes "text/uri-list"
// for a drag this document did not start (WebKitGTK hands a file dragged
// in from another application as its `file:` URI and no Files). In-page
// HTML5 drags -- pane tab moves, the file tree's row moves, the editor's
// image-atom move, a link or image the engine drags itself -- never
// carry the Files type and always start in this document, so their
// dragover/dropEffect semantics are untouched.
//
// For OS file drags:
//   - window `dragover` (capture): always preventDefault (an
//     uncancelled dragover makes the release navigate); outside the
//     allowlisted drop zones additionally set `dropEffect = "none"` so
//     the cursor honestly shows not-allowed and no drop fires there.
//   - window `drop` (capture): preventDefault outside the zones --
//     belt for browsers that fire a drop despite the none effect.
//     Inside a zone the guard does nothing: the zone's own handlers
//     (editor image embed, CodeMirror's native text-file insert, the
//     terminal path-print) keep their behavior, preventDefault
//     included.
//   - window `drop` (bubble): the safety net. Runs after every zone
//     handler; anything still uncancelled (e.g. a read-only editor
//     that ignored the drop) is cancelled here, so no drop ever
//     reaches the webview's default navigation.
//
// A drop zone is any element under `[data-file-drop-zone]` (explicit
// opt-in: the markdown editors, the rich-prompt composer, terminal
// panes) or under `.cm-editor` (every editable CodeMirror instance
// handles file drops natively; read-only ones fall through to the
// bubble net).

import { isTauriDesktop } from "../api/desktop";

const DROP_ZONE_SELECTOR = "[data-file-drop-zone], .cm-editor";

/// True when the drag carries OS files. In-page drags (tab moves,
/// tree moves, image-atom moves) never include the "Files" type.
export function isOsFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DataTransfer.types is a frozen array in modern browsers but a
  // DOMStringList in older WebKit; Array.prototype.includes works on
  // both via indexOf semantics -- normalise defensively.
  return Array.from(types).includes("Files");
}

/// A drag this document started: set at its `dragstart` and cleared when
/// it ends here. A drag from another application never starts in this
/// document. The drop clears it after its dispatch as well, since a source
/// that the drop removes from the document never receives its `dragend`.
let pageDrag = false;

/// True when the drag carries OS files as WebKitGTK hands them to a page
/// on the Linux desktop: `text/uri-list` and no Files, from a drag this
/// document did not start. The URIs are readable only at the drop, so at
/// dragover the type is all there is to key on, and a link dragged in from
/// another application counts too: the guard keeps either from navigating
/// the window.
export function isDesktopUriDrag(e: DragEvent): boolean {
  if (pageDrag || !isTauriDesktop()) return false;
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("text/uri-list");
}

/// The `file:` URIs a drop's `text/uri-list` carries, in order. Comment
/// lines and other schemes are left out. Readable only during the drop.
export function droppedFileUris(dataTransfer: DataTransfer | null | undefined): string[] {
  const list = dataTransfer?.getData("text/uri-list") ?? "";
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && /^file:/i.test(line));
}

/// True when a drop on the desktop carries files from another application
/// that the page cannot read: it lists `text/uri-list` and no Files, did not
/// start in this document, and either keeps the list from the page (WebKitGTK
/// answers empty for a drag carrying files, so a page learns no path) or names
/// `file:` URIs. A link dragged in from a browser shows its URL and is not one.
/// Readable only during the drop.
export function isDesktopFileDrop(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer || pageDrag || !isTauriDesktop()) return false;
  const types = Array.from(dataTransfer.types ?? []);
  if (types.includes("Files") || !types.includes("text/uri-list")) return false;
  return dataTransfer.getData("text/uri-list") === "" || droppedFileUris(dataTransfer).length > 0;
}

function isGuardedDrag(e: DragEvent): boolean {
  return isOsFileDrag(e) || isDesktopUriDrag(e);
}

/// True when the event target sits inside an allowlisted drop zone.
export function inFileDropZone(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(DROP_ZONE_SELECTOR) !== null;
}

function onWindowDragStartCapture(): void {
  pageDrag = true;
}

function onWindowDragEndCapture(): void {
  pageDrag = false;
}

function onWindowDragOverCapture(e: DragEvent): void {
  if (!isGuardedDrag(e)) return;
  e.preventDefault();
  if (!inFileDropZone(e.target) && e.dataTransfer) {
    e.dataTransfer.dropEffect = "none";
  }
}

function onWindowDropCapture(e: DragEvent): void {
  // Once this drop's dispatch has run, the drag is over.
  if (pageDrag) setTimeout(onWindowDragEndCapture, 0);
  if (!isGuardedDrag(e)) return;
  if (!inFileDropZone(e.target)) e.preventDefault();
}

function onWindowDropBubble(e: DragEvent): void {
  if (!isGuardedDrag(e)) return;
  if (!e.defaultPrevented) e.preventDefault();
}

/// Install the guard once at App boot. Returns a disposer (tests use
/// it; the App-lifetime install never tears down).
export function installFileDropGuard(win: Window = window): () => void {
  win.addEventListener("dragstart", onWindowDragStartCapture, true);
  win.addEventListener("dragend", onWindowDragEndCapture, true);
  win.addEventListener("dragover", onWindowDragOverCapture, true);
  win.addEventListener("drop", onWindowDropCapture, true);
  win.addEventListener("drop", onWindowDropBubble, false);
  return () => {
    win.removeEventListener("dragstart", onWindowDragStartCapture, true);
    win.removeEventListener("dragend", onWindowDragEndCapture, true);
    win.removeEventListener("dragover", onWindowDragOverCapture, true);
    win.removeEventListener("drop", onWindowDropCapture, true);
    win.removeEventListener("drop", onWindowDropBubble, false);
    pageDrag = false;
  };
}

// ---- terminal path-print escaping -----------------------------------
//
// Desktop-only: the terminal pane's drop handler reads the dropped
// files' absolute paths over the `read_dropped_paths` IPC (the DOM
// File API never exposes OS paths) and types them into the PTY.
// Escaping is POSIX single-quote: wrap in '…', embedded ' becomes
// '\'' (close quote, escaped literal quote, reopen). Multiple paths
// are space-separated with a single trailing space -- Terminal.app
// behavior, so the user can keep typing flags right after.

/// POSIX single-quote escape of one path.
export function escapePosixPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/// The exact string typed into the PTY for a set of dropped paths.
/// Empty input produces an empty string (silent no-op upstream).
export function shellEscapePaths(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return paths.map(escapePosixPath).join(" ") + " ";
}
