# Terminal and editor appearance: font sizes and terminal colours

Status: REGISTERED for v0.83.0, grounded 2026-08-02, ruled 2026-08-02, ready to spec.

## What

Three user-facing controls, one settings round:

- Terminal font size. Today it is the literal `14`, written into three places in `TerminalTab.svelte`, with no way to change it. It becomes one constant, then one preference, and applies to newly spawned terminals only, matching the spawn-time contract every other terminal setting already holds.
- Editor font size. Today the size is whatever the active editor theme declares. It becomes an optional preference that overrides the theme when set, and applies live.
- Terminal colours. The user picks `standard` (today's behavior: derived from the app theme, different on light and dark) or `custom`, which pins the colours outright and ignores light/dark for the terminal surface.

Sizes are absolute pixel numbers, not a delta from a zoom point. Absolute numbers are the familiar control in every editor and terminal, and the multiplicative axis already exists elsewhere: chan-desktop's webview zoom is 1.0 nominal with 0.10 steps clamped to [0.25, 5.0], persisted per window (`desktop/src-tauri/src/main.rs:4418-4420,4450,4457,4464`; `WindowConfig.zoom_level`, `desktop/src-tauri/src/config.rs:307`). A second multiplicative axis on top of it would be two zooms fighting over one surface.

## What is already known (grounding, verified 2026-08-02)

Terminal font size is a hard-coded literal in three coupled places:

- `fontSize: 14` in the ghostty branch (`web/packages/workspace-app/src/components/TerminalTab.svelte:833`) and in the xterm branch (`:900`, alongside `lineHeight: 1.2`).
- `measureXtermCellDimensions(host, fontFamily, 14, 1.2)` (`:934-938`), which computes the xterm cell box that `alignGhosttyRendererToXterm` snaps ghostty's renderer to. This third `14` is not decorative: if the two disagree, the ghostty grid misaligns. Any pref must reach all three.

Terminal font FAMILY is already a preference and already spawn-time-only, by an explicit in-code contract ("existing terminals keep their current font until session restart", `TerminalTab.svelte:800-812`, reading `preferences.terminal.font`). It sits in `ServerConfig.terminal` (`crates/chan-server/src/config.rs:42`, the type re-exported from chan-library) with `scrollback_mb`, `default_term`, `mcp_env`, `mouse_capture`, and `ghostty`, and is surfaced in `components/settings/TerminalSection.svelte`, whose every hint already says "New terminals only".

Editor sizes are theme-owned CSS variables, and the units are not uniform:

| var | base.css | github.css | word.css | google_docs.css |
| --- | --- | --- | --- | --- |
| `--chan-editor-body-size` | 16px | 16px | 11pt | 11pt |
| `--chan-editor-source-size` | 14px | inherits | 13px | 13px |
| `--chan-editor-code-size` | 0.92em | 0.85em | 0.9em | 0.9em |

Consumers: the WYSIWYG body (`editor/Wysiwyg.svelte:926`), the source view (`editor/Source.svelte:501`), and code spans and blocks, which are `em` and therefore follow the body for free. `editor/doc_dom.ts:25,54` and `editor/slide_dom.ts:79,121` copy these vars into the standalone document and slide DOM, so both follow whatever the vars resolve to.

Terminal colours are already derived, already shared across backends, and already live:

- `terminalTheme()` (`TerminalTab.svelte:521`) reads `--bg`, `--text`, and `--link` off the terminal surface host into `background` / `foreground` / `cursor`, adds a fixed `selectionBackground`, then picks one of two hard-coded 16-colour ANSI palettes from `effectiveTerminalTheme()` (`:517`, which is `effectiveHybridSurfaceTheme("terminal")`).
- Both backends consume the same object: `theme: terminalTheme()` at `:836` (ghostty) and `:905` (xterm).
- `applyTerminalTheme()` (`:577`) re-assigns `term.options.theme` on a live terminal, and an `$effect` (`:512`) already re-runs it whenever the terminal surface theme changes. Colour changes are live today; nothing new is needed to make them live.
- The surface host carries `data-theme={surfaceThemeOverride("terminal")}` (`:2192`, `state/store.svelte.ts:379`), which is what colours the padding around the canvas, the scrollbar, and the find bar. `hybrid_surface_themes.terminal` (`crates/chan-server/src/preferences.rs:71,192`, `SurfaceThemeChoice` at `:186`) is the existing per-surface light/dark override behind it.

Preference ownership is not free-form: `PATCH /api/config` resolves exactly one owner per request (`crates/chan-server/src/routes/preferences.rs:155,358,372`), and `CommitFn` (`components/settings/commit.ts`) is a single-field write, so one control writing two owners is two revisions and two broadcasts.

## Contract

Terminal font size

- Hoist the three `14`s to one module constant, then feed it from a new `ServerConfig.terminal` field beside `terminal.font`. Same owner, same section, same spawn-time hint. `measureXtermCellDimensions` takes the same value, so ghostty stays aligned to the xterm cell box.
- New terminals only. Deliberate: it matches the neighbouring settings, and it keeps live refit, PTY cols/rows renegotiation, and ghostty re-alignment out of this item.

Editor font size

- One control. It sets `--chan-editor-body-size` in px; the source view renders at that value minus 2, preserving the base/github relationship (16/14) at the default. Code sizes are `em` and follow.
- Optional, and unset means the theme wins. Left untouched, word and google_docs keep their 11pt body and 13px source and nothing about today's rendering changes. Setting a value overrides both vars in px for every theme. The control displays the theme's resolved px as its placeholder, since it cannot show "11pt" in a px field.
- Applies live. It is a CSS variable assignment; there is no spawn-time boundary to respect.
- Owner: `EditorPrefs`, beside `page_width_ratio`. Surfaced in `EditorSection.svelte` next to the existing page-width control.

Terminal colours

- A mode plus three colours: `standard` (default, exactly today's derivation) or `custom` with background, foreground, and cursor.
- Foreground is in the set even though the original note named only cursor and background. Without it, a custom dark background under app light mode renders `--text` dark-grey on dark, because `foreground` is derived from the surface theme.
- The 16-colour ANSI palette is selected by the relative luminance of the chosen background, not by the app theme. A dark background gets the dark palette, a light one the light palette. That keeps ANSI output readable without asking for sixteen more colours, and it is what "light/dark is ignored for the terminal part" has to mean for a palette that has no other source.
- Custom paints the whole terminal surface, not just the canvas. The host's resolved `data-theme` comes from the same background luminance, so padding, scrollbar, and find bar match the canvas instead of framing it in the opposite theme. While custom is on it therefore supersedes `hybrid_surface_themes.terminal`. One luminance derivation drives both the palette and the surface theme.
- The pane tab strip is out of scope: it is Pane-level and shared with editor, browser, graph, and dashboard tabs, so it cannot follow one tab's colours.
- Owner: `EditorPrefs`, beside `hybrid_surface_themes`. The two must share an owner because one supersedes the other; split across `config.toml` and `preferences.toml` they can be edited into contradiction independently. Surfaced in `AppearanceSection.svelte` under the per-surface theme rows it overrides.

Both files gain their new fields in `docs/config-reference.md` in the same commit, as `hybrid_surface_themes` already has (`docs/config-reference.md:72`).

## Rough size

Moderate, spread thin rather than deep. The terminal size is a constant hoist plus one config field. The editor size is two CSS variable assignments plus one optional pref. The colours are the real work: a mode enum, a luminance helper feeding both the palette choice and the surface `data-theme`, and three colour pickers. No new subsystem, no wire protocol, no backend behavior.

## Open

- Colour picker input shape: native `<input type="color">` versus a hex field. Nothing in the settings surface has a colour control today.
- The luminance threshold that flips the palette, and whether a background close to the boundary needs a manual palette override.
- Whether a future custom-palette editor (all 16 ANSI colours) reuses this mode enum or replaces it.
