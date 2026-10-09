# The standalone folder prompt for a draft with attachments has no test

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A missing test, not a defect shown. In a standalone window a draft with attachments is saved by naming a folder: `promotesByFolder` (`web/packages/workspace-app/src/state/tabs.svelte.ts`, line 3018) is true when the draft has attachments and the window has no workspace; the close flow then offers a folder target (line 3987), and `saveDraftTabToWorkspace` (from line 4075) opens the path prompt in its folder mode with the notice "This draft has attachments, so the whole draft directory is saved as a directory at the path below." In a workspace window the same draft is saved by a file path and the server makes the folder. The author's hand-back of the drafts web range names the gap twice: "A standalone window keeps the folder prompt, and no test module runs in standalone mode for it", and under its remaining gaps "no unit test module runs in standalone mode for it. Check 125 covers standalone drafts' creation, not their promotion" (`dev/v0104-team/reports/validation-Frontend104-drafts-web.md`, sections "Said plainly" and "Remaining gaps"). The review took it as "a known gap for the release report, not a defect shown" (`dev/v0104-team/reviews/review-Review104-drafts-web-range-1.md`, section "Gaps the author named, as I take them"). The closed item carries it (`team/roadmap/done/drafts-and-attachments-live-inside-the-workspace.md`, section "Landing and validation 2026-10-08", last paragraph), and the release report has it in its Known gaps and its Follow-ups (`team/release/release-v0.104.0.md`).

Read at the v0.104.0 commit, the gap is narrower than "no test module runs in standalone mode". `web/packages/workspace-app/src/state/miniDraftLifecycle.test.ts` boots a standalone window and runs four tests of a draft tab's close there (a pristine seed discarded, the default target under the home directory, a save promoting to the chosen path, a close before the first chunk); every one of them answers the draft's inspection with `has_attachments: false`, the default of the file's own helper, which takes an override. The file's history predates v0.104.0. The workspace-window cases of a draft with attachments are pinned in `state/tabs.test.ts` ("closing a draft with attachments offers a file to save to, and the save sends that file" and "explicit save of a draft with attachments asks for a file and says a folder is made from it"), a file that boots no standalone window. Five test files under `src/` set a draft's attachments flag true, in one spelling or the other (`has_attachments`, `hasAttachments`); the only one of them that names a standalone window is `api/client.test.ts`, the request client's own test, which names neither the path prompt nor the tab's close and save flows. Browser check 125 (`scripts/e2e/browser-smoke/checks/125-mini-window-drafts.mjs`) asserts, by its own header, the capability metas, the New draft command, the Rich Prompt's autosave and the files in the store; it holds no line that names a promotion, an attachment or a folder, beside 22 that name a draft.

Not established: whether the standalone folder branch works today. No test and no browser check drives it on any engine, the standalone server's side of a folder promotion was not read for this item, and no record read here shows it tried by hand. The item claims a missing test, not a failure.

## Desired contract

The standalone folder branch has a test that can fail: in a standalone window a draft with attachments is offered a folder target on close and on explicit save, the prompt opens in its folder mode with the notice, and the promotion is sent with the chosen folder.

## What to do

Add the cases to `state/miniDraftLifecycle.test.ts`, which already boots the standalone window and whose inspection helper takes a `has_attachments` override: the close flow's target kind, and the explicit save's prompt options and promote call. Show each new assertion able to fail with a mutant of `promotesByFolder` that drops its window test, so that a standalone draft with attachments takes the file path. Whether a browser check should also promote a standalone draft with an image, beside check 125, is a scope question for the lead; the record asks for the unit test only.

## Boundaries

`web/packages/workspace-app/src/state/miniDraftLifecycle.test.ts` and, if a helper is needed, `web/packages/workspace-app/src/__tests__/`. No product file changes: a defect the new test finds is reported to the lead with its reading, not repaired under this item. The workspace-window cases in `state/tabs.test.ts` are not changed.

## Acceptance

1. In a standalone window, closing an edited draft with attachments opens the close dialog with the target kind `folder`; pinned.
2. In a standalone window, an explicit save of a draft with attachments opens the path prompt in folder mode with the attachments notice, and the promotion is sent with the chosen folder; pinned.
3. Each new assertion is shown red by a mutant of `promotesByFolder` and green on the released code; or a red on the released code is reported as a defect, with what the test saw.
4. `make web-check` green at the commit in the owning guest.
