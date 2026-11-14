# A ghostty terminal leaves a pure black background unpainted

Status: accepted for v0.130.0 by the owner on 2026-11-13; built on 2026-11-14 on the branch `v0130/ghostty-black-background` (`10b63b2d0`), not merged; the section "Built 2026-11-14" holds the evidence. Owed: acceptance 3 on chan-desktop.

Record: found by the widened terminal pixel oracle on 2026-11-12 and left as it was, so the renderer's PNGs stayed byte-identical through the renderer's rework: "RGB black backgrounds are left unpainted: `\e[48;2;0;0;0m` and `\e[48;5;16m` show the theme background; `\e[40m` paints the palette's `#0c0c0d`." (`dev/v0129/row-notes.md`, "ghosttyng: findings from the widened pixel oracle", item 1). The owner, for v0.130.0: "what i really want on v0.130 is the systemd and flush-window-edges, plus ghostty/terminal bug fixes like the one my other agent is actively fixing right now".

## What is there now

Read at `342dbe791`, and the same at v0.128.0 (`8ded1bda9`), where the renderer compared the cell's three channels with zero; not run.

- The renderer paints a cell's background only when its colour is not 0: `renderCellBackground` takes `bg === 0` for the default (`web/packages/ghostty-web-ng/lib/renderer.ts`). The binding resolves every cell's background to 0xRRGGBB, the default one included (`VtCell.bg`, `readRow` and `readHistoryRow` in `web/packages/ghostty-web-ng/vt/ghosttyVt.ts`), so 0 means pure black and, where the core's default background is black, the default too. `\e[48;2;0;0;0m`, `\e[48;5;16m` (the 256-colour table's black; chan's theme sets only the first 16 entries) and an inverse cell whose foreground is pure black all resolve to 0 and show the row's theme fill. `\e[40m` is the palette's black, `#0c0c0d` in chan's dark theme (`terminalTheme`, `web/packages/workspace-app/src/components/TerminalTab.svelte`), and paints.
- The default background reaches the core from the theme (`buildWasmConfig`, `lib/terminal.ts`; `writeColors`, `vt/ghosttyVt.ts`). In an opaque window it is the theme's colour, which default cells carry. In a see-through window chan's theme background is `rgba(..., 0)` (`transparentColor`, `web/packages/workspace-app/src/terminal/backgroundOpacity.ts`), which the widget's `parseColorToHex` reads as 0, so the core's default is black and default cells carry 0: there the zero test is what keeps default cells unpainted and the window see-through.
- By reading, white text on a pure black background under a light theme shows white on the light fill.
- The pixel harness records today's picture: pure black backgrounds in its `attrs` pattern (rows 1, 8 and 11; its comment names row 1's as left unpainted) and in its `scrollback` and `selection` patterns (`scripts/e2e/terminal-pixels/harness.mjs`).

## Desired contract

1. A cell whose background a program set paints that colour, pure black included, however it was named (an RGB value, the 256-colour table, the palette, inverse video), as xterm.js does.
2. A cell with the default background paints nothing over the row's fill: a see-through window stays see-through and an opaque one shows the theme's background.
3. Nothing else of the picture changes.

## Boundaries

- The binding's report of whether a cell's background is the default (`vt/ghosttyVt.ts`) and the renderer's background pass (`lib/renderer.ts`).
- Not here: the selection's foreground colour, underline styles, overline and blink, which the same oracle recorded.

## Acceptance

1. Tests over the real widget and core in a suite the gate runs (the app's `src/terminal/ghosttyRenderer.test.ts` paints through them): cells set with `48;2;0;0;0`, `48;5;16` and `7;38;2;0;0;0` paint `#000000`, red on today's code; a default cell paints nothing under a see-through theme and the theme's colour under an opaque one.
2. The pixel harness in a guest: against the base's PNGs, the pictures differ only at cells with a pure black background (in the `attrs`, `scrollback` and `selection` patterns), and every other pattern is byte-identical; the `attrs` comment says what it paints now.
3. On chan-desktop, light theme, in an opaque and in a see-through window: `printf '\e[48;2;0;0;0;38;2;255;255;255m black \e[0m\n'` shows white on black.

## Built 2026-11-14

One commit over `df2c44f9f`: `10b63b2d0` fix(terminal).

What changed. The binding reports whether a cell's background is the default: `VtCell.defaultBg` (`vt/ghosttyVt.ts`), true unless the cell's style names a background colour or its content is a background colour (an erase in a colour), which is when the core itself reports no background for the cell (`GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR`). `readRow` and `readHistoryRow` set it through the same helpers; a row's style cache keeps it per style. `bg` is unchanged and still holds the resolved default for a default cell. The renderer's background pass (`lib/renderer.ts`) paints every cell whose background is not the default, and an inverse cell's foreground whatever its colour; a default cell paints nothing over the row's theme fill. The text pass, the selection and the cursor are untouched. `lib/buffer.ts`'s placeholder cell takes the new field. The scenario doc's list of what the pixel references record and the harness's `attrs` comment say what is painted now.

Tests, red then green. `src/terminal/ghosttyRenderer.test.ts` gains eight cases over the real widget and the vendored core, the core's colours built by the widget's own `buildWasmConfig`, on the software canvas that keeps its pixels: one row of default cells, `48;2;0;0;0`, `48;5;16`, `7;38;2;0;0;0`, cells erased in RGB black and in the table's black, the palette's black (`40`) and an inverse default cell, painted on the screen and from the history under chan's dark and light themes, opaque and see-through (the background through `transparentColor`). At `df2c44f9f` all eight are red, at exactly the twelve pure black cells, which showed the theme fill or stayed clear; default cells, the palette's black and the inverse default cell passed there and pass now. In the binding, the frame test's core reference reads the new field from the core's own background answer for every cell of its nine screens and after a colour change, and a new test reads it on the screen and in the history over a black default, where a default and a pure black cell carry the same `bg`; both red at the base. Three mutations, each against the committed tests and restored from HEAD: the zero test put back in the renderer (the app's eight red), the style's default dropped in `applyStyle` (the app's eight and six binding tests red), and the erase's default dropped in `contentBackground` (the app's eight and two binding tests red).

Gate. `make web-check` on `10b63b2d0`, clean before and after: green.

In a guest. The pixel harness in `chan-v0130-blackbg` (WebKitGTK under Xvfb), a run at `df2c44f9f` with `--out` and one at `10b63b2d0` with `--compare` against it: 25 of 27 PNGs are byte-identical, and the two that differ are `attrs` and `scrollback`; the twins still match each other, and the xterm DOM arms fail their seam measures alike in both runs. `selection` is byte-identical: its one black cell is in a wholly selected row, whose selection background replaces the cell's. In the two, 37 cells are touched and each goes from the theme's `#1c1c1e` to `#000000`: in `attrs` row 1's `48;5;16` and RGB black samples (columns 16-17, 19-20, 28-29), row 8's `─` on RGB black (column 37; the `█` before it covers its cell), and row 11's two erases (columns 25-29 and 32-36); in `scrollback` the `48;2;0;0;0` label of a history row (view row 8) and of a screen row (view row 18). No other cell differs.

Not observed: chan-desktop under either theme and in either window (acceptance 3), a see-through window anywhere but the unit tests, and WKWebView or WebView2. The pixel patterns paint the dark opaque theme only.
