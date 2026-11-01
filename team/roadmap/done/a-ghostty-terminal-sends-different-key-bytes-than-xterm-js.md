# A ghostty terminal sends different key bytes than an xterm.js terminal

Status: shipped in [v0.119.0](../../release/release-v0.119.0.md).

Record before the release: landed in `0.119.0-ga` on 2026-10-31 (`0535eb10b`) and fixed there after the review (the section Review, 2026-10-31); the gateway transport, the Linux desktop and Windows were not exercised by hand.

Record before the review: built on `v0119/ghostty-keys`, on top of `v0119/ghostty-vt-wasm`, on 2026-10-31 (`fb2506378`); the owner's macOS check passed at that commit the same day ("it works!", the section macOS verification). Awaiting review; the gateway transport, the Linux desktop and Windows were not exercised.

## What was seen

Read at `14231a30c`, where ghostty-web's own input handler encoded every key on the ghostty backend (the default since v0.117.0). chan's xterm.js path differs from it:

1. Alt+Left/Right sent CSI 1;3D and CSI 1;3C, which a shell prints as `;3D`; chan's xterm.js path sends the readline word motions ESC b and ESC f.
2. Alt+B sent `b` on Linux, and macOS Option+B sent nothing: ghostty-web never prefixes Alt with ESC and passes no text to its encoder for an Option character.
3. Shift was dropped from Home, End, Delete and the function keys.
4. Ctrl+[ sent CSI 91;5u instead of ESC.
5. Shift+PageUp/Down went to the program instead of scrolling the scrollback.
6. Shift+Insert and dead keys had their default prevented, losing the browser's paste and composition.

The build session reproduced items 1 and 2 by running ghostty-web's real input handler on the vendored wasm with chan's listener removed. That check is not kept as a test.

## Desired contract

A ghostty terminal sends what chan's xterm.js terminal sends for every keydown, chan's own key handling included (Ctrl+/, Alt+Left/Right/Backspace/Delete, modified Enter under the negotiated keyboard protocol), except that on macOS a layout's printable ASCII Option character types itself (the owner's decision of 2026-10-31, the section Review). Keys chan claims as its own chords, unclaimed macOS Command chords and the keys xterm.js leaves to the browser keep reaching chan, the native menus and the browser. Plain typing and IME composition stay with ghostty-web.

## What was done

- `terminal/xtermKeyboard.ts`: a port of xterm.js 6.0.0's `evaluateKeyboardEvent` and the keydown decisions around it (Shift+PageUp/Down scrolling, Cmd+A, dead keys, Windows AltGr, IME keys), with Option as Meta on macOS as chan configures xterm.js, under xterm.js's MIT notice.
- `terminal/ghosttyKeys.ts`: a capture-phase keydown listener on the ghostty host that decides each key before ghostty-web's bubble listener. It sends what the port or chan's xterm-side handling produces through `sendUserInput`, scrolls for Shift+PageUp/Down, leaves plain typing and IME keys to ghostty-web, and stops a key xterm.js leaves to the browser without preventing its default.
- `terminal/keyboardProtocolStream.ts`: follows the program's kitty and modifyOtherKeys requests from the ghostty output in the termWriter, through `applyKeyboardProtocolCsi`, which `keymap.ts`'s xterm.js parser hooks now share. The VT answers the kitty query; chan answers the modifyOtherKeys query.
- The listener replaces the macOS host-chord gate (`hostChord.ts`) and the ghostty Shift+Enter and Ctrl+V arms, which are removed.

## Evidence

