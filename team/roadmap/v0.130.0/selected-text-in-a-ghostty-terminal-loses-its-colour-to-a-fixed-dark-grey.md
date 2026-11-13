# Selected text in a ghostty terminal loses its colour to a fixed dark grey

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: found by the widened terminal pixel oracle on 2026-11-12 and left as it was through the renderer's rework: "Selected text is drawn in `#1e1e1e`, the renderer's default selection foreground, because chan's theme names none." (`dev/v0129/row-notes.md`, "ghosttyng: findings from the widened pixel oracle", item 3). Listed again as a candidate when this release's rows were drafted from v0.129.0's notes, 2026-11-13. The owner, on that list: "let's add all as small fixes to v0.130".

## What is there now

Read at `f6c175793`; not run.

- The renderer's text pass draws a selected cell's glyph in `theme.selectionForeground` (`renderCellText`, `web/packages/ghostty-web-ng/lib/renderer.ts`). Its theme is `{ ...DEFAULT_THEME, ...theme }` at construction and in `setTheme`, and `DEFAULT_THEME.selectionForeground` is `#1e1e1e`, upstream's take on Ghostty's inverted selection (its comment: selection background the default foreground, selection foreground the default background). chan's theme (`terminalTheme`, `web/packages/workspace-app/src/components/TerminalTab.svelte`) names `selectionBackground: "rgba(88, 166, 255, 0.35)"` and no selection foreground, and a theme switch passes the same (`terminal/ghosttyTheme.ts`). So every selected glyph, whatever its colour, draws in `#1e1e1e` over a translucent blue: under the dark theme, dark grey on a dark blue tint. An underline or strikethrough on a selected cell follows it.
- xterm.js with the same theme keeps selected text in its own colour: a theme without `selectionForeground` leaves it undefined (`ThemeService`), and both the WebGL renderer chan loads (`CellColorResolver`, `@xterm/addon-webgl` 0.19.0) and the DOM renderer override a selected cell's foreground only when the theme names one.
- The pixel harness's `selection`, `select-move` and `select-once` patterns record today's picture (`scripts/e2e/terminal-pixels/harness.mjs`).

## Desired contract

1. Selected text in a ghostty terminal keeps the colour it has unselected (its foreground after inverse and faint), over the selection background, as on xterm.js with chan's theme.
2. A theme that names a selection foreground draws selected text in it; chan's themes name none.
3. Nothing else changes: the selection's background, the cursor's text colour and every unselected cell.

## Boundaries

- The renderer's text pass and its theme defaults (`lib/renderer.ts`).
- Not here: the selection background over a cell's own background, which ghostty replaces and xterm.js blends; a setting for selection colours.

## Acceptance

1. App tests over the real widget and core (as `src/terminal/ghosttyRenderer.test.ts` paints): selected cells written in red, in the default colour and in inverse video draw their glyphs in those colours, and a theme with a selection foreground draws them in it; the first three red on today's code.
2. The pixel harness in a guest: against the base's PNGs, `selection`, `select-move` and `select-once` differ only in the selected glyphs' colour, and every other pattern is byte-identical.
3. On chan-desktop, under the dark and the light theme: coloured output (`ls --color`, `git diff`) selected keeps its colours, as in an xterm.js terminal beside it.
