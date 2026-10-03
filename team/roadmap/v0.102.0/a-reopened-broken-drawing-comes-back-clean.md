# A reopened broken drawing comes back clean

Status: raised for a decision on 2026-10-03 by the builder of [a-draft-that-does-not-parse-cannot-be-discarded](a-draft-that-does-not-parse-cannot-be-discarded.md), as a residual of that build; the owner has not ruled on it. Read in the code on the v0.102.0 integration branch; not run.

## What was seen

Since that build, a draft drawing whose unsaved text does not parse can be discarded from its own dialog with nothing written first. A reopen of that closed tab mints a new diagram draft and writes the closed text into it with a direct write (`recoverClosedDraft`, `web/packages/workspace-app/src/state/tabs.svelte.ts`), which is not the save and makes no parse check. So the user's text comes back in a draft whose file does not parse and that reads clean, and its close offers Save to Workspace. Before that build no close through the draft flow could end with such a buffer.

## Desired contract

Not written yet. The choice is what a reopen owes a text the user discarded because it could not be saved: the text back, in a draft that says it does not parse; nothing; or the text back as it is today.

## What to do

Rule one of three: the reopen seeds the new draft and marks it unsaved, so its close goes through the dialog that offers Discard and Cancel; the reopen seeds nothing and the text is lost at the discard, as the dialog said; or the present behavior stays and is written down.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`recoverClosedDraft`) and its tests.

## Acceptance

1. The ruling is recorded.
2. If it changes the reopen: a reopen after the discard of a draft drawing whose text does not parse does what was ruled; pinned red first.
