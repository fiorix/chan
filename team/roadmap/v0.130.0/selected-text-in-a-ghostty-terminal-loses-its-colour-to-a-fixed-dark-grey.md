# Selected text in a ghostty terminal loses its colour to a fixed dark grey

Status: accepted for v0.130.0 by the owner on 2026-11-13; built on 2026-11-14 on the branch `v0130/ghostty-selection-colour` (`ff332e005`), not merged; the section "Built 2026-11-14" holds the evidence. Owed: acceptance 3 on chan-desktop.

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

## Built 2026-11-14

One commit over `7ed970eb3`: `ff332e005` fix(terminal).

What changed. The renderer's default theme (`DEFAULT_THEME`, `lib/renderer.ts`) names no selection foreground, and its type makes that colour the one optional entry. The text pass draws a selected cell in the theme's selection foreground only when the theme names one; otherwise in the cell's own colour after inverse, with faint's half alpha, and the underline and strikethrough follow it. The cursor's override still comes first, and the background pass is untouched. The scenario doc's list of what the pixel references record (`scripts/e2e/scenarios/terminal-grid-rendering.md`) now says selected text keeps its colour, and the widget's own default-theme test in `lib/` (a `bun:test` file the gate does not run) expects no selection foreground.

Tests, red then green. `src/terminal/ghosttyRenderer.test.ts` gains three tests over the real widget, its `SelectionManager` and the vendored core, the core's colours built by the widget's own `buildWasmConfig` from a theme of chan's shape, on a canvas that records each glyph's fill and alpha and each stroke's colour. Two rows hold the same cells (red, default, inverse, faint red, underlined red) and only the first is selected. "A selected cell draws its glyph in the colour it has unselected" holds each selected glyph to the same cell unselected and to the theme's colour (inverse to the theme background, faint at alpha 0.5), and each underline to red; red at `7ed970eb3`, where every selected glyph and underline is `#1e1e1e`. "A theme that names a selection foreground draws selected glyphs in it" passes at the base for the named colour and is red there on its last step, a `setTheme` back to chan's theme, which left the selected glyphs in `#1e1e1e`. The third, the selection background's pixel and the cursor accent on a selected cell, is a guard, green on both. Two mutations, each run against the committed tests and restored from HEAD: `#1e1e1e` put back in the default theme, and the condition reduced to `isSelected`; each turns the first two tests red.

In a guest. The pixel harness in `chan-v0130-selfg` (WebKitGTK under Xvfb), a run at `7ed970eb3` with `--out` and one at `ff332e005` with `--compare` against it: 24 of 27 PNGs are byte-identical, and the three that differ are `selection`, `select-move` and `select-once`; the twins still match each other, and the xterm DOM arms fail their seam measures alike in both runs, as under Xvfb before. In the three, every differing pixel lies in a selected cell, every touched cell but two keeps its background colour, and each glyph's ink moves from `#1e1e1e` to its own colour: `#ebebf0` default text, `#ff6b6b` red, `#ff8700` for 256-colour 208, `#e3b341` yellow, faint text at the midpoint of the default foreground and the selection background, inverse text at the theme background. The two hold a full and an upper-half block, whose ink fills half the cell or more, so their commonest colour is the glyph's. 282 of the 4467 differing pixels in `selection`, and 2 of 498 in the other two, are glyph-edge pixels the dark ink left at the background colour and the light ink does not.

Not observed: chan-desktop under either theme (acceptance 3), the light theme anywhere, and WKWebView or WebView2. The pixel patterns paint the dark theme only.
