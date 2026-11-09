# A ghostty terminal keeps its old colours after a theme switch

Status: raised by the owner on 2026-11-09 and accepted for v0.128.0 the same day; not started. It touches the ghostty widget, so it lands on whichever widget is in place when it is built, before or after the [ghostty-web-ng item](chan-drives-ghostty-web-from-outside-through-its-private-internals.md).

## What is there now

Light and dark come from the Settings theme choice, the OS appearance through `prefers-color-scheme`, or the launcher's local theme in a window without a workspace, and per-surface overrides (`web/packages/workspace-app/src/state/store.svelte.ts:291-362`, `:547`, `:575`, `:897`, `:992-1002`; `App.svelte:490-499`, `:507`). A switch reaches the surfaces through Svelte reactivity and `<html data-theme>`.

A ghostty terminal takes its colours once, when it is created: `terminalTheme()` (`components/TerminalTab.svelte:817-877`) builds the background, foreground, link colour, a fixed selection colour and a 16-colour palette, ghostty-web turns them into the core's configuration at `open()`, and chan's binding writes them into libghostty-vt then (`src/terminal/ghosttyVt.ts:1004-1050`), with no way to change them later. On a switch the terminal tab assigns `term.options.theme` (`TerminalTab.svelte:802-807`, `:898-906`), and ghostty-web only logs "theme changes after open() are not yet fully supported" (`ghostty-web.js:2636-2638`); it never calls its renderer's `setTheme` and never reaches the core. So until a manual reload the terminal keeps the old default foreground and background in every unstyled cell, the old palette, cursor and selection colours, and the old canvas and scrollbar fills; only the host element's CSS background and the secret-mask colour change. The binding already redraws everything when the core's default colours or palette change (`readColors()`, `ghosttyVt.ts:1104-1120`), so a colour setter on the core side would repaint by itself. xterm.js terminals switch live (`TerminalTab.svelte:900-923`), and `components/TerminalTab.theme.test.ts` covers only them.

The editor (CodeMirror theme compartment, `editor/base.ts:77-92`, reconfigured from `editor/Source.svelte:449-452` and `editor/Wysiwyg.svelte:846-849`, with Mermaid, Excalidraw and image widgets redrawing on reconfiguration), the slide deck (`FileEditorTab.svelte:665-686`, `state/slidePreview.ts:294-309`), the Excalidraw view (`editor/ExcalidrawCanvas.svelte:780-784`) and the file browser (CSS only, `FileBrowserSurface.svelte:250`) follow a switch by reading, but no test flips any of them back and forth (`editor/ExcalidrawCanvas.test.ts` always mounts light), and no end-to-end check switches a window with all of them open.

## Desired contract

1. Switching between light and dark, by the Settings choice, the OS appearance or a surface override, repaints a live ghostty terminal completely in the new colours without a manual reload: unstyled cells, the palette, cursor, selection and fills. If the widget cannot change colours in place, it may rebuild the terminal, provided the session survives: the shell keeps running, scrollback and the screen come back, focus and the find bar's state are kept.
2. The editor (source and rich text, with their diagrams and images), the slide deck and its thumbnails, the Excalidraw view and the file browser switch back and forth any number of times, each ending in exactly the colours a fresh load in that theme has.
3. A switch changes nothing else: no lost input, no extra output in the terminal, no change of selection or scroll position beyond what a rebuild needs.

## Boundaries

- Light and dark as chan defines them; no new themes or user palettes.
- ghostty-web's own pin stays unless the ghostty-web-ng item has replaced it; a fix on today's widget goes through chan's binding and the renderer's existing `setTheme`.

## Acceptance

1. Vitest over the vendored core: after a switch the core reports the new default colours and palette, and a repaint uses them; a switch and back leaves the cells' colours as they were.
2. Mounted tests that switch twice for the source and rich-text editors, the slide deck, the Excalidraw view (mounted dark and light) and the file browser.
3. A browser check in an isolated guest: a window with a ghostty terminal running output, an editor, a slide deck, an Excalidraw file and the file browser switches light, dark and light again, compared against fresh loads in each theme; the terminal's shell is the same process before and after.
4. On chan-desktop on macOS (owner): switching the OS appearance repaints a live ghostty terminal without Cmd+R.
