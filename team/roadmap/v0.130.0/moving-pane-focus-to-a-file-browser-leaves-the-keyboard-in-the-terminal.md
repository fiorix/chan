# Moving pane focus to a file browser leaves the keyboard in the terminal

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: reported by the owner on 2026-11-13 from chan-desktop, with a terminal in the top pane and a file browser in the bottom one: "if i switch the pane focus from the termianl to the file browser, the arrow keys still go to the terminal.. pressing arrow up rolls the terminal history up by 1, arrow down, down by 1.. and the focus border show in the file browser". He expects the web build to show it as well. Not recorded: which way he moved the focus (the Next pane chord, Hybrid Nav or a press) and which backend the terminal ran (ghostty is the default).

## What is there now

Read at `8f427abce` (v0.129.0's content and one roadmap row); not yet reproduced in a running window. Two gaps meet in the report.

1. **A file browser tab does not take the keyboard when its pane takes focus.** A pane focus move sets the layout's `activePaneId`, and the focus border (`.pane.focused`, `web/packages/workspace-app/src/components/Pane.svelte`) follows it at once. The keyboard follows only into tabs that pull it: a terminal and an editor take a `focused` prop and focus themselves in an effect on it (`TerminalTab.svelte`, `FileEditorTab.svelte`), and the tab strip's presses raise `bumpTabFocusPulse` for those two kinds alone (`Pane.svelte`). `FileBrowserSurface` in a tab gets no `focused` prop; its tree takes the keyboard (`focusTree` and `selectPath`, `FileTree.svelte`) when it mounts with a saved view, after a navigation, when one of its own overlays closes and on a press on a row, never on a pane focus move. `selectNextPane` and `selectPrevPane` (`state/tabs.svelte.ts`) change `activePaneId` and nothing else. The browser reads its keys through handlers on its own elements (`onBrowserKeydown`, `onTreeKeydown`), so with the keyboard elsewhere it sees no arrow.
2. **A ghostty terminal that has been pressed keeps the keyboard after its blur.** A terminal that stops being the focused one runs `term?.blur()` to give up the keyboard (`TerminalTab.svelte`). On the ghostty backend `Terminal.blur()` blurs `this.element`, the host the terminal was opened into (`web/packages/ghostty-web-ng/lib/terminal.ts`), but a press on the terminal's canvas focuses the hidden `textarea` inside that host (`open()` in the same file). `blur()` acts only on the element that holds focus, so after any press into the terminal the textarea keeps it; its keydown bubbles to the input handler's listener on the host (`lib/input-handler.ts`) and goes to the PTY. Up and Down at a shell prompt then step the shell's history, which is how this item reads "rolls the terminal history". chan's `focusTerminal` focuses the host, so a terminal focused by keyboard alone and never pressed does give the keyboard up; it lands on the body, where gap 1 leaves it. On the xterm.js backend `blur()` blurs xterm's own textarea, so only gap 1 applies there.

A jsdom probe of gap 2, run 2026-11-13: a host with `tabindex` holding a textarea; with the textarea focused, the host's `blur()` leaves `document.activeElement` on the textarea; with the host focused, it moves to the body. Browser engines release focus on `blur()` only for the focused element as well; that was not run in an engine here.

By reading, gap 2 is not specific to a file browser: after a press into a ghostty terminal, moving focus to a pane whose tab pulls no keyboard (a graph, a dashboard, an extension, an empty pane) leaves the keys in the terminal too. A move to an editor or another terminal is unaffected, since those focus themselves. Both gaps are in the workspace app and the widget that chan-desktop and the browser share, so the web build has them too, by reading.

## Desired contract

1. A pane that becomes the focused one by any path (Next pane and Previous pane, Hybrid Nav's commit, a press on its strip or its body, a command that focuses it) takes the keyboard with the border. A file browser tab focuses its tree, keeping its selection and scroll.
2. A terminal that stops being the focused one gives up the keyboard from whichever of its elements holds it, on both backends. A move to a pane whose tab owns no keyboard leaves it on the body, never in the terminal that was left.
3. Nothing takes the keyboard without a focus move: a browser tab in a background pane or on a hidden side, and a session restore, leave it where it is, as the editors' `focused` gate does.

## Boundaries

- The workspace app's handoff of the keyboard to a file browser tab on a pane focus move (`Pane.svelte`, `FileBrowserSurface.svelte`, `FileTree.svelte`), on the terminal's and editor's `focused` and focus-pulse model; and `Terminal.blur()` in `@chan/ghostty-web-ng`. The blur fix is small and does not wait for the focus hook of the fork's part 4 ([chan drives ghostty-web from outside](../v0.131.0/chan-drives-ghostty-web-from-outside-through-its-private-internals.md)); part 4 keeps its behavior.
- Not here: the docked file browser beside an editor, which is not a pane; which surface the launcher's file commands act on (a boundary of [the New and Paste row](../v0.131.0/the-file-browsers-new-and-paste-rows-and-the-launchers-commands-choose-different-folders.md)).

## Acceptance

1. A widget test in a suite the gate runs: after a press on the canvas, `blur()` leaves neither the host nor the textarea focused; red on today's `blur()`. The upstream tests in `lib/` are not run (part 3 of the fork item).
2. Workspace app tests over a terminal above a file browser, the terminal holding the keyboard: after Next pane, Hybrid Nav's commit and a press on the browser's strip, `document.activeElement` is inside the browser, an ArrowDown moves its selection and no input reaches the terminal; red on today's code. The cases of contract 3 keep the keyboard where it was.
3. In a guest, on chan-desktop and in a browser against the guest's devserver: the owner's sequence, with a press into the terminal first, moves the browser's selection with the arrows and leaves the shell's prompt unchanged.
