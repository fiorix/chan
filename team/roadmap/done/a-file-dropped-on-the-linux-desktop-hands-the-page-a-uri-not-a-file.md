# A file dropped on the Linux desktop hands the page a URI, not a file

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Landed on 2026-11-11.

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

## Built, 2026-11-11

Built on 2026-11-11 on `v0128/linux-clipboard` (`165d13def`, `ae9ebb655`, `c3be6a18b`), merged as 3b0e6e2eb. WebKitGTK lists `text/uri-list` for such a drop but answers `getData` with nothing (it hides file paths from a page), so the page cannot name the file. The desktop observes each window webview's own GTK drag signals without stopping them (wry's native handler stays off) and records the latest drop from another application; `dropped_files` lists that drop's base names and `read_dropped_file` answers one file's bytes by its place, once, within 30 seconds, a regular file within the 50 MiB upload cap. A page reads only what the user dropped on it, and no path reaches the page; both commands are granted with the native transfers. The editor's drop handler, which the Rich Prompt shares, takes a desktop file drop (`isDesktopFileDrop`: `text/uri-list`, no Files, not a page drag, the list hidden or naming `file:` URIs), reads its images and uploads them as a Files drop, at the drop point. The window guard treats a `text/uri-list` drag the document did not start as a file drag on the desktop, so a drop outside every zone leaves the window on its page. Evidence: unit tests of the drop record and the read's checks, the ACL parity tests, mounted tests of the guard and the handler; the basic-flows WebKit arm's `xdnd` group faulted three times at the base (the URI as text twice, the window taken by the outside drop) and held in five consecutive runs of all nine groups at the tip; without the handler's desktop drop both drops fault, with the guard keyed on Files the outside drop takes the window again, and with the desktop's record unwritten both drops fault. macOS (WKWebView hands Files) and Chrome's checks are unchanged.

The round's first CI run on the merged tip was red on macOS and Windows: the drag state, its four drag methods and the file URI decoder compiled on every target while only the GTK handlers reach them, so clippy with warnings denied reported them dead on macOS, and the URI test expected a Unix path that `Url::to_file_path` refuses on Windows. They now compile on Linux and FreeBSD alone, with their tests, and the per-window test seeds its drop directly so it runs everywhere (7fb3d8f23, merged eecb0c969); on the Linux tree `make check-windows-test-target` passed before and after because it lints the test build, where the tests keep the pieces alive, while a Windows GNU clippy with `--all-targets` reds at the old tree with the macOS job's three errors and is green at the fix (`dev/v0128-team/evidence/Lead128/linuxdrop-ci/`). CI run 43012972978 on eecb0c969 green on every job, macOS, Linux and Windows included.
