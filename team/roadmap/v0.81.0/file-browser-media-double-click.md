# File browser: double-click opens media in view mode

Status: REGISTERED for v0.81.0, grounded 2026-07-29, ready to spec.

## What

In the file browser, single-clicking a media file keeps doing what it does today (select + open the inspector). Double-clicking should open the file in view mode, the same way double-clicking a `.md` opens the editor: images and SVG in the image viewer, video in the video viewer, PDF in the PDF viewer. The inspector's View action already does exactly this, so the functionality exists; the row gesture just never reaches it.

## What is already known (grounding, verified 2026-07-29)

Today's behavior split, all in `web/packages/workspace-app/src/components/FileTree.svelte` (the only row renderer, mounted by `FileBrowserSurface.svelte:553` for all variants):

- The row binds `ondblclick` only when `openable`, and `openable` is `classifyPath(node.path) !== "media"` (`FileTree.svelte:1302`, `1347`). Images (including SVG) and PDFs classify as `media`, so double-click on them is a no-op.
- Video is not in `classifyPath`'s media branch (it stays `binary`, `state/fileTypes.ts:306-308`), so a double-clicked mp4 IS "openable", reaches `openInActivePane`, and dead-ends in the server text probe with the toast `'<path>' is not a text file` (`state/tabs.svelte.ts:2665-2669`). So today: image/SVG/PDF double-click = nothing; video double-click = error toast.
- Enter on a row uses the same media gate (`FileTree.svelte:851-861`) and should gain the same behavior for keyboard parity.

The viewers are imperative helpers, callable from anywhere (appended to body, no component/state footprint):

- `openImageZoom(src, fromPath, set?)` (`state/imageZoom.ts:37`) with an optional sibling set for prev/next; the inspector builds it via `dirImageSet` (`components/FileInfoBody.svelte:159-164`, images-only, same-directory).
- `openVideoViewer(path)` (`state/videoViewer.ts:23`).
- `openPdfViewer(path)` (`state/pdfViewer.ts:23`).

The inspector's main action maps exactly this way already (`FileInfoBody.svelte:645-655`): image -> View / Zoom, video -> View Video, pdf -> View PDF. The change is routing the row's double-click (and Enter) to the same calls instead of the `openable` no-op / toast.

Not in scope: a media tab kind. There is no image/video `FileTab` variant (`state/tabs.svelte.ts:612-617`) and `openInPane` hard-refuses non-text; double-click lands on the viewer overlays, not a new editor surface.

## Rough size

Small. Route the dblclick/Enter gates for media to the matching viewer helper; lift or share `dirImageSet` for the image sibling set. Regression: video double-click stops toasting.

## Open

- Whether image double-click passes the same-directory sibling set (inspector parity says yes) and whether video/PDF stay setless like the inspector today; prev/next across mixed media is already a carried rider on the video-preview-and-range-serving item (v0.80.0, moves to `done/` at its GA).
- Whether audio (.mp3) joins the video path here once the audio preview UI rider lands.
