# A command a Muse agent prints across rows copies with a line break at each row

Status: accepted for v0.133.0 by the owner on 2026-11-20 ("the other thing is that muse clients printing commands that break across multiple lines end up copying the buffer with \n in it, same problem we recently fixed in ghostty with claude; i want these things working properly"). Fix chosen by the owner the same day: a full-width join for Muse sessions only ("Muse-only full-width join (Recommended)"). Built and reviewed on 2026-11-20 on `v0133/musecopy` at `eb7cfa918`; see "Built" below.

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

## Built, 2026-11-20

In a ghostty terminal whose session runs Muse, every copy reads a row that holds text to its last column, over a row that holds text, as soft-wrapped (`web/packages/workspace-app/src/terminal/drawnWraps.ts`), unless either row is a full-width rule (box-drawing characters and spaces only). The selection read, Copy scrollback and the double and triple click walks ask at each copy, so the chord, the menu's Copy and Copy scrollback, copy on release and the clicks give the same line. A session runs Muse when the server derived the agent `muse` from its spawn command (`submit_agent`), or while the foreground command's name holds `muse` as a word (`program.command`; Muse's launcher executes `muse-bin-<version>`), so a Muse started from a shell counts while it runs and stops counting when it exits. Every other program keeps the terminal's own reading. The xterm.js engine is unchanged: xterm.js builds its own selection text and chan has no seam there. `design.md` and the manual's terminal page say so. Commits `4393a2d4e`, `7ed29fbdf`, `9827ba5a4`, `3e6811c95`, `eb7cfa918`.

Limits that follow from the rule: any row that holds text to the last column over a text row joins while Muse is in front, a shell's line of exactly the width included; a cut that falls exactly on a space is not joined, since Muse pads its prompt-echo rows with drawn spaces to the edge and the two cannot be told apart; a box side such as `│ text │` reaching the edge over another text row would join (no such row seen in Muse's output, which draws `─` rules and `└` tree glyphs); a tab spawned as Muse keeps joining after Muse exits to a shell.

Evidence, in `dev/v0133/lanes/muse/` of the development tree:

- The reading (acceptance 1): the capture above, and check 330's record of the core's wrap flag for every fixture row in a browser: none set, at the base and the tip. The fixture is the two draws of the code-block line cut from that capture (`scripts/e2e/browser-smoke/fixtures/muse-code-block-*.bin`, provenance in `muse-code-block.json`).
- Check 330 (`330-muse-wrapped-command-copy`), a stand-in named `muse` replaying the fixture at 80 columns: at the base (the check and fixtures laid over the row file's commit) six legs red, the Muse terminal's release, chord, menu, Copy scrollback, double and triple click keeping the break at the cut; at the tip every path one line, while a control terminal not named after an agent keeps the break and a two-line output and a full-width rule over a line stay as they were. Green again at `3e6811c95` beside check 223.
- Unit tests over the vendored core from the same fixture (`drawnWraps.test.ts`, 31): red at the base on the copy paths; a reviewer's 24 mutants and the builder's, each a plausible wrong rule (no Muse condition, no rule exclusion, a newline or a space at the join, the edge read a column short, history rows ignored by the clicks, the scan starting a row early), each killed by a named test.
- The web gate at `3e6811c95` (web-check, the marketing check, e2e-check) and the terminal suite at `9827ba5a4` (J240's 25 checks, 292, 294, 296, 121, 990 and 330, 31 of 31) green.
- Four Fable reviews (correctness, test honesty, and a confirm read of each fix round): accept with notes, nothing blocking; the last, accept.

A note for Muse's maintainers goes with the hand-back: drawing a long code line as one logical line, with no cursor move or line feed at the edge, would give every terminal the wrap flag.
