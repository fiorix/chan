# The Files tab overflows its pane and hides the tab strip

Status: shipped in [v0.117.1](../../release/release-v0.117.1.md); the section Built, 2026-10-31 holds the cause, the one-line fix and browser check 196, red on the v0.117.0 tree and green with the fix. Not read by eye in WKWebView or WebKitGTK before the cut; the owner reads it on macOS.

Record before the release: raised by the owner on 2026-10-31 after the v0.117.0 publication, from chan-desktop on macOS showing a devserver window of the Linux machine; accepted for v0.117.1 as a patch and built the same day on `0.117.0-ga` (the section Built); the owner's reading on macOS is pending.

## What was asked

The owner's words of 2026-10-31: "the file browser does not show the pane top, and the other tabs, when it is in focus!" and, with the screenshot, "the bottom status bar is very high, the height seems wrong.. at the top, the details window is under the top of the window".

## Evidence

- The owner's screenshot (macOS chan-desktop, the window `geekom / chan Window 2`, a devserver window reached through the gateway, so WKWebView): the Files tab fills the window with no pane tab strip above it, the Details inspector's header sits under the window's top edge with its close button half visible, and the surface's status bar (`39 items / 0 selected`, `Standard keys`) sits about 300 px above the window's bottom with an empty band below it. The pane also held a terminal tab, which the strip would have shown. The capture is kept with the cut's record (`bugs/files-tab-strip-hidden-macos.png` in the chan-dev mirror of the v0.117.0 cut).
- Measured in headless Chrome against the release tree in the Linux guest, in a workspace window holding a terminal tab and a Files tab: the pane's card face (`.pane-card-face`, `overflow: hidden`, 990 px tall) reports a `scrollHeight` of 1,124 px once the Files tab is open; the strip stays shown in Chrome, a `scrollIntoView({block: "nearest"})` of the folder list's last row scrolls the list's own scroller (`.tree-wrap`, `overflow: auto`, 837 px for 1,005 px of rows) and leaves the face at 0. The chain from the list to the face: `ul.tree.directory-list` (999 px, `overflow: visible`) in `div.tree-wrap` (837, `flex: 1 1 0%`) in `div.file-area` (869) in `div.body` (869) in `div.browser` (957) in `div.editor-wrap` (957); the strip is 33 px, so the surface and the strip fill the 990 px face in Chrome. WebKit scrolls an `overflow: hidden` ancestor when it focuses an element or scrolls a row into view where Chrome does not, and the owner's capture shows the face shifted up by more than the strip's height, with the surface itself ending short of the window's bottom, so the surface's own height came out smaller than the pane's content area there as well.
- The Files tab's directory view is new in v0.117.0 (`520ee28b5`); the pane and its strip are unchanged but for the tmux rule, which hides the strip only for a pane showing a tmux pane (`tmuxPaneHere` in `Pane.svelte`).

## Desired contract

The Files surface sizes itself to the pane's content area under the strip: no descendant adds scrollable overflow to the pane card (`scrollHeight` equals `clientHeight` on `.pane-card-face` with a Files tab active, whatever the folder's row count), the folder list scrolls inside its own scroller only, the Details inspector's header sits below the strip, and the surface's status bar sits at the bottom of the pane. Focusing the list, moving its cursor with the keyboard, and selecting the last row never move the strip. The same holds in WKWebView and WebKitGTK, where the owner reads it.

## Boundaries

`web/packages/workspace-app/src/components/FileBrowserSurface.svelte` and `FileTree.svelte` (the directory view's sizing: the `min-height: 0` and `flex` chain, the list's container, the inspector's placement, the status bar), with `Pane.svelte` read against them; no server change.

## Acceptance

1. In headless Chrome against a workspace window with a terminal tab and a Files tab over the seed workspace, `.pane-card-face` reports `scrollHeight == clientHeight` with the Files tab active, before and after focusing the list and pressing End; the strip's rect stays at the pane's top. A browser check pins this.
2. The owner reads the window on macOS chan-desktop (WKWebView) and on the Linux desktop (WebKitGTK): strip shown with both tabs, Details under the strip, the status bar at the pane's bottom, no empty band.

## Built, 2026-10-31

The cause, read in headless Chrome against the release tree by hiding one subtree at a time and toggling style properties while reading the pane card's `scrollHeight`: the folder list `ul.tree.directory-list` is `position: relative` (`FileTree.svelte`, the anchor of the rubber-band overlay), and its scroller `.tree-wrap` (`FileBrowserSurface.svelte`) was not positioned, so the engine attributed the list's whole box to the nearest positioned ancestor, the surface's `.body`, past the scroller: the card's `scrollHeight` read 1,124 px for 990 px with the list of the seed workspace open, and went back to 990 with the scroller made `position: relative` (as with `contain: paint` or `display: flex` on it, or `overflow: hidden` on `.body`), while `overflow: hidden` or `clip` on the scroller and `position: static` on the list changed nothing. The fix is the one line: `.tree-wrap { position: relative; ... }`, with the reason in a comment.

Verification: the browser check `196-files-tab-keeps-the-pane-strip` opens a terminal tab and a Files tab in one pane, requires the card's `scrollHeight` to equal its `clientHeight`, the card unscrolled and the strip at the card's top with both tabs listed, then clicks a row, walks the list with ArrowDown, End, ArrowUp, Home and End, reveals the last row with `scrollIntoView` and focuses it, and requires the same again; red against the release tree in the guest (`Files tab open: the pane card holds 1124px of scrollable content in 990px`) and green three times in a row with the fix (about 2.1 s each). The surface's vitest files (11 files, 88 tests) pass. Not read here: WKWebView and WebKitGTK by eye, where the card's overflow was what the engine scrolled; the owner's capture is the record of the symptom.
