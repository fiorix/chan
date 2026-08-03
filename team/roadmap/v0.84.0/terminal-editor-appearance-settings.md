# Terminal and editor appearance: font sizes and terminal colours

Status: REGISTERED for v0.84.0, grounded 2026-08-02, specified 2026-08-03, ready to implement.

## What

Add three appearance controls without changing the default rendering:

- terminal font size, persisted in `server.toml` and captured whenever a
  terminal renderer is constructed;
- optional editor font size, persisted in `preferences.toml` and applied live;
  and
- custom terminal background, foreground, and cursor colours with automatic or
  manual dark/light ANSI contrast, also persisted in `preferences.toml` and
  applied live.

Untouched installations render exactly as they do now. The existing terminal
surface choice, `Inherit` / `Light` / `Dark`, remains the standard mode and is
not rewritten by custom colours.

## Verified current state

- `TerminalTab.svelte` hard-codes terminal font size `14` for ghostty, xterm,
  and `measureXtermCellDimensions`. The measurement is what aligns ghostty to
  xterm's cell grid, so all three values must remain identical.
- Terminal font family already lives in `TerminalConfig`, is exposed in
  `TerminalSection.svelte`, and is captured by a renderer rather than applied
  live to an existing mounted renderer.
- Editor themes own `--chan-editor-body-size`,
  `--chan-editor-source-size`, and an `em`-based code size. `doc_dom.ts` and
  `slide_dom.ts` copy the resolved body/code tokens into standalone document
  and slide DOM.
- `terminalTheme()` already derives background, foreground, cursor, a fixed
  selection background, and one of two exact 16-colour ANSI palettes. Both
  terminal backends consume it, and `applyTerminalTheme()` updates a mounted
  renderer live.
- The terminal surface host's `data-theme` controls the canvas surround,
  scrollbar, and find bar. Its standard source is
  `hybrid_surface_themes.terminal` in `EditorPrefs`.
- `PATCH /api/config` updates one configuration owner per request. A terminal
  colour mode and its dormant payload must therefore be one `EditorPrefs`
  value, not several independently committed fields.
- `normalizeHexColor` already exists in `state/paneColor.ts` and can provide or
  inform the shared normalization behavior.

## Contract

### Terminal font size

Add `terminal.font_size` to `TerminalConfig`:

- integer pixels;
- default `14`;
- minimum `8`, maximum `32`, step `1`; and
- clamped by both the settings UI and server-side configuration sanitizer.

The settings number field commits on blur or Enter. Its copy says the value
applies to newly constructed terminal surfaces, not newly created PTY sessions.

A renderer captures the current value at construction and feeds the same value
to:

1. ghostty `fontSize`;
2. xterm `fontSize`; and
3. the xterm cell measurement used to align ghostty.

An already mounted renderer does not resize or refit when the setting changes.
A renderer mounted later, including after reload for the same surviving PTY,
uses the new value. Switching/reconstructing a backend also counts as a new
renderer. This item does not snapshot font size per PTY.

### Editor font size

Add `editor_font_size` to `EditorPrefs`:

- optional integer pixels;
- unset by default;
- minimum `10`, maximum `32`, step `1`; and
- clamped by both the settings UI and server-side preference sanitizer.

Unset means the current editor theme remains the sole source. The control's
empty placeholder shows the active theme's resolved body size in pixels. A
`Use theme` action clears the preference.

When set to `N`, apply live:

```text
--chan-editor-body-size: Npx
--chan-editor-source-size: (N - 2)px
```

Inline and block code retain their existing `em` ratios and therefore follow
the body. The existing document and slide token-copy paths continue to
propagate the resolved body/code sizes. Setting and clearing the override must
update mounted WYSIWYG, source, document, and slide surfaces without reload.

### Terminal colour preference

The UI control is a checkbox labeled `Custom terminal colours`. Its persisted
state is one atomic `EditorPrefs.terminal_colors` object with this logical
shape:

```text
TerminalColorPrefs {
  mode: standard | custom,
  custom: optional {
    background: #rrggbb,
    foreground: #rrggbb,
    cursor: #rrggbb,
    contrast: auto | dark | light,
  },
}
```

`standard` is the default. In standard mode, rendering is byte-for-byte the
current behavior: `hybrid_surface_themes.terminal` resolves `Inherit`, `Light`,
or `Dark`; the current background/foreground/cursor derivation, selection
background, surface chrome, and exact dark/light 16-colour palettes remain
unchanged.

The custom payload is dormant while mode is standard:

- On the first custom activation, when no payload exists, snapshot the
  currently resolved standard background, foreground, and cursor. Persist
  those values with `contrast: auto`, then enable custom atomically. The
  terminal must not jump colours merely because Custom was checked.
- Unchecking Custom changes only `mode` to standard. It restores the exact
  underlying `Inherit` / `Light` / `Dark` behavior that was selected before
  custom mode and retains the payload.
- Rechecking Custom reuses the dormant payload.
- `Reset to current standard` re-resolves the current underlying standard
  colours, replaces all three custom values, and resets contrast to `auto`.
  This works while custom mode is active without mutating the underlying
  surface-theme selection.

