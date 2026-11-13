# Every underline style in a ghostty terminal draws one straight line

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: found by the widened terminal pixel oracle on 2026-11-12 and left as it was through the renderer's rework: "Minor: every underline style draws one straight underline, overline draws nothing, blink does not blink." (`dev/v0129/row-notes.md`, "ghosttyng: findings from the widened pixel oracle", item 4). Listed again as a candidate when this release's rows were drafted from v0.129.0's notes, 2026-11-13. The owner, on that list: "let's add all as small fixes to v0.130".

## What is there now

Read at `f6c175793`; not run.

- The core keeps each cell's underline style and colour: `GhosttyStyleFlags` holds the style in three bits (`GhosttySgrUnderline`: none, single, double, curly, dotted, dashed) and `GhosttyStyle` an `underline_color`, none, a palette index or RGB, as SGR 58 set it (the 1.0.1 ABI, `dev/v0129/evidence/corebump/abi/1.0.1/type-json.sorted.json`).
- The binding copies the whole flags word into `VtCell.flags`, the style's bits included (`rememberStyle`, `STYLE_FLAG_BITS.underline`, `web/packages/ghostty-web-ng/vt/ghosttyVt.ts`), but its `VtFlag.UNDERLINE` masks every style at once, and nothing reads the underline colour: `LAYOUT.GhosttyStyle` names the field and `VtCell` has no place for it.
- The renderer draws any underline as one straight 1-pixel line below the baseline in the glyph's colour (`renderCellText`, `web/packages/ghostty-web-ng/lib/renderer.ts`). Overline (`VtFlag.OVERLINE`) and blink (`VtFlag.BLINK`) reach the cell and nothing draws them.
- xterm.js, chan's other backend, draws the five styles each in its shape, in the SGR 58 colour when one is set and the glyph's otherwise, and draws overline (`TextureAtlas.ts` in `@xterm/addon-webgl` 0.19.0, the renderer chan loads; its DOM renderer by class). It parses blink and draws nothing for it.
- The pixel harness's `attrs` pattern writes each style (`4`, `4:2` to `4:5`), overline (`53`) and blink (`5`) on its row 6, and records them as one line, nothing and plain text; no pattern sets SGR 58 (`scripts/e2e/terminal-pixels/harness.mjs`).

## Desired contract

1. A ghostty terminal draws single, double, curly, dotted and dashed underlines each in its own shape, across every column the cell takes (both of a wide character's), as xterm.js does. A single underline stays the line it is today.
2. An underline takes the colour SGR 58 gives it, a palette index or RGB, and otherwise the glyph's colour, as now; SGR 59 returns it to the glyph's.
3. Overline draws a line along the top of the cell in the glyph's colour.
4. Nothing else changes: strikethrough, a link's hover underline and every cell with none of these attributes.

## Boundaries

- The binding's cell (the underline style read from the flags, the underline colour from the style) and the renderer's decoration pass (`lib/renderer.ts`). Overline comes with the same pass: its flag is in the cell already.
- Not here: blink, which needs a timer that repaints the blinking rows, and which xterm.js does not draw either.

## Acceptance

1. App tests over the real widget and core (as `src/terminal/ghosttyRenderer.test.ts` paints): each of `4:2` to `4:5` draws its shape (two lines, a wave, dots, dashes) across the cell, `53` a line at the cell's top, `4:3;58;2;255;0;0` and `4;58;5;196` an underline in red while the glyph keeps its colour; red on today's code. A single underline draws as today.
2. The pixel harness in a guest, with a row added to `attrs` that writes each style under an SGR 58 colour: against the base's PNGs, `attrs` differs only at the cells of `4:2` to `4:5` and `53` and on the new row, and every other pattern is byte-identical.
3. On chan-desktop: `printf '\e[4:2mdouble\e[0m \e[4:3mcurly\e[0m \e[4:4mdotted\e[0m \e[4:5mdashed\e[0m \e[4:3;58;2;255;0;0mred\e[0m \e[53mover\e[0m\n'` shows each as an xterm.js terminal beside it does.
