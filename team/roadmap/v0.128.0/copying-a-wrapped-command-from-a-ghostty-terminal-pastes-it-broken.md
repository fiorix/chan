# Copying a wrapped command from a ghostty terminal pastes it broken

Status: raised by the owner on 2026-11-09 and accepted for v0.128.0 the same day; not started. It touches the ghostty widget, so it lands on whichever widget is in place when it is built, before or after the [ghostty-web-ng item](chan-drives-ghostty-web-from-outside-through-its-private-internals.md).

## What is there now

Paths are under `web/packages/workspace-app/src/` unless they say otherwise.

- **Copy breaks soft-wrapped lines.** chan builds a ghostty selection's text with libghostty-vt's formatter (`terminal/ghosttySelection.ts:63-84`, installed at `components/TerminalTab.svelte:1387`), created with default options and only the selection set (`terminal/ghosttyVt.ts:862-872`); its doc comment says a soft wrap stays a line break (`:843`), and ghostty-web's fallback adds a newline after every row too (`ghostty-web.js:2109-2110`). A command longer than the terminal is wide therefore copies with a newline at each wrap, and pasted into another terminal it runs as several commands. The vendored 1.0 core has the options that fix this, `GHOSTTY_FORMATTER_OPT_UNWRAP` and `TRIM`, but the binding knows only `SELECTION` (`ghosttyVt.ts:59`); it already reads each row's wrap flag (`isRowWrapped`, `:937-947`) and no copy path uses it. Turning unwrap on was a mutation the tests killed when Copy scrollback was fixed (`team/roadmap/done/copy-scrollback-of-a-long-ghostty-history-blocks-the-page.md`), so the fix changes pinned behaviour on purpose. xterm.js terminals join wrapped rows (`SelectionService.ts:233-252`).
- **Two copy paths.** Cmd+C or Ctrl+Shift+C and the menu's Copy go through chan's writer (`TerminalTab.svelte:2729-2733`, `api/desktop.ts:216-227`: the desktop's native clipboard through arboard, `desktop/src-tauri/src/main.rs:4073-4087`, else `navigator.clipboard`). ghostty-web's own copy on mouse release, double click and triple click writes the clipboard itself, on every selection (`ghostty-web.js:2285-2319`, `:2448-2486`), around chan's writer.
- **No markers are inserted.** Secret masking and privacy mode paint over the canvas and leave the buffer alone (`terminal/secretMaskingGhostty.ts:47-55`), OSC 7501 is stripped before the parser (`terminal/ghosttyStatusGuard.ts`), and the NUL path mark never reaches terminal text (`terminal/fromHere.ts:18`). One consequence: copying a masked secret copies the secret. ghostty-web's fallback writes a space for an empty or wide-character spacer cell (`ghostty-web.js:2106-2107`), and without `TRIM` row ends can carry padding.
- **Paste is not cleaned.** A paste into a ghostty terminal is wrapped in `ESC[200~`/`ESC[201~` only while the program asked for bracketed paste (`ghostty-web.js:1249-1252`), with no newline conversion and no stripping, so text that contains `ESC[201~` or other control bytes ends the bracket early and the rest is typed as keystrokes. xterm.js converts `\r?\n` to `\r` before bracketing (`@xterm/xterm` `Clipboard.ts:13-26`). Nothing in chan confirms a multi-line paste.
- **Tests.** `terminal/ghosttySelection.test.ts` and `terminal/ghosttyVt.text.test.ts` cover selections separated by hard line breaks only; no test copies a soft-wrapped row on either backend, and none checks pasted bytes for control characters.

## Desired contract

1. Copying from a ghostty terminal joins soft-wrapped rows into the line they continue, keeps hard line breaks, and carries no padding spaces at row ends and no spacer cells, the way xterm.js terminals copy; a command that wrapped on screen pastes as one line.
2. Every copy path (the chord, the menu's Copy and Copy scrollback, copy on mouse release, double and triple click) produces the same text through chan's writer.
3. Copied text holds only what the screen shows: no NUL, no control or escape bytes, no private-use or zero-width characters chan or the widget inserted, on Linux (chan-desktop on X11 and Wayland, and the browser), macOS and Windows.
4. A paste into a ghostty terminal cannot end its own bracket: `ESC[201~` and other escape sequences in the pasted text are removed or neutralized before it is sent, and line endings are converted as xterm.js converts them.

## Boundaries

- Secret masking stays paint-only; whether copying a masked secret should copy it is a separate decision.
- No PRIMARY selection (middle-click paste) on Linux; it gets its own row if wanted.
- No confirmation dialog for multi-line paste.

## Acceptance

1. Vitest over the vendored core: a command longer than the width copies as one line, a hard break stays, wide characters and row-end padding copy clean, and the copy-on-select path yields the same string as the chord; the earlier pin that kept soft wraps is replaced, with the reason in the commit.
2. A paste test: text with `ESC[201~`, other escapes and `\r\n` reaches the terminal with the bracket intact and the line endings converted.
3. A browser check in an isolated guest: a long command typed into a ghostty terminal, copied by each path, and pasted into a second terminal runs once as one command; the clipboard's bytes are compared with the expected text.
4. On chan-desktop on Linux (X11 and Wayland) and macOS (owner): the same copy and paste between two terminals, and from a terminal into another application, carries no stray bytes.
