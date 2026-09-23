# A checkbox click writes to a document that is open read-only

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): One predicate decides whether a widget may write, checking the read-only state and the editable facet, so a checkbox cannot write to a read-only document.

## What was seen

`togglePosition` in `web/packages/workspace-app/src/editor/widgets/checkbox.ts` dispatches the `[ ]` to `[x]` change with no read-only or editable check, and `createValueSync.onDocChanged` in `editor/base.ts` writes on any document change. One click on a task checkbox therefore edits the buffer and schedules an autosave in three places where the user cannot type: a document in read mode, a file whose write bit is off, and a locked agent prompt draft. On a file the filesystem refuses to write, the failed PUT sets `tab.error` and `FileEditorTab.svelte` replaces the whole editor with an error placeholder.

Read-only is not one thing in this editor. `Wysiwyg.svelte` locks with `EditorView.editable`, while `RichPrompt.svelte` locks its composer with `EditorState.readOnly.of(locked)` and keeps `editable` true, so a check on either facet alone misses one of them. The other widgets each answer the question their own way: `widgets/wikilink.ts` and `widgets/date.ts` branch on the editable facet, `widgets/image.ts` carries its own `writable` flag, and the checkbox asks nothing.

## Desired contract

No widget dispatches a document change into a view the user cannot edit. One predicate answers "may this widget write", it checks both `state.readOnly` and the editable facet, and every widget that dispatches uses it. Whether the read-mode checkbox should instead be allowed to toggle is an open product question; until it is ruled, read-only means read-only.

## Boundaries

`web/packages/workspace-app/src/editor/widgets/` (checkbox, wikilink, date, image, and any other dispatch site a grep for `view.dispatch` finds there), one shared helper beside them, and tests. `editor/base.ts` is in scope only for the question of whether the value sync should refuse to write from a read-only view as a second line of defence.

## Acceptance

1. A test clicks a task checkbox in a view locked by `EditorView.editable`, and in one locked by `EditorState.readOnly` with `editable` true, and asserts no transaction and no scheduled save in either.
2. The same click in an editable view still toggles the box.
3. Every widget dispatch site goes through the one predicate, and a test enumerates the widget modules so a new one cannot skip it silently.
4. `editor/design.md` states the contract where it lists the widget invariants.
