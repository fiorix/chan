# A drawing in source mode whose buffer does not parse loses its editor

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised during v0.101.0 on 2026-09-27 by the code map of the JSON tab (`dev/v0101-team/int26-docs/codemaps/json-tab.md` in the development tree, question 2, "What the check's refusal looks like, everywhere it runs", and question 6), which read it at `836d2508a`, ran nothing, and marks as inferred that the typo cannot be fixed in place; read again in code at `37e9d23dd`, and not run.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended, in the owner's answer to it by its number: a refusal that keeps the editor and says that the file was not saved. The check itself stays for a drawing, by the owner's ruling on [an-attached-json-tab-skips-the-parse-check](an-attached-json-tab-skips-the-parse-check.md), which drops it for `.json` alone.

## What was seen

The workspace app refuses to save a drawing whose buffer does not parse. `performSaveOnce` in `web/packages/workspace-app/src/state/tabs.svelte.ts` checks an Excalidraw buffer as it checks a `.json` one and, when it does not parse, sets the tab's error to "JSON parse error" with the parser's message and writes nothing (`:5803-5812`; `validateJsonBuffer`, `:5866-5878`).

A drawing in source mode always takes that path. It never attaches to a document session (`isDocSyncEligible`, `state/docSync.svelte.ts:156-164`, the drawing left out at `:160`), and its scene session attaches only in canvas mode (`isSceneSyncEligible`, `state/sceneSync.svelte.ts:115-123`, the mode at `:118`), so in source mode no session answers its save before the check (`tabs.svelte.ts:5778-5788`). The autosave saves a tab whose text differs from what it saved (`src/App.svelte:266-267`) 800 ms after its last change (`scheduleAutosave`, `tabs.svelte.ts:5882-5909`; `AUTOSAVE_DEBOUNCE_MS`, `:5484`), so a pause of that length in the middle of an edit that leaves the buffer not parsing meets the check.

What the refusal does. The tab's error puts a red line on the tab's toolbar (`src/components/FileEditorTab.svelte:1280-1283`) and replaces the whole editor with a placeholder that shows the error (`:1320-1321`), so the source the user was typing leaves the screen; the map reads, as an inference, that the typo then cannot be fixed where it was made. A close saves a dirty tab first and, when the tab is still dirty after the save, returns with the tab open and says nothing of its own (`confirmCloseTabs`, `tabs.svelte.ts:2869-2893`, the save at `:2886` and the refusal at `:2892`). The way out the map found is the tab menu's "Reload from disk" (`FileEditorTab.svelte:1251-1257`, `:889-892`), which confirms that unsaved changes will be replaced by the file on disk and then adopts the file (`forceReloadFromDisk`, `tabs.svelte.ts:8000-8013`), so the buffer is lost. No test in the workspace app asserts the refusal: "JSON parse error" appears once, where the check sets it (`tabs.svelte.ts:5809`).

## Desired contract

A drawing in source mode whose buffer does not parse is still refused a save, and the refusal keeps the editor: the source stays on screen and can be fixed where the typo is, the tab says that the file was not saved and why, and the file keeps its last content that parsed.

## What to do

Keep the check's drawing arm and change what its refusal shows: not the tab's error, which replaces the editor, but a notice that the file tab shows beside the editor, with the parser's message and that the file was not saved, cleared by the next save that parses. A line on the tab's toolbar, where the error's line is today, is one place for it. A close whose save is refused says why the tab does not close; what it offers then, to keep editing or to close and discard the buffer, is the lead's ruling for the order's plan, and the buffer is lost only by the user's choice. Red first: a drawing in source mode whose buffer does not parse, saved through the production save funnel, with the editor asserted still mounted and a notice that the file was not saved; today the placeholder replaces it.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`performSaveOnce`'s drawing arm), `src/components/FileEditorTab.svelte` (what a refused save shows), and their tests. What the check accepts is unchanged. The `.json` arm's removal is [an-attached-json-tab-skips-the-parse-check](an-attached-json-tab-skips-the-parse-check.md). A drawing in canvas mode, whose scene session writes the serializer's own output, is outside.

## Acceptance

1. A drawing in source mode whose buffer does not parse, saved by the autosave, keeps its editor mounted with the buffer as typed, says that the file was not saved and why, and writes nothing; pinned red first.
2. Once the buffer parses, the next save writes it and clears the notice.
3. A close of such a tab says why it does not close, and the buffer is lost only by the user's choice.
