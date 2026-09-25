# A mirrored value focuses an unfocused editor

Status: raised during v0.101.0 on 2026-09-25 from the second source-text test lane and confirmed in code by the independent review of that lane at `main` `a83900a29`; no live window was seen doing it.

## What was seen

The editor sync's `applyExternal` focuses the view after applying an external value unless the caller passes `{ focus: false }` (`editor/base.ts:314`), and neither caller does (`editor/Wysiwyg.svelte:771`, `editor/Source.svelte:421`), whatever the editor's `autoFocus` says. The reachable path is `mirrorToSiblings` in `state/tabs.svelte.ts`, which writes a saved file's content into its sibling editors, one of which may be mounted with `autoFocus` false (`components/FileEditorTab.svelte:1333`); that editor then takes focus from the one the user is typing in. Attached siblings are skipped, so the reach is narrow.

## Desired contract

An editor mounted with `autoFocus` false never takes focus because its value changed.

## What to do

Pass `{ focus: autoFocus }` at both call sites and pin the unfocused sibling in a mounted test.

## Boundaries

`web/packages/workspace-app/src/editor/{Wysiwyg,Source}.svelte` and their tests.
