# A ghostty terminal opening in a background pane takes the keyboard for a moment

Status: accepted for v0.130.0 by the owner on 2026-11-13 ("get its own row"); built on 2026-11-14 on the branch `v0130/ghostty-open-without-focus`, merged into the integration branch (`ff45ca8ee`), not yet in a release; the section "Built" holds the evidence.

Record: found by the review of the [pane-focus keyboard](moving-pane-focus-to-a-file-browser-leaves-the-keyboard-in-the-terminal.md) build on 2026-11-13, by reading; not observed in a running window.

## What is there now

ghostty-web's `open()` (`web/packages/ghostty-web-ng/lib/terminal.ts`) ends by calling `this.focus()`, which focuses the element the terminal opened in at once, and again on a zero-delay timer. `TerminalTab.svelte` opens every ghostty terminal that way. When the terminal's pane is not the focused one, it blurs the terminal right after `open()` and hands the keyboard back to the element that held it before; since the pane-focus build, `blur()` also cancels the timer, so the keyboard ends where it was.

The element that held the keyboard still sees a blur and a focus in between, and some of chan's fields end their edit on blur: a CSV cell being edited (`onblur={commitEdit}`, `editor/CsvTable.svelte`), a tab being renamed (`onblur={commitTabName}`, `components/FileEditorTab.svelte`) and a chord being captured (`onblur` ends the capture, `components/CommandChordAssign.svelte`). By reading, a terminal that opens in a background pane while one of those holds the keyboard ends the edit, and the keyboard comes back to a field whose edit is over or which is gone. A terminal opens in a background pane when `cs terminal new` or Team Work spawns one into a pane that is not the focused one, and at a session restore.

xterm.js's `open()` does not focus; the xterm.js backend waits for its `focused` check, so it has no such moment.

## Desired contract

1. A terminal that opens in a pane that is not the focused one moves no focus: the element holding the keyboard sees no blur.
2. A terminal that opens in the focused pane takes the keyboard as it does now.

## Boundaries

- ghostty-web-ng's `open()` (an open that does not focus, with the caller focusing when its pane is focused) and `TerminalTab`'s call of it. The fork's part 4 ([chan drives ghostty-web from outside](../v0.131.0/chan-drives-ghostty-web-from-outside-through-its-private-internals.md)) adds a public focus hook; this row does not wait for it, and part 4 keeps what this row settles.
- The xterm.js backend is unchanged.

## Acceptance

1. A workspace app test, red on today's code: a field whose `blur` is recorded holds the keyboard while a ghostty terminal opens in a background pane; the field records no blur and keeps the keyboard. A terminal opened in the focused pane still takes the keyboard.
2. In a guest's browser: a CSV cell being edited keeps its edit open while `cs terminal new` opens a ghostty terminal in another pane.

## Built

On the branch `v0130/ghostty-open-without-focus` over `v0130/int` (`df2c44f9f`): `5224882a6` fix(terminal), `f8f444879` test(e2e), and this row's commit.

What changed. ghostty-web's `open()` (`web/packages/ghostty-web-ng/lib/terminal.ts`) no longer ends with `focus()`; it makes its element focusable and takes no focus, as xterm.js's `open()` does. `TerminalTab.svelte` already focuses a terminal in the focused pane at the end of `start()` (`if (focused) queueMicrotask(focusTerminal)`), so that case keeps the keyboard, now through `focusTerminal` and its survey and launcher guard on both backends. The blur and hand-back after a ghostty `open()` in a background pane (`keyboardBeforeOpen`) are removed: once `open()` takes no focus nothing inside the host holds focus after it, `blur()` leaves focus outside the terminal where it is, and the hand-back focused the element that already held the keyboard, so the block did nothing. The widget's README lists `open()`'s and `blur()`'s focus behaviour among its changes from upstream.

The reading, corrected. `cs terminal new` does not open a terminal in a background pane: `openTerminalInPane` (`state/tabs.svelte.ts`) makes the pane it opens in the focused one, so with `--pane` naming another pane the focus moves there and the new terminal takes the keyboard on both backends (read in the guest with the fix, whose change does not reach that code: a CSV cell being edited in the focused pane closes its edit, and the keyboard goes to the terminal on xterm.js as on ghostty). A terminal opens in a background pane when a window comes back from its session (a reload, a window opened again by its id) with a terminal in a pane that is not the focused one, which acceptance 2 reads; and, by reading, in a tab that is not its pane's active one at the same restore, for the members of a team surfaced at once other than the one left in the focused pane's active tab, and when its pane stops being the focused one while its core still loads.

Tests, red then green. `src/terminal/ghosttyWidget.blur.test.ts` opens the real widget on the vendored core: `open()` with a field holding the keyboard, which records no blur or focus and keeps it a task later while a key there reaches no program, and with nothing focused leaves the body; both red on the base widget (the field sees a blur, the host takes the keyboard), green after `5224882a6`; a third arm, the host focusable and `focus()` taking the keyboard, is a guard green on both. `src/components/TerminalTab.ghosttyOpen.test.ts` mounts `TerminalTab` on the real widget over the vendored core: in a background pane a field holding the keyboard records no blur or focus and keeps it, and a CSV cell's edit (the real `CsvTable`) stays open with its draft and the keyboard; both red at the base (the field sees a blur and a focus; the edit closes), green with the fix. A terminal opening in the focused pane takes the keyboard, green on both. The ghostty stand-in in `TerminalTab.ghosttyBackend.test.ts` models the new `open()` (focusable, no focus), and the pane-focus build's two background-open tests there keep their assertions; `Pane.browserFocus.test.ts`, `ghosttyWidget.blur.test.ts`'s blur arms and the 106 terminal and pane test files (1627 tests) are green. Mutations: putting `this.focus()` back at the end of `open()` turns the four new arms red; dropping `TerminalTab`'s focus of a terminal in the focused pane at the end of `start()` turns both focused-pane tests red, which is what now gives that terminal the keyboard.

In a browser. Check 227, in an sdme guest's Chrome against the guest's own server, lays a window out with a CSV file in its focused pane and a ghostty terminal in the other, waits until the session saves it so, and opens it again by its id in a new page, holding the page's fetch of the terminal core while one of the CSV's cells is edited, then letting it go: the terminal opens in the background pane while the edit holds the keyboard. With the base's widget and `TerminalTab` built into the guest's bundle it fails five assertions: 33 ms after the release the edit sees a blur as the terminal's host takes focus, the hand-back focuses it again, and it blurs a second time at 48 ms as its commit closes it; the half-typed draft is written to the file (26 bytes to 31) and the keyboard ends on the body. With the fix it passes, the edit open with its draft, no blur and no focus change in the page, and the next key typed into it; a terminal that `cs terminal new` opens in the focused pane then takes the keyboard. Alone it passed five runs of five, 4.5 to 4.8 s each, and checks 94, 223 and 226 are green beside it with the fix, 226's restore arm included without the hand-back.

Not observed: chan-desktop (WebKitGTK, WKWebView, WebView2) and Firefox. The other background paths above are by reading and were not run in a browser. A session restores no edit in progress, so check 227 holds the core's fetch to let an edit begin before the restored terminal opens; without the hold the terminal opens before anything can be edited.
