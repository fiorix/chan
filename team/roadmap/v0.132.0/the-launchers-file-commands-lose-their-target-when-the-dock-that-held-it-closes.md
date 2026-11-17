# The launcher's file commands lose their target when the dock that held it closes

Status: accepted for v0.132.0 by the owner on 2026-11-17, by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"); not started.

Record: item 7 of `dev/v0131-team/reports/owner-candidates-1.md`, from the independent review of the launcher-target work (`dev/v0131-team/reviews/review-fbtarget-1.md`, note 3), which called it in-contract and worth the owner's eye. [The launcher-target row](../done/the-launchers-file-commands-act-on-the-file-browser-focused-last-not-the-tab-just-made-active.md) asked for no fallback to another surface, and its mounted suite pins today's behaviour. This row is a contract change, not a defect against that row. Nothing is lost: the commands say what to do.

## What is there now

Read at `b73773a93`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- The launcher's file commands act on one surface, the instance `browserFocus.instanceId` names (`state/store.svelte.ts:5523-5530`; `commandSurfaceId()` at `state/commands/browser.ts:193-195`). They are offered only while the focused pane's active tab is a file browser (`onBrowser`, `browser.ts:78-80`). A dock becomes the surface on a focus or a press inside it (`components/FileBrowserSurface.svelte:366`, `onfocusin={activate} onpointerdown={activate}`; `activate` at `:119`).
- A dock's surface unmounts when its side is turned off (`App.svelte:1907-1915`), from the chord (`App.svelte:1159-1165`), the launcher's dock toggles or the surface's own menu row (`FileBrowserSurface.svelte:406`), all through `setBrowserSidePane` (`store.svelte.ts:5745-5753`). The surface's teardown disposes its instance (`FileBrowserSurface.svelte:170`, `fbWatchDispose`, `state/fbWatch.svelte.ts:101-110`), and `disposeFbTreeInstance` clears the record when it named that instance (`store.svelte.ts:5862-5866`). The target is then null.
- Nothing hands the target to the focused pane's active file browser tab. That tab's surface takes the keyboard, and with it the target through `onfocusin`, only when `focused`, `tab` or the focus pulse changes (`FileBrowserSurface.svelte:180-186`); a press on the pane activates it (`components/Pane.svelte:1515-1522`); a pane move does too. A dock's close changes none of these. So with a Files tab active in the focused pane and visibly holding a selection, the launcher offers Open, Download, Rename or move, Copy path and the other selection commands as unavailable with "Needs a selection", Upload and Paste with "Focus a file browser" (`browser.ts:259-261`, `:349-350`, `:446-447`), and New file or directory falls back to the default create directory (`:282-283`).
- Where the keyboard goes when a focused dock unmounts: the document's active element becomes the body, and no handler in `App.svelte` or `components/FileBrowserSidePane.svelte` refocuses the pane (by grep for `focusout` and body checks); not established beyond that.
- The mounted case "disposing the targeted dock does not fall back to the still-visible tab" (`components/Pane.browserCommands.test.ts:299-333`) pins today's behaviour: after `browserSidePanes.left = false`, `commandSurfaceId()` is null and Upload and Paste answer "Focus a file browser". The manual (`web/packages/marketing/src/pages/manual/files.html:39`) and `design.md:229` name the paths that make a tab the target and say nothing of a closing dock.

## Desired contract

1. When the file browser dock the launcher's file commands act on closes, and the focused pane's active tab is a file browser, that tab becomes the surface the commands act on before the next press, with its own selection: the launcher offers the selection commands for the tab's selection, and Upload and Paste for the tab's folder.
2. The keyboard follows: the focused pane's active tab takes it as it does on a focus pulse, its tree for a file browser, the terminal or the editor otherwise.
3. With no file browser active in the focused pane, the target is empty and New file or directory uses the default create directory, as today. A dock that closes while another surface is the target changes nothing.
4. A Paste in flight from the dock still lands where it was aimed and selects there, as today.

## Boundaries

- The dispose path and the target record in `state/store.svelte.ts`, where the side pane unmounts (`App.svelte` or the dock's surface), and the pane's focus, with their tests. The pinned case at `Pane.browserCommands.test.ts:299` is rewritten to this contract.
- The launcher-target row's rule stays: no command reads another surface's selection when the one it acts on has none. The target moves; the selection read is the tab's own.
- Not here: a tab closing while it is the target, which already leaves the focused pane's next active tab to the existing paths.

## Acceptance

1. Mounted tests over a pane with a Files tab and a dock (the `Pane.browserCommands` fixture), red at the base: press in the dock, copy there, close the dock; `commandSurfaceId()` names the tab, Copy path and Download act on the tab's selection, Paste is offered and lands in the tab's folder. The same with a terminal active in the focused pane: the target is null, as today. One case per closing path (the chord, the launcher's toggle, the dock's menu row).
2. The keyboard, as a mounted test, red at the base: after the close, the active element is inside the tab's tree, or the terminal's input for a terminal tab, not the body.
3. Removing the hand-over at dispose turns acceptance 1 red; removing the refocus turns acceptance 2 red; restoring each turns it green.
4. A browser check in a guest's Chrome and in chan-desktop on WebKitGTK: a Files tab with a file selected and a left dock; a click on a dock row; the dock closed by its chord; the launcher's Copy path copies the tab's selection.
5. `files.html:39` and `design.md:229` say what a closing dock does with the target and the keyboard.

## Accepted, 2026-11-17

The owner accepted this row by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"). The choice the draft left to him is taken as the draft recommended: option (a), the keyboard returns to the focused pane's active tab when the targeted dock closes, and a Files tab there becomes the target through the existing focus path. He may revisit it before the build. The options as drafted:

- (a) The keyboard returns to the focused pane's active tab when the targeted dock closes, and a Files tab there becomes the target through the existing focus path (recommended: keeps the "keyboard holder is the target" rule of the pane-focus and launcher-target rows, and fixes focus landing on the body).
- (b) Narrower: the dispose hands the target to the focused pane's active Files tab in the store, the keyboard untouched. Drops contract 2 and acceptance 2.
- (c) Keep the shipped contract (no fallback) and record the visible edge in the manual.
