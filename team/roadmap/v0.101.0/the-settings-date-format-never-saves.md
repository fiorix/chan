# The Settings date format never saves

Status: raised during v0.101.0 on 2026-09-25 from the first source-text test lane (`v0101/raw-tests-a`), whose mounted Settings test failed on it, and confirmed by the independent review of that lane at `main` `a83900a29`; accepted by the owner the same day and landed with that lane's second round.

## What was seen

Settings > Editor > Date format committed `(p) => ({ ...p, date_format: e.currentTarget.value })` (`EditorSection.svelte`). Settings runs a commit's mutation once to update the page, then hands it to `updateGlobalConfigSerial`, which awaits a read of the stored config and runs the mutation again on the result (`api/preferenceWrite.ts`). By then the change event has finished and `currentTarget` is null, so the second run throws, the write is refused, and the select goes back to the stored format. The debug run shows three reads and no write. No other Settings field reads the event inside a mutation.

## Desired contract

Choosing a date format in Settings saves it.

## What shipped

`EditorSection.svelte` reads the select's value into a local before `commit`, so the mutation closes over the value, not the event. The mounted test in `components/HybridEditorConfig.test.ts` that changes the format and expects the write was an expected failure on the unfixed tree and is a plain test with the fix.

## Boundaries

`web/packages/workspace-app/src/components/settings/EditorSection.svelte` and its mounted test.
