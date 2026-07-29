# Video (and audio) preview + View, with HTTP range serving

Status: IMPLEMENTED on main (e0987974, 2026-07-29). Video (mp4/webm/mov) inline preview + fullscreen View in both inspectors; /api/files serves media with Accept-Ranges + 206 over the bounded reader; mp3 rides the server path with no audio UI yet. Riders carried forward: audio preview UI, viewer prev/next across mixed media, resumable downloads.

## What

Support video files (.mp4 first, then .webm/.mov) for inline preview and the full-window "View", the same way images and PDFs already work in the file browser inspector and the graph inspector. Audio (.mp3) rides the same path for free once range serving lands.

## What is already known (grounding, verified 2026-07-24)

The two inspectors share one body, so anything added to it lands in both: FileInfoBody.svelte is rendered by both the file browser inspector and the graph inspector (via InspectorBody.svelte; its comment: "the graph 'image-ish file' node both get the same preview").

Frontend is a near-mirror of the existing image path (small):
- web/.../state/fileTypes.ts has IMAGE_EXTENSIONS + isImage but NO video set; video currently falls into "Other". Add VIDEO_EXTENSIONS + isVideo.
- web/.../components/FileInfoBody.svelte: add a video branch. Inline preview renders a <video controls> instead of <img> (image preview is around line 1055); kindFor returns a "video" kind (around line 78); the action pill gives a "View" action modeled on the existing "View / Zoom" for images and "View PDF" for PDFs (around line 644).
- A full-window viewer: a small state module + component sibling to state/pdfViewer.ts (image uses state/imageZoom.ts). Video wants play/pause/scrub/fullscreen, NOT pinch-zoom, so a dedicated viewer is cleaner than reusing imageZoom.
- Directory prev/next: the flat-directory image list at FileInfoBody.svelte 154-159 (filters isImage) extends to media.

The one real task is server-side HTTP RANGE support (this is what makes it "some work" rather than trivial):
- crates/chan-server/src/routes/files.rs read_file_sync returns ReadFileResult::Data(Bytes), i.e. the WHOLE file is read into memory and returned as a single 200 with no Accept-Ranges / 206. Fine for images and PDFs; wrong for video. Without ranges, a <video> cannot seek/scrub, and a large mp4 buffers entirely in server RAM and re-streams from the start on every seek.
- Add Range / 206 Partial Content handling (parse Range, return Content-Range
  + Accept-Ranges: bytes, read only the requested slice), OR serve media through tower-http ServeFile (which does ranges out of the box) on a scoped media path.
- content_type_for (crate::static_assets) must map .mp4 -> video/mp4 (and .webm/.mov, .mp3 for audio). Confirm current coverage.

## Rough size

Frontend: small, a mirror of the image path. Server range support: the one moderate chunk (real, because the route currently buffers whole files). Call it a focused day or two. The same range work makes audio trivial and helps the large-file download hang (see [`../done/upload-download-budgets.md`](../done/upload-download-budgets.md), which closed in v0.76.0 with bounded streaming transfers; the range work is the remaining piece, not a blocked dependency).

## Open (decide at spec time, not now)

- Dedicated /api/media endpoint vs range support folded into /api/files.
- Which formats ship first; codec/container reality (browser-native only, no transcode).
- Viewer UX (controls, keyboard, prev/next across mixed media).
- Size/streaming caps.
