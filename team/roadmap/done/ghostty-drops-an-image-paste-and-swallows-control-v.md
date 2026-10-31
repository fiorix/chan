# ghostty drops an image paste and swallows Ctrl+V

Status: shipped in [v0.117.0](../../release/release-v0.117.0.md); the section Built, 2026-10-30 holds the evidence (the module's tests, the mounted cases and browser check 94's paste leg). Not read: the owner's Cmd+V and Ctrl+V on macOS with an image on the clipboard.

Record before the release: raised by the owner on 2026-10-30 against the built ghostty default on this machine's chan-desktop, reproduced by the owner by switching the backend and reloading; accepted for v0.117.0; built on `v0117/terminal-opacity` the same day (the section Built); the owner's reading on macOS is pending.

## What was asked

The owner, with ghostty the default: "in ghostty, i cannot cmd+v to paste an image, on my local chan-desktop, like i can do with xterm; control+v does not work either; perhaps we didn't wire this to ghostty or it behaves differently? we should fix, especially now making ghostty the default terminal - and this is exactly the kind of bug i wanted to find and close the gap between ghostty and xterm". Reproduced by switching `terminal.ghostty`, reloading the terminal and pressing Cmd+V: the image is pasted on xterm.js and nothing happens on ghostty.

## Evidence

Read at `c08b8b24e`, ghostty-web `0.4.0-next.20.g1858a59`, xterm.js as pinned.

- A program takes an image from the clipboard itself; the terminal's part is the cue. On Cmd+V (macOS, chan's paste chord) the browser fires the native `paste` event on the renderer's textarea; an image-only clipboard carries no `text/plain`. xterm.js's `handlePasteEvent` pastes whatever text it finds with no empty check (`paste(text)` in its `Clipboard` module), so under bracketed paste the program receives `ESC[200~ ESC[201~`, the empty paste it treats as "read the clipboard". ghostty-web's `handlePaste` returns on empty text with "No text in clipboard" and sends nothing.
- A bare Ctrl+V is terminal input on every OS in chan: the paste chord is Cmd+V on macOS and Ctrl+Shift+V elsewhere (`terminal/clipboardChord.ts`), and xterm.js encodes Ctrl+V as the byte 0x16, the other cue an agent CLI accepts. ghostty-web's `handleKeyDown` returns early on `(ctrlKey || metaKey) && code === "KeyV"` before its encoder runs, so the byte never leaves the page; on Linux and Windows the browser's default then pastes text instead.
- ghostty-web consults chan's custom key handler before that early return, and chan's terminal tab already listens for `paste` in the capture phase (`onpastecapture`), ahead of ghostty-web's bubble listeners on its container and textarea. ghostty-web's `Terminal.paste(text)` sends the bracketed pair around any text, the empty string included, when the program has bracketed paste on.

## Desired contract

- Under ghostty, a native paste whose clipboard carries no text reaches the program exactly as under xterm.js: the empty bracketed paste when the program asked for bracketed paste, nothing otherwise. A paste that carries text stays ghostty-web's. A paste aimed at the Rich Prompt composer inside the tab is the composer's, images included.
- Under ghostty, a bare Ctrl+V sends 0x16 to the PTY on every OS and the browser's paste default is prevented, as under xterm.js. Cmd+V on macOS and Ctrl+Shift+V elsewhere stay the paste chords; Ctrl+Alt+V and the other chords flow on.

## Boundaries

`web/packages/workspace-app/src/terminal/ghosttyPaste.ts` (new) and its test, `TerminalTab.svelte` (the ghostty branch of the custom key handler and the tab's capture-phase paste listener), the mounted ghostty backend test, browser check 94 (a paste leg), `web/packages/workspace-app/src/design.md`. Not changed: ghostty-web, the paste chords, xterm.js's path.

## Acceptance

1. Unit: a bare Ctrl+V sends 0x16 and prevents the default while the paste chords, Ctrl+Alt+V and a keyup flow on; an empty paste calls ghostty-web's `paste("")` under bracketed paste and nothing without, stops the event either way, and a paste with text is left alone; mounted on the ghostty stand-in, the key handler claims Ctrl+V with the byte on the socket, a paste on the renderer host with no text is answered and one on the tab outside the host is not. Each fails against the previous component.
2. Browser check 94, ghostty end to end in Chrome: with bracketed paste set and `cat -v` on the PTY, a paste event with an empty DataTransfer echoes `^[[200~^[[201~` and a real Ctrl+V keydown echoes `^V`.
3. The owner, on macOS with ghostty: Cmd+V and Ctrl+V with an image on the clipboard paste it into the program as they do on xterm.js.

## Built, 2026-10-30

`web/packages/workspace-app/src/terminal/ghosttyPaste.ts`: `handleGhosttyControlV` sends 0x16 for a bare Ctrl+V on any OS, prevents the default and answers false in the custom handler's contract (as `handleGhosttyShiftEnter` does), so ghostty-web skips the key; `handleGhosttyEmptyPaste` answers a paste event whose `text/plain` is empty by preventing and stopping it and calling ghostty-web's `paste("")` when `hasBracketedPaste()` holds, which sends `ESC[200~ ESC[201~`. `TerminalTab.svelte` runs the first in the ghostty branch of `handleTerminalKeyEvent` before Shift+Enter, and the second from the tab's capture-phase paste listener (`onTerminalPasteCapture`, which also keeps the PTY size reclaim) only when the event's target is inside the renderer host, so the composer's pastes are untouched. The design doc's backend section says so, and its first sentence now names ghostty as the default.

Checks, 2026-10-30, Linux: the module's unit tests (Ctrl+V claimed with the byte; Cmd+V, Ctrl+Shift+V, Ctrl+Alt+V, Ctrl+C and a keyup untouched; an empty paste pasted as "" under bracketed paste and sent nothing without, stopped either way; a paste with text and an event with no clipboard data left alone) and three mounted cases on the ghostty stand-in (the key handler claims Ctrl+V and the socket carries `\x16`; a paste with no text on the renderer host is answered, with `paste("")` under bracketed paste; a paste on the tab outside the host is not), 66 tests green across the four terminal test files, the three mounted cases red against the previous component ("expected false to be true" on the claim and the prevented default); svelte-check 0 errors over 5751 files. Browser check 94 gained a paste leg (bracketed paste set by the shell, `cat -v` with the tty's literal-next undefined, a paste event with an empty DataTransfer on ghostty's textarea and a real Ctrl+V keydown): green against the built debug binary in Chrome, the PTY echoing `^[[200~^[[201~` and `^V`, and red against the previous component at the empty paste ("scrollback never showed ^[[200~^[[201~"). `make web-check` green on the final tree (workspace app 611 files and 7927 tests, launcher 696, shared 234, profile 20, both production builds). Not read: the owner's Cmd+V and Ctrl+V on macOS with an image on the clipboard.
