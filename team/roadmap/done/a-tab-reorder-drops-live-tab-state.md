# A tab reorder silently drops live tab state

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Cloning a tab keeps every field unless the code names it as a deliberate drop, with a test that fails when a new field is undecided.

## What was seen

`cloneTab` in `web/packages/workspace-app/src/state/tabs.svelte.ts` rebuilds a tab from a hand-maintained object literal per tab kind, and every reorder, cross-pane move and Hybrid Nav commit goes through it. The literal has fallen behind the `Tab` type, and it fails open: a field it does not name is dropped without a sound. An ordinary drag-reorder of a terminal tab strips its shell profile, its keyboard protocol, its Rich Prompt draft path and its pending Team Work configuration out of live state and out of the persisted session.

The file records the pattern repeating: the browser branch's own comment says its selection, expansion and scroll fields were added only after that exact loss was reported.

## Desired contract

Cloning a tab keeps every field unless the code names it as a deliberate drop. A field added to a tab type later is carried by default, and forgetting to decide is a test failure, not a user report.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` and its tests (`state/tabs.test.ts`, `state/paneModeStaging.test.ts`, `components/perTabInspectorWidth.test.ts`). One trap: the review suggests `{...$state.snapshot(src)}`, and a snapshot copies `keyboardProtocol` by value, which reintroduces the Shift+Enter regression the comment in `components/TerminalTab.svelte` says was already fixed once. That field stays shared by reference. The deliberate drops today are `find`, `caretCommand` and `loadProgress`.

## Acceptance

1. A test builds one tab of each kind with every optional field set to a distinguishable value, runs it through `reorderTab` and through `enterPaneMode()` plus `commitPaneMode()`, and asserts deep equality with the source except for the named drops.
2. `tab.keyboardProtocol` is the same object before and after a clone.
3. A type-level exhaustiveness check makes a new `Tab` field without a carry-or-drop decision a compile error.
4. The persisted session after a reorder carries the terminal's profile, draft path and Team Work configuration.
