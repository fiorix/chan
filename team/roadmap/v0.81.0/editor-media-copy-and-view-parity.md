# Copy and View parity for images, in and out of presentation

Status: REGISTERED for v0.81.0, grounded 2026-07-29, ready to spec.

## What

Two parity gaps in the editor's media chrome:

1. Image previews should carry the same Copy SVG / Copy PNG buttons diagrams already have: Copy PNG puts real pixels on the clipboard for any image; Copy SVG applies when the source is an `.svg` and copies the vector markup.
2. The View / fullscreen affordance should exist over diagrams and images during presentation too (slide preview and play), not only in the normal editor surface.

## What is already known (grounding, verified 2026-07-29)

Copy buttons today, all under `web/packages/workspace-app/src/editor/`:

- Diagrams have both buttons via the shared factory `diagramCopyButton` (`widgets/diagram_copy.ts:115-170`), mounted at `widgets/diagram.ts:367-379`. PNG rasterizes client-side (`svgToPngBytes`, `diagram_copy.ts:65-89`, 64 MP guard); Copy SVG writes the vector markup as text (`diagram_copy.ts:100-105`; there is no portable SVG clipboard flavor).
- Excalidraw inline embeds get PNG-only copy (`widgets/image.ts:392-400`).
- Raster image previews have a Copy button that copies the MARKDOWN source `![alt](src)`, not pixels (`widgets/image.ts:165-172, 670-697`; pinned by `imageCopy.test.ts:68` "Cmd+C on a selected image copies its markdown, not pixels"). There is no pixel copy and no SVG-source copy anywhere on the image path.
- The clipboard plumbing already exists: `writeClipboardPayload("image/png", ...)` with canvas re-encode and a desktop-native fork (`api/clipboard.ts:83-164`). The new buttons are wiring, not new capability.

View today:

- Diagram widgets: View button gated on render success (`widgets/diagram.ts:326-353`) -> `openDiagramZoom`. Image widgets: View is unconditional and deliberately survives read-only, which is what presentation flips the editor to (`widgets/image.ts:637-641, 698-709`; `FileEditorTab.svelte:327-329` adds `slidePreviewOpen` to `readOnly`).
- The actual gap: the slide overlay does not render widgets at all. `openSlidePreview` (`state/slidePreview.ts:63`, modes `preview`/`play`) renders slides through `editor/slide_dom.ts` (`prepareSlideImages:348`, `renderSlideDiagrams:177`), which emits plain `<img>` / `<svg>` with no action row. Nothing is hidden during presentation; View and Copy were never built on that surface. Play mode additionally hides the overlay's own nav chrome (`applyChromeMode`, `slidePreview.ts:285-297`) and goes real-fullscreen (`slidePreview.ts:299-317`).

So the work is: (a) add Copy PNG (all images) + Copy SVG (`.svg` sources, fetched markup, text flavor like diagrams) to the image widget's action row (`widgets/image.ts:653-654`), reusing `diagramCopyButton`; (b) give the slide-overlay's rendered images and diagrams a View affordance (and the copy buttons if cheap) in both preview and play, opening the existing `imageZoom` / `diagramZoom` overlays.

## Rough size

Copy buttons: small, factory + plumbing exist. Slide-overlay affordances: moderate; `slide_dom.ts` output is static DOM shared with the PDF export path, so the action chrome must attach only on the live overlay, and the viewers (z 40000) need to open above the fullscreened slide backdrop.

## Open

- Whether the image widget's markdown-copy button stays alongside the new pixel copy (the Cmd+C-copies-markdown pin at `imageCopy.test.ts:68` should stay either way).
- Whether excalidraw inline embeds gain the missing Copy SVG at the same time (one line at the same call site).
- Whether the zoom overlays themselves (`imageZoom`, `diagramZoom` at `state/diagramZoom.ts:177-179`) also carry copy buttons, so View-then-copy works without leaving the viewer.
- Hover chrome discipline in play mode: buttons must not distract a presented slide (appear on hover only, or on a modifier).
- The image and diagram action pills are two parallel hand-rolled implementations (`widgets/diagram.ts:323-324` vs `widgets/image.ts:653-654`, styles `Wysiwyg.svelte:1521-1555, 1801-1846`); folding them into one builder while touching both is optional cleanup, not scope.
