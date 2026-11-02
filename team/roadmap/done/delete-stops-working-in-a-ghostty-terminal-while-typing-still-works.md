# Delete stops working in a ghostty terminal while typing still works

Status: shipped in [v0.121.0](../../release/release-v0.121.0.md).

Record before the release: raised by the owner on 2026-11-02 from chan-desktop 0.120.1 on macOS 27.0.1; accepted for v0.121.0 by the owner the same day ("lets fix these items"). The trigger is not known; the owner suspects the window's Computers launcher toggle.

## What is there now

After a while in a terminal, the Delete key stops deleting while typed characters still reach the shell, until the window is reloaded. Read in the code, not reproduced: chan's ghostty key handler (`terminal/ghosttyKeys.ts`) hands a keydown flagged `isComposing` or `keyCode 229` to ghostty-web, which ignores the keydown on the same flags and maps the `deleteContentBackward` input that follows to nothing, while it types `insertText`. So a Backspace that the WebView flags as taken by its text input context sends no byte, and letters still type.

## Desired contract

1. Delete, Forward Delete and the word deletes reach the program in a ghostty terminal whatever the WebView's composition flags say, outside a real composition, and once each.
2. A real composition's own deletes (marked text) stay with the composition.

## Acceptance

1. A reading with the probe that shows the shape, or the bounded attempts that did not, recorded.
2. Tests red first for contract 1 and 2 over the key handler.
3. The owner's reading on the fixed build after the trigger that broke it.

## Closing

The reading was made in the code on Linux, not on macOS, and it corrects the premise above. ghostty-web 0.4.0-next.20.g1858a59 does map `deleteContentBackward` to a byte: its source holds a literal DEL inside the quotes (`E = "\177"` in `od -c`), which prints as nothing in a terminal, and `deleteContentForward` maps to `ESC [3~`. A delete input aimed at ghostty-web's hidden textarea therefore already reached the program. Two paths did not. First, any delete input aimed at the renderer host: ghostty-web makes the host `contenteditable` with the role `textbox`, and its `focus()` focuses the host (only a mousedown on the canvas focuses the textarea), but it listens for `beforeinput` on the textarea alone, and chan's host listener took only `insertText`. With the focus on the host, as after any programmatic focus of the terminal, a Backspace that WebKit flags `keyCode` 229 is left alone by chan's keydown and by ghostty-web's, and its `deleteContentBackward` reached nobody, while a letter's `insertText` on the host still typed through chan's listener. That is the reported shape. Second, the word deletes on either target, which ghostty-web maps to nothing.

Changed: `ghosttyDeleteInputBytes` in `terminal/ghosttyKeys.ts` maps `deleteContentBackward`, `deleteContentForward`, `deleteWordBackward` and `deleteWordForward` to what chan's xterm.js path sends for their keys (DEL, `ESC [3~`, and the word chords: Option+Backspace `ESC DEL` and Option+Delete `ESC d` on macOS, Ctrl+Backspace `BS` and Ctrl+Delete `ESC [3;5~` elsewhere). The host's capture-phase `beforeinput` listener sends them for input aimed at the host or at ghostty-web's textarea, outside a composition (chan's own `compositionstart` flag or the event's `isComposing`), not again when the keydown already sent the same bytes (the existing duplicate guard, cleared by keyup, focus loss and the next keydown), and stops the event before ghostty-web's textarea listener so each delete is sent once. Input already cancelled, or aimed at any other element, is left alone. The terminal paragraph of `web/packages/workspace-app/src/design.md` says so.

Verified with vitest in jsdom, chan's listener in front of ghostty-web's real `InputHandler` on the vendored wasm (`npx vitest run src/terminal/ghosttyKeys.test.ts` in `web/packages/workspace-app`): 16 new tests in "delete input on the ghostty host", 91 in the file. Against the base handler 8 of the 16 were red with assertion failures read: the 229 Backspace aimed at the host on Linux and macOS (no DEL sent), the four word deletes (nothing sent), and the Backspace and Delete whose keydown sent the bytes (sent twice when a delete input followed on the textarea). The other 8 guard behavior that already held and must stay: the textarea path, the plain deletes' parity, a composition's deletes (`deleteContentBackward` with and without `isComposing`, and `deleteCompositionText`, left unsent and uncancelled), and input already cancelled or aimed at an input field inside the host. One mutation per guard, each caught by its test: dropping the host from the aimed targets, the duplicate guard, the composition check, the platform split of the word mapping, and the target check. `make web-check` at this commit: see the hand-back.

Open: the probe reading (acceptance 1) was not taken, because it needs a macOS window. That a failing Backspace is flagged `keyCode` 229 with the focus on the host is inferred from the code and the symptom, not observed, and what makes WebKit flag it so "after a while" is not established. Neither installed 0.120.1 nor a build with this change was run, and the launcher toggle trigger is untested. The owner's reading on a build with this change after the trigger that broke it (acceptance 3) is pending: with the draft's probe installed, a Backspace that sends nothing on 0.120.1 should show `keydown Backspace` with `keyCode: 229` and an unprevented `beforeinput deleteContentBackward` aimed at `div.terminal-host`, and on the fixed build the same `beforeinput` shows `prevented: true`.