- `xtermKeyboard.test.ts` compares the port with xterm.js's own evaluator, loaded from the TypeScript source its package ships, over every key code, modifier combination, both platforms, both cursor modes and both Option settings.
- `keyboardProtocolStream.test.ts` runs a corpus and 3,000 random streams through xterm.js's own parser with chan's handlers and through the observer, split at every byte.
- `ghosttyKeys.test.ts` drives ghostty-web's real input handler on the vendored wasm behind the listener and matches chan's xterm.js path over every key in its list and all 16 modifier combinations, with and without application cursor mode, on Linux and macOS, plus named cases for Alt+Left/Right, Alt+B, Option+F, Alt+Delete, Ctrl+[, Shift+Home, Cmd+Enter, Shift+Insert, a dead key and an unclaimed Command chord.
- On the Linux host at `fb2506378`, `make web-check` was green: `svelte-check` clean, the workspace-app suite at 622 files and 8,120 tests, and the production build.
- On macOS at `fb2506378`, the seven key-related files (`ghosttyKeys`, `xtermKeyboard`, `keyboardProtocolStream`, `keymap`, `ghosttyPaste`, `TerminalTab.ghosttyBackend`, `chordEscapeRegistry`) passed, 220 tests.

## macOS verification, 2026-10-31

A debug chan-desktop built from the clean `fb2506378` tree reported `git-fb25063789da` and ran with a disposable `CHAN_HOME` and a separate `XDG_RUNTIME_DIR`, apart from the installed app. The owner was given a key probe that prints the bytes the PTY receives and this checklist on the ghostty backend, and reported it passed ("it works!"):

- Option+Left/Right and Option+B/F send ESC b and ESC f, and move by word at a shell prompt; Option+Backspace sends ESC DEL and Option+Delete ESC d.
- Ctrl+[ sends ESC, Ctrl+V 0x16, Ctrl+/ 0x1f, Shift+Enter LF, Cmd+Enter CR, Shift+Home/End CSI 1;2H and CSI 1;2F; Cmd+V pastes.
- Cmd+T, Cmd+W, Cmd+Shift+T and Cmd+Option+W reach the native menus and send nothing; Shift+PageUp/Down scroll the scrollback.
- A dead key from an input source with non-Option dead keys composes its character once; an IME's committed text arrives once.

That instance's socket paths exceeded the Unix socket length limit, so it ran without a control socket or CLI handoff; neither is on the key path.

## Not done here

- Typing while scrolled up keeps the ghostty viewport where it is; xterm.js jumps to the bottom.
- After a reload whose replay lost the program's kitty request, the VT answers a kitty query with 0, where the xterm.js path answers with the restored flags.
- Plain typing still goes through ghostty-web's `onData`, unmarked, as before; only the keys the listener sends go through `sendUserInput`.
- Not exercised over the gateway transport, on the Linux desktop (WebKitGTK) or on Windows.

## Review, 2026-10-31

Read at `afb83e7a4` by the review the owner asked for before the GA ("do an adversarial review"), whose reviewers were asked for evidence or a plain "nothing found"; the lead reproduced each finding acted on before its fix.

- Fixed, `a701b9bd3`: after an AltGr or a dead keydown the port's flag stayed set until a key it encodes, and the listener left the next key to the browser, whose text never reaches ghostty-web while its host holds the focus (ghostty-web cancels a `beforeinput` aimed at the host, which chan focuses). On Linux and WebKitGTK the AltGr character itself (`@`, `[`, `{`, `|`, `\`, `~` on a German layout) and a dead key's composed character were lost; on Windows the AltGr character typed and the key after it was lost (h, Enter, the arrows, Ctrl+C; Tab moved the focus). A key ghostty-web would type is now its to type, which clears the flag as xterm.js's keypress does. Seven sequence cases were red and are green; in headless Chrome with CDP key events and the host focused, Linux AltGr+Q then h, a dead acute then e-acute then h, and Windows AltGr+Q then h each lost a character before and deliver xterm.js 6.0.0's bytes after. Windows and WebKitGTK event shapes were modelled in Chrome on Linux, not run there.
- Fixed by the owner's decision of 2026-10-31 ("ASCII types itself"), `9b7b106fb`: with Option always Meta, a German, French or Nordic Mac layout could not type `@`, `[`, `|`, `{` or `\` in the default terminal, which the ghostty backend of v0.117.0 and v0.118.0 typed. On macOS an Option character that is printable ASCII other than the space now types itself; a US layout keeps Meta, its Option characters being outside ASCII but for Option+Shift+` (a backquote, where xterm.js sends ESC ~). The new case was red and is green, and the review's end-to-end case through ghostty-web's own input handler passes five of five.
- Left open as minor, in [v0120review]: the core's kitty flags against chan's after a replay cut, DECSTR, a deep stack and flags above 31; text the browser types with no keydown of its own while the host holds the focus; a dead key followed by Enter or Tab; and Windows Ctrl+Alt+letter and AltGr+V, both as in v0.118.0.

The key path's reviewer then read the fixes. The AltGr fix matches xterm.js with the host or ghostty-web's textarea focused. An ASCII Option character after a dead key the input source composed left the flag set and lost the next key, fixed in `f99ac6291`. The key after a Windows dead key now types `ev.key`, as ghostty-web's own keydown did in v0.118.0; that is right only if Windows Chromium puts the composed character there, and US-International's apostrophe before a consonant is lost either way, so it is left open in [v0120review] for a reading on Windows.

[v0120review]: ghostty-defects-the-v0119-review-left-open.md