Each colour exposes a native swatch and a synchronized hex field. Accept
`#rgb` and `#rrggbb`, case-insensitively, and persist lowercase `#rrggbb`.
Invalid text displays validation but does not alter the active colour or
persist any part of the object. A server patch validates the complete object
atomically; no partial colour update is possible.

### ANSI contrast and surface chrome

`contrast: auto` is the default. Convert the custom background's sRGB channels
to linear values and compute WCAG relative luminance:

```text
c_linear = c <= 0.04045
  ? c / 12.92
  : ((c + 0.055) / 1.055) ^ 2.4

L = 0.2126 R + 0.7152 G + 0.0722 B
```

Use the existing light-background palette when `L > 0.179`; otherwise use the
existing dark-background palette. The threshold is fixed, not theme-derived.

Manual `dark` forces the existing dark-background palette and dark terminal
surface chrome. Manual `light` forces the existing light-background palette
and light terminal surface chrome. The same resolved contrast choice drives
the terminal host's `data-theme`, so padding, scrollbar, find bar, and canvas
remain one surface.

While custom mode is active, this resolved contrast supersedes
`hybrid_surface_themes.terminal` for the terminal surface only. It never
modifies that preference. The pane tab strip is shared by other surface kinds
and does not adopt terminal colours.

Custom mode replaces only background, foreground, and cursor. The current
selection background and both exact 16-colour ANSI palettes are retained. A
full custom ANSI palette is not part of this item.

## Persistence and failure semantics

- `terminal.font_size` belongs to `TerminalConfig` and `server.toml`.
- `editor_font_size` and the whole `terminal_colors` object belong to
  `EditorPrefs` and `preferences.toml`.
- Defaults/unset fields preserve current appearance on existing configuration
  files.
- Size values outside their ranges clamp before broadcast and persistence, so
  every client observes the stored value.
- An invalid terminal-colour patch returns a field error and leaves the prior
  object and active terminal theme untouched.
- The first-activation snapshot and later mode changes are each one
  `terminal_colors` owner write. Do not split a visible transition across
  several config revisions.

## Implementation shape

Configuration and API:

- add the defaulted/clamped terminal field in
  `crates/chan-library/src/config.rs`;
- add the optional editor size and terminal-colour types/defaults in
  `crates/chan-server/src/preferences.rs`;
- validate, normalize, and sanitize them in
  `crates/chan-server/src/routes/preferences.rs`; and
- document both TOML owners, defaults, bounds, and custom object fields in
  `docs/config-reference.md`.

Settings UI:

- put terminal font size beside font family in `TerminalSection.svelte`;
- put editor font size and `Use theme` in `EditorSection.svelte`; and
- put `Custom terminal colours`, the three swatch/hex pairs, contrast control,
  and reset action in `AppearanceSection.svelte` below the standard per-surface
  theme controls.

Rendering:

- replace the three terminal `14` literals with one captured renderer option in
  `TerminalTab.svelte`, including the raw-source test that currently pins the
  literals;
- resolve custom colours and contrast once in the terminal theme path, then
  feed both backends and the surface `data-theme` from that result; and
- set/clear the two editor CSS overrides above the active theme while retaining
  the existing `doc_dom.ts` and `slide_dom.ts` token propagation.

Share hex normalization and luminance helpers instead of duplicating them in
the controls and renderer.

## Acceptance checks

Configuration and unit tests must prove:

- terminal default `14`, editor default unset, round-trip serialization, and
  UI/server clamping at every boundary;
- all three terminal font consumers use one captured value;
- a mounted xterm or ghostty renderer stays at its captured size, while a newly
  constructed renderer for the same PTY uses the current setting;
- editor `20` produces body/source `20px`/`18px` live, and `Use theme` restores
  the theme's exact variables;
- standalone document and slide DOM receive the overridden body/code tokens;
- first Custom activation has no visual jump, off restores the prior
  `Inherit` / `Light` / `Dark` result, and later on restores dormant values;
- reset recaptures current standard values and restores `auto`;
- `#rgb`/`#rrggbb` normalize to lowercase six-digit form and invalid input
  cannot partially commit;
- relative luminance on both sides of `0.179` selects the expected existing
  palette/chrome, with manual Dark/Light overriding it; and
- standard mode preserves the exact existing background/foreground/cursor,
  selection background, and both 16-colour palette constants.

Add two focused real-browser smokes:

1. Terminal: mount xterm and ghostty terminals, change font size, prove mounted
   renderers do not refit, then reconstruct them and prove both use the new
   value and remain cell-aligned. Activate Custom, edit all three colours and
   contrast live, uncheck it, and prove the exact prior standard surface
   returns.
2. Editor: set `20`, prove mounted WYSIWYG/source render at `20`/`18`, open
   document and slide surfaces, then choose `Use theme` and prove all surfaces
   return to the active theme without reload.

## Boundaries

- No terminal font-size live refit or PTY cols/rows renegotiation.
- No per-PTY font-size preference.
- No editor zoom multiplier; sizes are absolute pixels.
- No custom selection colour or 16-colour ANSI editor.
- No pane tab-strip recolouring.
- No change to desktop webview zoom.
