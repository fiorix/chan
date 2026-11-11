# A file dropped on the Linux desktop hands the page a URI, not a file

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

Origin: proposed by the lead on 2026-11-11 from the basic-flows row's WebKit arm (its XDND drop arms); not accepted. Read on WebKitGTK 2.52.6 in the desktop guest with a GTK drag source offering `text/uri-list`, five of five runs, and once with a file manager's target set.

## What is there now

chan-desktop keeps wry's native drag handler off for workspace windows so DOM drops reach the page (`desktop/src-tauri/src/serve.rs` near line 1150). On Linux a real XDND drop of a file hands WebKitGTK's page a drop event with `types ["text/uri-list", "text/html"]`, two string items and no `files`, whatever the drag source offers. Two consequences:

- The editor's and the Rich Prompt's drop handling (`web/packages/workspace-app/src/editor/bubbles/image_drop.ts`, lines 103 to 115) reads `dataTransfer.files`, finds none, and CodeMirror's default drop inserts the file's `file:///...` URI as text at the drop point; the composer does the same. A file dragged from a file manager into a note or the composer embeds nothing on the Linux desktop. On macOS the desktop types a dropped file's path into a terminal (`dropped_paths.rs`) and the webview hands files to the page; in Chrome a drop carries `Files`.
- The window guard (`state/fileDropGuard.ts`) stops a drop outside any drop zone from navigating the window, but only when `types` includes `Files`. A file dropped on the pane's tab strip therefore navigates the workspace window to `file:///.../<file>`: the window becomes a bare view of the file, and the workspace is gone until the window is reloaded (screenshot in the arm's evidence).

The same desktop reads the clipboard image for a paste through its own command when the page asks (`read_clipboard_image`); nothing equivalent exists for a dropped path.

## Desired contract

1. On the Linux desktop a file dropped into the editor or the Rich Prompt lands as it does on macOS and in Chrome: an image is uploaded and embedded (or placed in the draft), and the drop point is where it lands.
2. A drop outside any drop zone on the Linux desktop leaves the window where it is, whatever shape the engine hands the page.
3. The guard and the handlers key on what the engine gives (`Files`, or `text/uri-list` carrying `file:` URIs on a desktop), so one engine's shape does not decide the behaviour.

## Boundaries

- The page's drop handling and the window guard, and a desktop bridge read of a dropped path if the page cannot read the file from a `file:` URI itself (it cannot: the page has no file access). The native drag handler stays off for workspace windows.

## Acceptance

1. The basic-flows driver's `xdnd` group green: a GTK drag source's drop embeds the image in the editor and the composer, and a drop on the tab strip leaves the window on its page; red at the code before the fix (the arm's current readings).
2. Mounted tests of the handlers and the guard with a `text/uri-list` drop beside the `Files` drop.
3. The owner's Mac check unchanged; Chrome's check 215 unchanged.
