# A command a Muse agent prints across rows copies with a line break at each row

Status: accepted for v0.133.0 by the owner on 2026-11-20 ("the other thing is that muse clients printing commands that break across multiple lines end up copying the buffer with \n in it, same problem we recently fixed in ghostty with claude; i want these things working properly"). Fix chosen by the owner the same day: a full-width join for Muse sessions only ("Muse-only full-width join (Recommended)"). Not started.

Record: raised by the owner on 2026-11-20 while running Muse agents in chan terminals. The fix he refers to is [copying a wrapped command from a ghostty terminal](../done/copying-a-wrapped-command-from-a-ghostty-terminal-pastes-it-broken.md), shipped in v0.128.0.

## What is there now

Read at `793d86522`. Paths are under `web/packages/workspace-app/src/` unless they say otherwise.

- A ghostty selection's text is one formatter call over the selection in the vendored core (`VtTerminal.plainText`, installed by `installGhosttySelection` in `terminal/ghosttySelection.ts`), which joins rows the terminal soft-wrapped and keeps every other line break. A double and a triple click walk across rows by the same flag (`continuesAbove`, `wordAcrossWraps`, `lineAcrossWraps`). Every copy path the v0.128.0 row names goes through that text: the chord, the menu's Copy and Copy scrollback, copy on mouse release, double and triple click.
- That join exists only where the terminal itself wrapped a row: a row gets the flag when a printed character lands past the last column. A program that draws its own rows gives the terminal nothing to join.
- Muse Code 1.4.24 draws its own rows. Read on a PTY of 80 by 24 in an isolated guest on 2026-11-20, with the real model asked to run a 136-byte `printf` pipeline and print it in a bash code block:
  - The code block's line is drawn to the last column and cut there, mid-word (`... wrapprobe-charlie wrapprobe-de` and `lta wrapprobe-echo wrapprobe-foxtrot | sort -r | uniq -c | head -n 50`), with no indent on the continuation. The first row holds 80 cells.
  - Muse places the continuation itself, in two forms within one turn: an absolute cursor move to column 1 of the next row (`ESC[14;1H`), or a scroll of the rows above into history (`ESC 7`, `ESC[1;14r`, `ESC[14;1H`, LF, `ESC[r`, `ESC 8`) and a draw on the fresh row. Neither is an autowrap, so no row carries the wrap flag, and every copy path puts a line break at the cut.
  - Prose, the echo of the user's prompt and replies are word-wrapped by Muse at word boundaries with a two-space hanging indent; those rows end short of the last column.
- The tab knows which agent a session runs when the server derived one from the spawn command (`submit_agent` on the session frame, applied by `setTerminalSubmitAgent` in `components/TerminalTab.svelte`), and the foreground command's name for a program started from a shell (`program.command`). On the host the Muse launcher `~/.local/bin/muse` executes `muse-bin-<version>`.
- No test copies rows a program drew itself.

The fixture of recorded bytes is the two draws of that code-block line, cut from the capture with nothing else of the session (provenance beside it in the check's fixture).

## Desired contract

1. In a terminal whose session runs Muse, a copy joins a row filled to its last column with the row below it, as if the terminal had soft-wrapped it, so a command Muse cut at the width copies as one line.
2. A row that is a full-width rule (only box-drawing characters and spaces) is never joined, and neither is a row that does not reach the last column: Muse's word-wrapped prose keeps its line breaks.
3. The rule holds for every copy path the v0.128.0 row names, on both backends where chan builds the copied text, and joins nothing in a terminal whose session does not run Muse.
4. The terminal's own soft-wrap join and its hard line breaks are unchanged.

## Boundaries

- `terminal/ghosttySelection.ts` and the copy paths behind it, the xterm.js copy chan builds where it builds one, and where a tab learns that its session runs Muse; the check's fixture.
- The widget package (`web/packages/ghostty-web-ng`) only if the reading shows the join cannot be made outside it.
- Muse's own rendering is not chan's to change. A note for its maintainers goes with the hand-back: drawing a long code line as one logical line and letting the terminal wrap it would give every terminal the flag.

## Acceptance

1. The reading recorded here with the fixture, and the core's wrap flag for each fixture row read in the browser check: none set.
2. A browser check in a guest that replays the fixture into a ghostty terminal of a Muse session, selects the command and reads the clipboard by each copy path: one line, red at the base; a control in the same session, a real two-line output and a full-width rule over a line, that stays as it was; and the same fixture in a session that does not run Muse, unchanged.
3. A unit test on the join from the same fixture, killed by one mutation.
4. The terminal suite; two Fable readers.
