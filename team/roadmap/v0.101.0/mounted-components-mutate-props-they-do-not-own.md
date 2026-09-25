# Mounted components mutate props they do not own

Status: raised during v0.101.0 on 2026-09-25 from the second source-text test lane. Its mounted tests render components through their real parents, as the app does, and Svelte's development build warns on each line below; the lane found no test that causes a warning.

## What was seen

- `assignment_value_stale`: `ensureTabSlidePreview` returns `(tab.slidePreview ??= {...})` (`state/tabs.svelte.ts:5325`), which evaluates to the new plain object, not the proxy the tab now holds; a caller that writes through the returned object on a tab's first slide preview writes to a copy.
- `ownership_invalid_mutation`: a component writes a property of a tab it received as an unbound prop, at `components/FileEditorTab.svelte:1431` (`tab.content = json` on a canvas scene change), `components/RichPrompt.svelte:354` (`tab.richPromptDraftPath = path`) and `components/TerminalTab.svelte:1281` (`tab.pendingGlobalName = false`).

The second lane's final web-check log carries 2 and 5 such warnings.

## Desired contract

Tab state is written through the store that owns it, and the first slide preview returns the state the tab holds. A web-check log carries no Svelte ownership or stale-assignment warning.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` and the three components above.
