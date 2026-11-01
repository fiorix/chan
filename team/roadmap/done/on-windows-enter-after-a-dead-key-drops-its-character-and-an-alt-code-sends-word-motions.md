# On Windows, Enter after a dead key drops its character and an Alt code sends word motions

Status: shipped in [v0.120.1](../../release/release-v0.120.1.md).

Record before the release: found by the owner's Windows guest readings on 2026-11-01, accepted for v0.120.1 by the owner's word the same day ("if there are fixes, i want to land them too"), built; the patch cut closes it.

## What was asked

The v0.120.0 ghostty row left its Windows readings for findings 5, 6, 7 and 9 open. They were taken on 2026-11-01 in the owner's Windows 11 guest (Enterprise Evaluation 26H2, build 26300.9457, Chrome 156.0.8078.80 and Edge 156.0.4314.58, keys sent as scancodes so Windows applied each layout itself): first what the browsers deliver to a probe page, then the bytes a v0.120.0 terminal sends to its PTY, logged by a raw-mode program inside it. Findings 7 and 9 and finding 5 with Num Lock on read right. Three rows did not match what Windows itself types, on both terminal engines:

- US-International apostrophe then Enter sent `\r` where Windows types `'\r`. Both `'` and `"` are dead keys on that layout, so a command line ending in a quote is submitted without it.
- Apostrophe then Tab sent `\t` where Windows types `'\t`.
- Alt+Numpad 6 4 with Num Lock off sent `ESC f ESC b @` where Windows types `@`.

## What is there

Read at `8d61a27eb` (main after the v0.120.0 record; no terminal change since `c43b29433`):

- The event order, recorded in Chrome and Edge alike on a textarea and on a contenteditable element like ghostty-web's host: a dead key's keydown and keyup carry `key="Dead"` with no text; Enter's keydown comes next, and only then the pending apostrophe, as a keypress and `insertText "'"`, followed by Enter's own keypress and `insertParagraph` (contenteditable) or `insertLineBreak` (textarea). Tab's keydown moves the focus as its default, before any text. No row produced a composition event.
- `web/packages/workspace-app/src/terminal/ghosttyKeys.ts`: after `Dead`, Enter and Tab reach `xtermKeydown`, which returns a pass for the pending dead key, and `ghosttyKeydownAction` sends their encoded bytes with the keydown cancelled. Windows Chromium drops the char events of a cancelled keydown, so the apostrophe never arrives.
- The Alt code: Windows types the code's character when Alt is released, as a keyup whose `key` is the character and whose `code` stays `AltLeft`, then a keypress and `insertText`. Before it the page sees each numpad digit as a keydown with Alt held, by `code` `Numpad6`, `Numpad4`; with Num Lock off their `key` is `ArrowRight`, `ArrowLeft`, which `terminalMetaKeyBytes` in `terminal/keymap.ts` sends as the readline word motions, and Alt+ArrowLeft is also the browser's Back. With Num Lock on the keys are `6`, `4`, which nothing encodes, so that case already typed only `@`.
- Two v0.120.0 readings confirmed on Windows: the key after a dead key carries the composed character (`key` U+00E9 for apostrophe then e), and a v0.120.0 terminal sends U+00E9, `'t` and `'` for apostrophe then e, t and space. AltGr+V on Czech, Slovak and Hungarian sends `@`; Chromium 156 reports that keydown with `ctrlKey` and `altKey` false and only `getModifierState("AltGraph")` true, after a synthetic `ControlLeft` keydown, so the v0.120.0 branch for an AltGr+V with Ctrl set does not run there and the character takes the typed path. Ctrl+Alt+X on US sends `ESC ^X`.
- The xterm.js engine read the same three rows the same way, and sent nothing for Ctrl+Alt+X.

## What changed

