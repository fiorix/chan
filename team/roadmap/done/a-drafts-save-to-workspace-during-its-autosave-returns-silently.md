# A draft's Save to Workspace during its autosave returns silently

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of a browser check's red at the integrated tip; closes in the round.

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

## Lead's rulings 2026-10-22

From the lead's task to the frontend seat, 14:22Z:

- **R1, `performSave` hands the running chain to a second caller.** A call for a tab whose save is running marks `saveAgainAfterCurrent` as today and returns the running chain's promise (one stored promise per tab id beside `savingTabs`, set when the chain starts and cleared in its `finally`), so the caller's await settles when the chain ends, the follow-up write included (the `do ... while` loop already continues on the mark while the tab is dirty). The chain's rejection reaches every awaiter; `saveDraftEdits` already catches it into `saveError`. Read each other caller for the change: the ones that discard the promise keep their behaviour; one that awaits it now waits for the chain instead of returning at once, and the hand-back says for each whether that is a change in what a person sees (the close-all path at 3163 to 3170 keeps its refusal line and wording for a tab still dirty after the chain settles; say what its wait now covers). No new entry point unless a caller must not wait, in which case say which and why.
- **R2, `saveDraftEdits` says why once.** After the awaited chain, a tab still dirty with no `saveError` is refused with one notice naming the reason the tab carries: a live session's unresolved answer (the withheld save and its reason, where set), a live session's refusal, the connection-outage pause, or, with none of those, that its save did not finish. Exactly one notice per press: where the delegate already showed its three-second notice with a reason, `saveDraftEdits` adds none; where the delegate set no reason, `saveDraftEdits`'s notice is the one. Name the texts in the row (the `${tabLabel(live)} was not saved because ...` form of the existing line). The autosave's cadence, the delegates' answers and their wording are unchanged.
- **R3, the pins, red first at the base** (`tabs.test.ts`'s autosave harness; the mocked write answered by a deferred promise; no sleeps): (1) acceptance 1, the reviewer's probe: a dirty draft tab whose autosave write is held; `saveDraftTabToWorkspace` pressed meanwhile; the write then answered; the press reaches `api.inspectDraft` once and the path prompt opens; red at the base on the inspection count (0), the press having returned false with one write. (2) The close: `closeTab` on the same held tab reaches the inspection once the write answers (the draft close dialog's open, or the inspection mock's count); red at the base the same way. (3) The notice: the held tab's delegate answers `unresolved` with no reason; the press after the chain settles returns false with exactly one notice whose text is R2's; red at the base on the notice count (0). (4) One notice, not two: the delegate answering `refused` with a reason and its own notice; the press adds none; green at the base and the tip if the base already shows one, say so.
- **Mutants,** one per guard, each compiling and failing its own assertion, the source restored and hash-checked: the mark-only return restored in `performSave` (pin 1 red); the notice dropped (pin 3 red); the one-notice rule dropped (pin 4 red).
- **R4, check 133 presses once A's tab is clean and no save of it runs.** Before `saveDraftToWorkspace(A, target)` the check waits, bounded at 20 s with the state in its error, until A's active tab shows no unsaved marker (the tab strip's class for a dirty buffer; name it) and the suite's request recorder holds no pending write to the draft's route; the wait's end is logged with its span, so a run's log says how long the tab took to settle. No product change for the check. The press itself and the prompt wait in `lib/drafts.mjs` are unchanged.
- **R5, the design text:** `web/packages/workspace-app/src/design.md` at the drafts' or the saves' paragraph, one sentence in the present tense: a Save to Workspace or a close pressed while a draft's save runs waits for that save and then continues, or refuses with one notice naming why. Find the paragraph that states the autosave or the draft close today and add the sentence beside it; name its line in the hand-back.

## Built 2026-10-22

The change, in `web/packages/workspace-app/src/state/tabs.svelte.ts`:

- `performSave` keeps one running save per tab: `savingTabs` maps the tab id to the running save's promise (set when the save starts, removed in its `finally`), so the membership and the promise cannot disagree. A call for a tab whose save runs marks `saveAgainAfterCurrent` and returns that promise; the caller's await ends where the save ends, the follow-up write of the `do ... while` loop included, and a failed save rejects every caller that awaits it. The loop moved into `runSave`.
- `runSave` resolves to the hold of its last pass (`SaveHold`): `performSaveOnce` answers `"refused"` where a live session refused the buffer, `"paused"` where the save stopped at `isDocSavePaused`, and `null` on every other exit (written, a conflict, a refusal that wrote its reason).
- `saveDraftEdits` takes the hold. A tab still unsaved after the save gets one notice: the existing line with the tab's `saveError` where the save line has a reason, and otherwise the same form with `unsavedReason(held)`. No delegate shows a notice of its own: the "three-second notice" of the record is this line with a reason the delegate wrote, and the two branches are an `if`/`else`, so a press says one thing.
- `confirmCloseTabs`'s comment names what a tab still dirty after the save can be (a conflict, a reasonless refusal, an outage pause, an edit during the write); the refusal and its wording are as they were.

The notices, in the `${tabLabel(live)} was not saved because ...` form:

- the tab's reason where its save line has one, as in "draft.md was not saved because the previous live push has not been confirmed." (a live session's unresolved answer, whose withheld save writes that reason) and "draft.md was not saved because the save request failed (disk full).";
- "draft.md was not saved because its live session refused the save." (a refusal that wrote no reason);
- "draft.md was not saved because the connection to the server is down." (the connection-outage pause);
- "draft.md was not saved because its save did not finish." (none of those: the write conflict, whose prompt is open beside it, or an edit that landed during the last write).

Each caller of `performSave` and what its await changes:

- `saveDraftEdits` (a draft's close, the close dialog's Save, Save to Workspace): a press or a close during the tab's save waits for it and then inspects the draft, or refuses with the notice above. This is the item.
- `confirmCloseTabs` (the close of file tabs, one or many): a tab whose autosave runs closes once its write lands instead of the close being refused without a word. A tab still dirty after the save keeps the refusal line and its wording ("X was not saved because ... Its changes will be lost." with a reason, a refused close without one). The wait covers the running save and its follow-up write.
- `closeFileTabAfterMove` (a file tab moved to another window): a move made during the tab's autosave closes the tab here once the write lands, instead of leaving it open in both windows. A visible change, pinned.
- The conflict prompt's Overwrite (`overwriteConflictedTab`): the modal awaits nothing of the click; the click's await ends with the running save, and a failed write of that save is said on the save line by the click in the same words the save's own caller uses. Nothing a person sees changes; the design text's sentence on it says so.
- The autosave's timer (`scheduleAutosave`): a timer that fires during a running save marks it and waits for it; its catch writes the same failure text. Nothing a person sees changes.
- `recoverClosedDraft` (reopening a closed drawing draft whose text does not parse): it saves the tab it has just opened, which has no running save; if one ran, it waits for it and a failure reaches its "Reopen draft failed" notice.
- `saveTab`: no product caller; the tests' explicit save waits for a running save.

The design text, `web/packages/workspace-app/src/design.md` line 245 (the paragraph on a tab's save runs and the Overwrite write, under "What a standalone save carries"): its last sentence says the click joins a save on the wire and both callers say a failure, and the new sentence reads: "A save asked for while the tab's save runs joins that save and waits for it, the follow-up write included (`performSave` in `state/tabs.svelte.ts`), so a draft's Save to Workspace or close pressed during its autosave continues once the save ends, or refuses with one notice naming why: the reason on the tab's save line, a live session's refusal, the connection outage that paused the save, or a save that did not finish."

The evidence is under the bus's `evidence/Frontend109/drsvrf/`: the scripts with their hashes (`scripts.sha256`), and `build/` with each run's log, status and stamps.

The pins, `web/packages/workspace-app/src/state/tabs.test.ts`, describe "a draft's Save to Workspace or close while the tab's save runs": the autosave's write held by a deferred promise behind the 800 ms debounce (fake timers to fire it), or a live session kind registered once for the file whose answer each test holds, no sleeps. The press's ask for the tab's save is learned from its first read of the tab's id (the save's lookup of a running save), since the press loads the path prompt's module before it saves. Each test names its own tab, so a save left running by a failed test is not joined by the next.

The twelve pins, each red at the parent on its own assertion (the parent's `tabs.svelte.ts` with these tests):

1. "a press during the autosave's write waits for it, then asks for the draft's path" (the review seat's probe, acceptance 1): the press reaches `api.inspectDraft` once and the path prompt opens, with the held write the only write; at the parent "the press reaches the draft's inspection: expected "inspectDraft" to be called 1 times, but got 0 times", the press having returned false with one write.
2. "a press waits for the follow-up write of an edit made during the autosave's write": the edit is written second, nothing is inspected while that write is held, then the inspection and the prompt; at the parent the inspection count is 0.
3. "closing the draft during the autosave's write waits for it, then asks what to do with the draft": the close reaches the inspection and the draft's close dialog; at the parent "the close reaches the draft's inspection: ... got 0 times".
4. "closing a file during its autosave's write closes it once the write lands": at the parent "the close goes through: expected [...] to have a length of +0 but got 1".
5. "a file moved to another window during its autosave's write leaves this window once the write lands": at the parent "the moved tab is closed here: ... got 1".
6. "a press during an autosave's write that fails says the failure once": one notice, the failed request's reason.
7. "a live session that answers its save unresolved refuses the press with the withheld save's reason" (the ruled pin 3): one notice, the withheld save's reason.
8. "a live session that refuses the buffer and writes no reason refuses the press with one notice saying so".
9. "a live session's refusal that writes its reason is the press's one notice" (the ruled pin 4).
10. "a save paused by the live session's connection outage refuses the press with one notice saying so".
11. "a save that meets the write conflict refuses the press with one notice beside the conflict prompt".
12. "a press names what held the last pass of the save it joins": a live session refuses the save's first pass and the connection outage pauses its follow-up pass; one notice, the outage's line.

Pins 6 to 12 are red at the parent on the notice count, "Number of calls: 0": the press returns before the held save answers. The ruled pin 3 (an unresolved answer "with no reason") meets the withheld save's reason, which `withholdUnresolvedLiveSave` writes on the save line, so its notice is the existing line and its red at the parent comes from the wait; the new notice is carried by pins 8, 10 and 11, where the save line holds no reason. The ruled pin 4 is red at the parent the same way, since its delegate answers while the press has already returned; no delegate notifies on its own, so its one notice is the existing line with the delegate's reason. `tabs.saveHash.test.ts`'s "the refusal of a save on the wire at the click opens no prompt, nor does Overwrite's write when it meets no answer" reads the joined save's failure on the save line where it read none, the Overwrite caller's change above; the whole app suite before that update had it as its one red (7571 of 7572 in the dev tree, the clone at `10c1a1634` with the worktree's diff).

The red-green driver `redgreen.sh` (`build/redgreen-1.log`; the guest's arm logs under `/home/ubuntu/evidence/drsvrf/redgreen-1/`) ran the describe block with pins 1 to 11 at the parent's product module (11 of 11 red), at the tip (11 of 11 green) and under M1 to M8; `evidence/Frontend109/drsvrf-p1/redgreen.sh` (`drsvrf-p1/build/redgreen-1.log`) ran it with pin 12 at the parent's product module (12 of 12 red), at the tip (12 of 12 green) and under RF. Nine mutants, one per guard, each compiling, each red on its own assertion, the source restored and compared:

- M1, `performSave` answers a running save with `Promise.resolve(null)` (the mark-only return): all eleven red.
- M2, `saveDraftEdits`'s `else` notice dropped: 8, 10 and 11 red (0 calls).
- M3, that `else` dropped so both notices fire: 6, 7 and 9 red (2 calls).
- M4, `unsavedReason`'s refused line dropped: 8 red.
- M5, its paused line dropped: 10 red.
- M6, `performSaveOnce` answers a refusal `null`: 8 red.
- M7, it answers the outage pause `null`: 10 red.
- M8, `runSave` resolves `null`: 8 and 10 red.
- RF, the last pass's hold kept from the first pass (`{ const h = await performSaveOnce(t); if (held === undefined) held = h; }` in `runSave`): 12 red alone (the refusal's line where the outage's was expected).

`build/dev-4.log`: svelte-check 0 errors, and the whole app suite in the dev tree (the clone at `10c1a1634` with the worktree's diff) before the Overwrite pin's update, 7571 of 7572, that pin the one red. `build/dev-5.log`: `tabs.test.ts` and `tabs.saveHash.test.ts` after it in a shuffled order (seed 1792681723796), 304 of 304.

Check 133 (`scripts/e2e/browser-smoke/checks/133-drafts-two-windows.mjs`): before `saveDraftToWorkspace(A, target)`, `settledBeforePress` waits, bounded at 20 s with the last state in its error, until A's active tab shows no `.dirty.unsaved` marker (the tab strip's span for a dirty buffer, inside `.tabs .tab.active`) and the suite's request recorder (`ctx.pendingEvidence()`) holds no pending PUT whose `draft_id` is the kept draft's; the wait's end is marked on the timeline (`drafts133:settled-before-press`) and logged as `[drafts133] <draft> settled before the press in <n> ms`. The press and the prompt wait in `lib/drafts.mjs` are unchanged.

Browser checks, each alone, in the frontend guest from the clean private checkout (`build/seq-1.log`, each run's `build/c<check>-<arm>-<n>.log`, the suite output under `/home/ubuntu/evidence/browser-ds-c<check>-<arm>-<n>/`):

| Check | At `70a56b6a5` | At the parent `4bb044e65` |
| --- | --- | --- |
| 130 drafts-lifecycle | 3 of 3 green | 1 of 1 green |
| 131 drafts-image-promote | 3 of 3 green | 1 of 1 green |
| 133 drafts-two-windows | 3 of 3 green | 1 of 1 green |

Check 133's wait at the commit ended at its first probe in all three runs: "settled before the press in 0 ms", 0 ms and 1 ms, so in these runs A's tab was saved before the press. The parent's run, with no wait, reached the prompt: it did not meet the refusal, which is one run's absence and not evidence that the parent cannot meet it (the record's red was one run in three). The wait's two arms were shown to see a save, in two evidence-only copies of the check run from the tip as untracked files (`control/`, `build/control-2.log`): with A's PUT of the draft held 1.5 s after an edit, the probes read the unsaved marker from 0 ms, the held write from 1013 ms to 2275 ms, and the wait ended at 2527 ms and the check passed; with the PUT held 25 s, the wait ended at its 20 s bound with "timed out waiting for untitled's tab saved with no write on the wire; last seen {"unsaved":true,"writes":[...draft_id=...,"ageMs":19386}]}" and the check failed.

The gate at `70a56b6a5` in the frontend guest (`gate.sh`, `build/gate-1.log`): `VITEST_MAX_WORKERS=1 make web-check` rc 0 (15:11:25Z to 15:28:49Z; the workspace app 7574 tests in 593 files, web-shared 218, the launcher 624, profile 20) and `make e2e-check` rc 0, the web lock unchanged and the checkout clean after. The guest's cgroup across the gate and the browser runs (`build/seq-1.cgroup-before.txt`, `-after.txt`): at its memory cap with reclaim (`memory.events` max +804,946, no OOM) and 1,811 more throttled periods: contended, green.

Acceptance: (1) the probe's pin is red at the parent on the inspection count, and each guard's mutant is red; (2) `make web-check` is green at the commit, and checks 130, 131 and 133 are green alone three times at the commit and once at the parent in the frontend guest; the integration guest's runs are the landing's; (3) this section names the probe, the counts and the notices' texts.
