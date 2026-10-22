# A draft's Save to Workspace during its autosave returns silently

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of a browser check's red at the integrated tip; closes in the round.

## What was seen

Browser check 133 (two windows on one draft) was red once in three runs at the integrated tip `f0f55578f` in the integration guest: the check pressed Save to Workspace in the draft tab's menu and its path prompt never opened within 15 s; the other two runs, and three at the warning item's tip `8dd6e600d`, passed the step. By source at that tip, `saveDraftTabToWorkspace` (`web/packages/workspace-app/src/state/tabs.svelte.ts`) first saves a dirty tab through `saveDraftEdits`, which returns false without a word whenever the tab is still dirty after `performSave` and has no save error; `performSave` returns at once for a tab whose save is already running and only marks it to save again, so a press during an autosave's write ends the action before the draft inspection that opens the prompt. The tab's live-session delegate ends it the same way when its answer is unresolved or refused, with a three-second notice only when a reason is set. The close-all path states this refusal as designed; a draft's own close and its Save from the close dialog share it. A probe at the tip with a held autosave write and a press meanwhile gives no second write and no inspection; with the write answered at once the press reaches the inspection. In the red run the check's second window had just opened the draft, and the first window's buffer was written 120 ms after the press. Which of the two refusals the red run met is not read: neither leaves a console line.

## Desired contract

A person who types in a draft and chooses Save to Workspace, or closes the draft, while its autosave or a live-session flush is running gets the prompt once the save settles, or one notice saying why the action is refused.

## What to do

`performSave` hands a caller the running save chain to await instead of returning at once; `saveDraftEdits` reads the settled state, and when it still refuses it says why in one notice. A pin red first at the parent: a press during a held autosave write reaches the inspection once the write answers (the review seat's probe). Check 133 presses only once the first window's tab is clean and no save of it runs, reading the tab's saving state from the page, so the check no longer meets the refusal by timing.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` at `performSave`, `saveDraftEdits` and `saveDraftTabToWorkspace`, their tests, and `scripts/e2e/browser-smoke/checks/133-drafts-two-windows.mjs` at the press. Not changed: the autosave's cadence, the live-session delegate's answers, the close-all refusal's wording.

## Acceptance

1. The pin red first at the parent on the inspection assertion; one mutant per guard red.
2. `make web-check` green at the commit; checks 130, 131 and 133 alone three times at the commit and once at the parent in the integration guest.
3. The row's closing section names the probe, the counts and the notice's text.
