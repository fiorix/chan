# Select popups paint light in the dark theme off macOS

Status: raised by the owner on 2026-10-30 on the Linux desktop; accepted for v0.117.0; built on `v0117/terminal-opacity` the same day (the section Built); the owner's reading on Linux is pending.

## What was asked

The owner, on the non-macOS desktop: "in the settings window, for example, the drop downs are painted light, not dark, even tho the rest of the forms are in dark mode; some css is missing.. you can observe this on the terminal settings, editor settings, settings where we have drop downs".

## Evidence

Read at `c4fb67c31`.

- The closed select box is styled by the page: `SettingField.svelte` gives every nested `select`, text and number input `background: var(--bg)`, `color: var(--text)` and the theme border, so the box itself reads dark. The list that drops down is not the page's: WebKitGTK and WebView2 draw it themselves, as they draw native scrollbars, number spinners and the colour swatch, and colour it from the CSS `color-scheme` property of the element, which no stylesheet in the workspace app or the launcher declared (the only use was the slide export's generated DOM, `editor/slide_dom.ts`). Without it the engine assumes `normal`, which is light.
- WKWebView on macOS colours those controls from the OS appearance, which is why the macOS desktop never showed it.
- The dark palette sits on `:root` and on `[data-theme="dark"]` and the light one on `[data-theme="light"]` (`App.svelte`); a Hybrid surface re-applies a palette on its own subtree through the same attribute. The launcher's `styles.css` has the same two roots. `color-scheme` is an inherited property, so one declaration per palette block reaches every control under it.

## Desired contract

- Every control the engine paints itself (a select's popup list, scrollbars, number spinners, the colour swatch, the range track where the engine owns it) paints in the scheme of the palette it sits in: dark under the dark palette, light under the light one, and a Hybrid surface's own theme on its subtree, on WebKitGTK and WebView2 as on WKWebView.
- Nothing else moves: the page's own colours, the see-through terminal (a transparent window's page still reads through below 100), the launcher's look.

## Boundaries

`web/packages/workspace-app/src/App.svelte` (the two palette blocks), `web/packages/launcher/src/styles.css` (its two roots), `web/packages/workspace-app/src/design.md`. Not changed: the controls' own styling, the desktop's static pages (no native controls there).

## Acceptance

1. In a real engine the document root's computed `color-scheme` is `dark` under the dark theme and `light` under the light one, and a `select` inside a Hybrid surface set to the other theme computes that surface's scheme.
2. In the Linux rig a transparent window at 80 still reads through its terminal body with the scheme declared (the engine's default background does not come back under the page).
3. The owner, on the Linux desktop: the drop-downs in Settings (terminal font, editor date format, screen lock theme, semantic model) open dark, and the launcher's forms too.

## Built, 2026-10-30

`App.svelte` declares `color-scheme: dark` in the palette block shared by `:root` and `[data-theme="dark"]` and `color-scheme: light` in the `[data-theme="light"]` block; the launcher's `styles.css` declares the same on its two roots. Nothing else changed: the controls keep their own styling, and the slide export's generated DOM keeps the declaration it already had.

Checks, 2026-10-30, Linux: in Chromium (the host's Chrome through puppeteer-core) against the workspace app served by the built debug `chan`, the root's computed `color-scheme` reads `dark` under the dark theme and `light` once `data-theme` is set to light, and a `select` inside a surface carrying the other theme computes that surface's scheme in both directions (`darkSurfaceSelectUnderLight: dark`, `lightSurfaceSelectUnderDark: light`). In the Linux rig (WebKitGTK), a standalone terminal window of a fresh-home desktop at `terminal.background_opacity = 80` built from the change reads the wallpaper through its terminal body as before the change (mean (26.7, 26.8, 28.8), the 80 percent blend over the theme's (28, 28, 30), standard deviation (0.5, 1.9, 2.4)), so the engine's default background does not come back under the page with the scheme declared. `make web-check` green (workspace app 611 files and 7927 tests, launcher 696, shared 234, profile 20, both production builds). Not read: the drop-down lists themselves, which no tool on the host can open (the owner's eye on the Linux desktop), and WebView2.
