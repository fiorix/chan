# An image pasted by chord into the editor on the Linux desktop lands nothing

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

Origin: proposed by the lead on 2026-11-11 from the basic-flows row's WebKit arm; not accepted. One reading on WebKitGTK 2.52.6 in the desktop guest, with a caveat on the clipboard owner used.

## What is there now

On chan-desktop on Linux (WebKitGTK), with a PNG on the X CLIPBOARD offered as `image/png` by an xclip owner, a trusted Ctrl+V into a note's editor hands the page a paste event with `types: []`, no items and no files (recorded by a capture-phase listener in `scripts/e2e/desktop-observations/basic-flows.mjs`, 2026-11-11). The editor's paste handler (`web/packages/workspace-app/src/editor/bubbles/image_drop.ts`) takes its native branch only when `types` includes `Files`, the shape WKWebView gives, so this shape takes no branch, CodeMirror's default paste takes the event, and nothing lands: no embed, no file, no status. The same desktop command (`read_clipboard_image`) reads the image through arboard when the page asks, as the injected-shape arm of the driver shows, so the recovery exists and is not reached.

Caveat: the owner offered one target, `image/png`. Screenshot tools and GTK apps offer several image targets; whether WebKitGTK then exposes a File item or the same empty shape is not read yet. The composer (Rich Prompt) and the terminal menu's Paste row are not read yet either.

## Desired contract

1. On the Linux desktop, an image on the clipboard pasted by chord into the editor and into the Rich Prompt lands as it does on macOS and in Chrome: the embed and the uploaded file, or for the Rich Prompt the image in the draft and its path on submit.
2. The recovery path keys on what the engine hands the page, not on one engine's shape: an empty paste event with no text on a desktop asks the desktop for the clipboard image.

## Boundaries

- The editor's and the Rich Prompt's paste handling and the desktop bridge; no change to the desktop command.

## Acceptance

1. The basic-flows driver's trusted-paste arm (a GTK image owner offering several targets, then xclip's single target) red on the code before the fix and green after, on the editor and the composer; the owner's Mac check unchanged in batch 1.
2. The mounted tests of the handler cover the empty shape beside the WKWebView shape.
