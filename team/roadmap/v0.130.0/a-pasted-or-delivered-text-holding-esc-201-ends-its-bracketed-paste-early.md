# A pasted or delivered text holding `ESC[201~` ends its bracketed paste early

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: drafted on 2026-11-11 from the cleaned ghostty paste of [copying a wrapped command from a ghostty terminal pastes it broken](../done/copying-a-wrapped-command-from-a-ghostty-terminal-pastes-it-broken.md), whose shipped text leaves xterm.js pastes and the server's bracketed delivery to "a separate row" (the draft: `chan-dev/releases/v0128/team/reports/row-draft-a-pasted-or-delivered-text-holding-a-bracket-end-ends-its-paste-early.md`). v0.128.0's record lists it among the drafts the owner had not placed (`team/release/release-v0.128.0.md`). Asked on 2026-11-13 whether it goes into v0.130.0, the owner: "yes in v0.130.0".

## What is there now

Read at `f6c175793`; not run.

- **ghostty pastes are clean.** Every paste path, the chord's native paste and an `insertFromPaste` input (taken from ghostty-web by the tab's capture listeners `onTerminalPasteCapture` and `onTerminalBeforeInputCapture`), the menu's Paste row (`pasteClipboard`, `web/packages/workspace-app/src/components/TerminalTab.svelte`) and the Linux middle click (`terminal/primarySelection.ts`), goes through `pasteIntoGhostty` (`terminal/ghosttyPaste.ts`): line ends become `\r`, then the core's paste encoder `VtTerminal.encodePaste` (`web/packages/ghostty-web-ng/vt/ghosttyVt.ts`) turns NUL, BS, ENQ, EOT, ESC, DEL and the ten tty control characters into spaces and frames the text under bracketed paste. A pasted `ESC[201~` reaches the program as ` [201~` inside one bracket.
- **xterm.js pastes are not.** The chord's native paste reaches xterm.js's own listener on its textarea and element (`handlePasteEvent`), and the menu's row and the middle click call `term.paste`. xterm.js 6.0.0's `paste` (`src/browser/Clipboard.ts`) turns `\r?\n` into `\r` and frames the text under bracketed paste, removing nothing. A text holding `ESC[201~` ends the bracket, the rest reaches the program as keys, and Ctrl+C, Ctrl+U, Ctrl+Z and the tty's other characters reach the line discipline. The two backends send different bytes for one text.
- **Delivered text frames itself on the server.** The Rich Prompt's messages and `cs terminal write --submit=<agent>`, through the write queue (`crates/chan-library/src/terminal_sessions.rs`), and the team bootstrap (`submit_writes`, `crates/chan-server/src/control_socket.rs`) are encoded by `plan_submitted_input` (`crates/chan-shell/src/submit.rs`), which puts the text into the agent's template with `apply_template`, unchanged but for its trailing newlines. The built-in templates of agy, codex, kimi and opencode are `\x1b[200~{}\x1b[201~\r` (`default_template`); a `submit.toml` entry or `CHAN_SUBMIT_<AGENT>` replaces a template whole (`crates/chan-server/src/submit_config.rs`). A message holding `ESC[201~` ends the bracket and the rest reaches the agent as keystrokes, whichever backend shows the terminal. Without `--submit`, `cs terminal write` writes its bytes verbatim.

## Desired contract

1. A paste into an xterm.js terminal sends the bytes a ghostty terminal sends for the same text, on every paste path: the core's set as spaces, `\r` line ends, framed under bracketed paste.
2. A text that a submit template frames in a bracketed paste cannot end it: the bytes the paste encoder replaces become spaces before the template wraps the text, for a built-in template and an override alike. Line feeds and tabs pass, so a multi-line prompt keeps its lines.
3. A template that frames nothing (claude, gemini, muse) and a `cs terminal write` without `--submit` send their text as now: a raw write is a byte pipe by design.

## Boundaries

- The workspace app's xterm.js paste paths (a capture listener taking the native paste before xterm.js's own, as ghostty's does; `pasteClipboard`; `primarySelection.ts`), cleaning before `term.paste` with xterm.js unpatched; on the server, the submit encoding in `chan-shell`. Neither side has a ghostty core to call (an xterm.js terminal loads no wasm), so each holds the encoder's byte set, checked against `encodePaste`.
- Not here: a confirmation for multi-line pastes; a dropped file's paths, which are shell-escaped.

## Acceptance

1. Check 216 extended with check 223's hostile text on xterm.js, by the chord and the menu's row: the PTY reads it once, framed and cleaned; red on today's code.
2. App tests: an xterm.js paste by the native event, the menu's row and the middle click sends the cleaned bytes, red on today's code; the app's byte set equals `encodePaste`'s over every ASCII byte, with and without bracketed paste.
3. Server tests for each bracketing built-in template and for an overridden one: a message holding `ESC[201~` and a line feed reaches the PTY with one closing bracket and its line feed; red on today's code. A claude message and a raw `cs terminal write` reach it unchanged.
