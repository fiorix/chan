# A ghostty terminal opening in a background pane takes the keyboard for a moment

Status: accepted for v0.130.0 by the owner on 2026-11-13 ("get its own row"); not started.

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
