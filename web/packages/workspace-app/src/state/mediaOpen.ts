// Path-to-viewer routing for media files, shared by the file browser's
// row gestures (double-click / Enter) and the inspector's main media
// action so the image/video/PDF mapping cannot fork. Deliberately
// narrow: non-media returns false and the CALLER decides the fallback
// (the file tree attempts a text open); this module never imports
// tab-opening state.

import { isImage, isPdf, isVideo } from "./fileTypes";
import { openImageZoom, type ZoomImage } from "./imageZoom";
import { openPdfViewer } from "./pdfViewer";
import { openVideoViewer } from "./videoViewer";
import { tree } from "./store.svelte";

function parentDir(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
}

/// Images that sit in the SAME directory as `p`, in the file tree's
/// display order. Backs the fullscreen viewer's prev/next when the
/// view is opened from the file browser (flat directory, no recursion).
export function dirImageSet(p: string): ZoomImage[] {
  const dir = parentDir(p);
  return tree.entries
    .filter((e) => !e.is_dir && isImage(e.path) && parentDir(e.path) === dir)
    .map((e) => ({ src: e.path, fromPath: null }));
}

/// Open `path` in its media viewer: images (raster + svg) in the image
/// zoom with the same-directory sibling set, video and PDF in their
/// setless viewers - the same mapping the inspector's main action uses.
/// Returns false untouched for everything else (including audio, which
/// stays outside the router until its preview surface lands).
export function openMediaViewer(path: string): boolean {
  if (isImage(path)) {
    openImageZoom(path, null, dirImageSet(path));
    return true;
  }
  if (isVideo(path)) {
    openVideoViewer(path);
    return true;
  }
  if (isPdf(path)) {
    openPdfViewer(path);
    return true;
  }
  return false;
}