- In `ghosttyKeys.ts`, on Windows, a plain Enter (no modifier) after a pending dead key is a new `line-break` action: the keydown is stopped before ghostty-web but keeps its default, so the browser types the dead key's character first, through the host's `insertText` path or ghostty-web's textarea. The listener keeps the pending CR and sends it with Enter's own line-break input (`insertParagraph` or `insertLineBreak`, on the host or the textarea), cancelling that input so ghostty-web does not send it again. If no line-break input comes, Enter's keyup (matched by `code`), focus loss or the next keydown sends it, so Enter is never lost.
- On Windows, a numpad digit by `code` (`Numpad0` to `Numpad9`) with Alt alone held is a new `cancel` action, taken ahead of chan's own Alt bytes: nothing is sent and the default is cancelled, which also keeps Alt+ArrowLeft from going Back. The code's character still arrives as `insertText` when Alt is released.
- Tab after a dead key is unchanged: its default moves the focus out of the terminal, so it stays cancelled and the browser drops the dead key's character. The project rule is that chan does not infer that character from a layout or a key code.
- `web/packages/workspace-app/src/design.md` says the same in the ghostty paragraph. The xterm.js engine is unchanged; the ghostty engine is the default.

## How it was read

Tests first, against `8d61a27eb`, in `terminal/ghosttyKeys.test.ts` from the recorded event shapes: the Windows Enter action and the Alt-code action at the decision level; through chan's listener in front of ghostty-web's real `InputHandler`, the apostrophe then CR once on the focused host and on the textarea, CR at Enter's keyup when no line-break input comes, CR first at a following keydown or focus loss, an already cancelled line break left to the keyup, and Alt+Numpad 6 4 typing only `@` with Num Lock off and on, its digit keydowns cancelled. Red on the base, for the right reasons: 8 of the file's 75 tests, among them `the browser must still type the pending apostrophe: expected true to be false` (Enter's keydown cancelled), `expected [ '\u001bf', '\u001bb' ] to deeply equal []` (the word motions) and `Numpad6 must not reach the browser, where Alt+ArrowLeft is Back: expected false to be true`. A pin of the real AltGr+V shape passes on the base and after. Green after the change: the file's 75 tests, and the `terminal/` directory's 34 files and 582 tests.

One mutation per guard, each restored and the file's hash checked; all 17 turned the file red:

- the Alt-code cancel removed, or applied on every platform;
- the Alt-code test ignoring Shift, or ignoring Meta;
- the Enter wait removed, applied on every platform, or ignoring Shift;
- the dead key left pending after the Enter wait;
- the Enter keydown passed on to ghostty-web;
- the CR with the line-break input not sent, the input not cancelled, passed on to ghostty-web, or taken when already cancelled;
- no CR at the next keydown, a CR at any keyup, or none at focus loss;
- the cancelled Alt-code digit keeping its default.

The Windows reading at the tip: `target/debug/chan` built from the branch (sha256 `3db8fcdc9cb24c5962583b4029a576935032dea3cebb0ad798b319df83b1fe91`, built from the tree this commit records; the debug binary serves the branch's `web/dist`), under `env -i` with a private `CHAN_HOME` and `XDG_RUNTIME_DIR`, reached from the guest at the same origin through a port proxy. Each run opened a terminal on the ghostty engine (its DECRQM answer for mode 2048 was `2`, where xterm.js answers `0`) running the byte logger, read the focused element through Chrome's debugging port, and typed every row under US, US-International, Czech, Slovak and Hungarian with a positive control per layout (`y 2 ' space`: `y2' ` on US; `y2'` on US-International; z, U+011B, U+00A7 and space on Czech; z, U+013E, U+00A7 and space on Slovak; z, 2, U+00E1 and space on Hungarian). Chrome with the focus on chan's terminal host, Chrome with the focus moved to ghostty-web's textarea, and Edge on the host: every row typed what Windows types (`'\r` for apostrophe then Enter; `@` for Alt+Numpad 6 4 with Num Lock off by a chord and by separate key events, and on), except apostrophe then Tab (`\t`), as above. Around the change, in Edge: plain Enter `x\r`, the arrow keys' Alt+Left and Alt+Right `ESC b` and `ESC f`, numpad 4 without Alt `ESC [D`, and the page never went Back. A click on the terminal leaves the focus on the host, which is where chan keeps it.

The raw logs and summaries are in the guest's record, `dev/windows-vm/readings/` (`before.jsonl` and `summary.md` for the browsers, `after-v0.120.0-chrome-*.txt` for the base on both engines, `after-fix-*.txt` for the tip), with the red and green runs and the mutation log in `dev/windows-vm/fix/`.

## Not covered

- WebView2 (chan-desktop on Windows) was not read; its runtime there is 156.0.4314.58, the Chromium Edge was read on.
- The xterm.js engine keeps the three rows as they were.
