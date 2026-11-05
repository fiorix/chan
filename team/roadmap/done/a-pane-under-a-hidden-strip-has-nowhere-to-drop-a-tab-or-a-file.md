# A pane under a hidden strip has nowhere to drop a tab or a file

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: asked by the owner on 2026-11-04 while the auto-hidden strip ([a-panes-tab-strip-shows-over-a-lone-tab-with-nothing-to-switch-to](a-panes-tab-strip-shows-over-a-lone-tab-with-nothing-to-switch-to.md)) was integrated, since the hidden strip took the pane's drop target with it. The owner's rule: a pane's centre is always a drop area. Built by a Claude subagent of the round's lead on `feat/pane-centre-drop` off the strip branch's `be917f444`. The first build caught every file-tree drop over the body, so a file dropped on an editor or the Rich Prompt opened instead of typing its path; on 2026-11-05 the owner chose that text surfaces keep the insert. Merged into `feat/pane-context-commands` (`b09c552dc`) and with it into `v0124/int` as `b2665def0`.

## What was there

A pane's body took only a tab of this window, and always split the pane at the nearest edge. A tab from another window and a file dragged from the Files tree dropped only on the strip. With `pane_strip_auto_hide` on, a lone or empty pane has no strip, so they had nowhere to go, and a drop on an empty pane split it instead of filling it.

A Files row also allowed only a move (`effectAllowed = "move"`, unchanged since at least 2026-06-25). A browser refuses a drop whose effect the source does not allow, and both drops a Files row is made for are copies: a pane opening the file sets `dropEffect` "copy", and an editor typing the path is the browser's default edit drop. In Chrome a Files row dropped on a pane opened nothing, and one dropped on an editor typed nothing.

## Desired contract

1. A pane's body has a band along each edge and a centre inside them. Each band is a quarter of the body's extent across it, at most 120 px, so the edges stay easy on a small pane and the centre keeps most of a large one.
2. The centre takes a drop as a drop past the strip's last tab does, for the visible side, strip drawn or hidden, preference on or off: a tab of this window moves in, a tab from another window of the same scope is rebuilt there, and a Files file opens there.
3. Only a tab of this window meets the bands, where it splits the pane as before. For another window's tab, a Files file and an empty side the whole body is the centre, so an empty side is filled, never split. A pane's own tab over its own centre stays put; a tab from another kind of window or workspace keeps the no-drop cursor, as on the strip.
4. Over a CodeMirror editor, a document's or the Rich Prompt's composer, a Files drag is the editor's: the body sets no zone and paints nothing, and the editor types the path. A tab over an editor keeps the centre and the bands.
5. The body takes these drags only where nothing inside it took the drag first, and handles the drop before the surface under it; any other drag, an OS file among them, passes through to the terminal or editor that takes it, and a tmux pane takes no body drop.
6. A Files row allows copy and move: a folder takes it as a move, a pane opens the file, an editor types its path.
7. The centre wears the strip's inset ring in the window's focus colour over the whole body with a light wash, distinct from the edge overlays, and clears on dragleave, on drop and on any dragend.

## Boundaries

`Pane.svelte` (the strip's two drop handlers folded onto one rule, `dropIntoPane`, the zones, the drop in the capture phase), `state/paneDropZone.ts`, `FileTree.svelte`'s drag start, the Settings hint in `GlobalSection.svelte`, the configuration reference row and the preference's doc comment in chan-server, the workspace app's design, browser checks 205 and 176. Not changed: the strip's own drop rules, the tab model, the drag of an OS file.

## Acceptance

1. `paneDropZone.test.ts` tables the bands and corners at several sizes; `Pane.centreDrop.test.ts` drives the app over the demo transport with the preference off and on for each drop kind, the empty pane, the size-dependent band, the own tab at the centre and at an edge, the highlight's clearing, a tmux pane, an OS file over a docked terminal reaching the terminal unclaimed, a Files file over a document and the Rich Prompt typed by the editor and over a terminal's screen and an empty pane opened, and a tab over an editor dropped in the centre; each rule replayed red under a mutation. `dragFocusColour.test.ts` pins the centre's ring to the focus colour; the Files transfer test expects `copyMove`.
2. Browser check 205 with the browser's own drags, events trusted and payload protected: the centre with the preference off and on, an empty pane filled from 20 px inside its edge, the same point on a full pane splitting it, and a Files row over an editor (the path typed, no tab opened) and over an empty pane (the file opened). Red against the previous `Pane.svelte`, against a move-only row and without the editor rule. Check 176 reads the centre ring in the focus colour for no colour chosen and each preset, in both schemes.

## Built

Seven commits: `bf913da01` (one drop rule for a tab and the strip's background, no behaviour change), `3fe245f16` (the centre and the bands), `dbcc97520` (the configuration reference, the preference's comment and the design), `3b6a066d9` (check 205 and check 176's centre ring), `061258772` (a Files drop over an editor is the editor's), `399bf0c6d` (a Files row allows copy and move), `84a21c38d` (check 205's two Files-row arms).

Verification recorded in the commits: svelte-check and vitest on the suites above; check 205 alone and with 176 and 200 to 202 in one run in an isolated sdme guest at four CPUs, green with all six arms, and red as acceptance 2 says. At `b2665def0`, `make web-check` green with the workspace app's 8,554 tests; check 205 passed in the whole browser suite at `b2665def0` and in the guest packs that followed.

Open: chan-desktop's WebKit on macOS and Linux and WebView2 on Windows were not read before the GA commit; whether WebKit refused the move-only Files row as Chrome did was not read. Under Chrome's drag interception no dragend reaches the source, so the check does not exercise the source's dragend.
