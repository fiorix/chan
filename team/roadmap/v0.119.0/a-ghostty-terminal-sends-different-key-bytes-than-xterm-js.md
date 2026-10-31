# A ghostty terminal sends different key bytes than an xterm.js terminal

Status: built on `v0119/ghostty-keys`, on top of `v0119/ghostty-vt-wasm`, on 2026-10-31 (`fb2506378`); the owner's macOS check passed at that commit the same day ("it works!", the section macOS verification). Awaiting review; the gateway transport, the Linux desktop and Windows were not exercised.

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

A ghostty terminal sends what chan's xterm.js terminal sends for every keydown, chan's own key handling included (Ctrl+/, Alt+Left/Right/Backspace/Delete, modified Enter under the negotiated keyboard protocol). Keys chan claims as its own chords, unclaimed macOS Command chords and the keys xterm.js leaves to the browser keep reaching chan, the native menus and the browser. Plain typing and IME composition stay with ghostty-web.

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
