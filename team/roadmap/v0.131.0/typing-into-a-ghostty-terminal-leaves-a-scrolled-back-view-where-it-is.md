# Typing into a ghostty terminal leaves a scrolled-back view where it is

Status: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 on 2026-11-14, when he took v0.130.0 to its release with the rows built by then; not started.

Record: reported by the owner on 2026-11-13 in his Mac report for v0.129.0's terminal renderer batch, as a note on the guide: "on ghostty, typing does not snap the view back to the cursor" (`dev/v0129/owner/reports/batch3-terminal-renderer-at-09d7a4f9e.md`). Recorded as a candidate in `dev/v0129/row-notes.md` ("Command deck: owed at the row record and the cut", the batch 3 bullet): "on the ghostty backend typing does not bring a scrolled-back view to the cursor, where xterm.js does (the same in v0.128.0 by reading)". The owner, for v0.130.0: "what i really want on v0.130 is the systemd and flush-window-edges, plus ghostty/terminal bug fixes like the one my other agent is actively fixing right now".

## What is there now

Read at `342dbe791`, and the same at v0.128.0 (`8ded1bda9`); not run.

- xterm.js brings a scrolled-back view to the bottom on the user's input: its `scrollOnUserInput` option defaults to true, and `CoreService.triggerDataEvent`, for data it marks as the user's (typed keys, a paste, a composition), and `_keyDown`, for a key its composition helper takes, scroll to the bottom first (xterm.js 6.0.0, the version `web/package-lock.json` pins). chan does not set the option.
- A ghostty terminal has no such rule. ghostty-web's `writeInternal` scrolls to the bottom after every write (`web/packages/ghostty-web-ng/lib/terminal.ts`), and chan's `GhosttyViewportController.write` (`web/packages/workspace-app/src/terminal/ghosttyViewport.ts`), the path all output takes, puts a view one row or more back where it was, so output never yanks a reader out of history. None of the input paths scroll: ghostty-web's input handler callback (`open()` in `lib/terminal.ts`) clears the selection and fires `onData`, as `paste()` and `input(data, true)` do; the keys chan encodes itself on ghostty (`installGhosttyKeyParity`, `terminal/ghosttyKeys.ts`) and chan's paste (`pasteIntoGhostty`, `terminal/ghosttyPaste.ts`) go out through `sendUserInput` and `input(data, true)` (`components/TerminalTab.svelte`). The echo then arrives as output and the controller keeps the view where it was, so a typed key reaches the shell with the prompt out of sight.
- On ghostty `onData` also carries the core's replies to a program's queries (`processTerminalResponses`), so chan's `handleGhosttyData` cannot tell typed input from them; the rule belongs where the input is made.
- On xterm.js the keys chan sends ahead of xterm.js (Ctrl+/ and the Option-as-Meta and word-motion keys: `handleTerminalKeyEvent`, `handleTerminalMetaKey` in `terminal/keymap.ts`) return from the custom key handler before `_keyDown` reaches its scroll, so they leave the view in history there too, by reading.

## Desired contract

1. Input the user makes in a terminal (a key that sends bytes, typed text, a composition's commit, a paste) brings a scrolled-back view to the bottom, prompt and cursor in view, on both backends and whichever path sends it.
2. Output alone never moves a scrolled-back view, as now, and a reply the terminal makes to a program's query is not input for this rule.
3. A chord chan acts on itself that sends nothing to the program (copy, a shortcut) leaves the view where it is.

## Boundaries

- The ghostty widget's input callback, `paste()` and `input(data, true)` in `@chan/ghostty-web-ng` (`lib/terminal.ts`), and the terminal tab's key paths that send to the PTY directly (`ghosttyKeys.ts` through `sendUserInput`; `handleTerminalKeyEvent` on xterm.js).
- Not here: the viewport controller's rule for output, a view less than a row back following output among it; a terminal that receives the input from its broadcast group; mouse reports.

## Acceptance

1. App tests over a ghostty terminal scrolled back several rows, in a suite the gate runs (the widget's own tests in `lib/` are not run): a letter typed through ghostty-web's input, an arrow `ghosttyKeys.ts` sends, and a paste through `pasteIntoGhostty` each leave `getViewportY()` at 0; a copy chord and a write of output leave it where it was. The three inputs are red on today's code.
2. The same over an xterm.js terminal for Ctrl+/ and an Option-as-Meta key; red on today's code.
3. On chan-desktop (the owner's Mac, or a desktop guest on Linux), with a few hundred lines of history on each backend: scroll back and type a letter; the view jumps to the prompt with the letter at the cursor.
