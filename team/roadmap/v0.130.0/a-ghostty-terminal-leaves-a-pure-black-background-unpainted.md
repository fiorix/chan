# A ghostty terminal leaves a pure black background unpainted

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

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
