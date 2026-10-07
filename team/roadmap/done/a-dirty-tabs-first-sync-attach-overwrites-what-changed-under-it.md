# A dirty tab's first sync attach overwrites what changed under it

Status: shipped in [v0.103.0](../../release/release-v0.103.0.md).

Record before the release: implemented and independently accepted as a component in v0.103.0; the combined gate passed at the candidate `7fa1676c3` (whole `make ci-linux`, including the four-suite symlinked-temp arm and the Windows GNU target lint), and the same-commit browser matrix passed at `7fa1676c3`: the whole 52-check run, every check alone and five ordinary check 123 runs, independently confirmed as exported.

## Owner decision, 2026-10-06

Build the accepted Reload/Overwrite choice before a dirty first attach sends its buffer over a changed authority. Verify both choices, an already-open prompt, a pending classic save and reconnect, including document and drawing callers where they share the path. Keep scene-session reconciliation outside scope.

Lead scope reconciliation on the same date: the documented clean-tab half belongs to the same first-snapshot judgment: a buffer still equal to its saved base adopts the snapshot instead of pushing the old text. Source review at the launch base found that this half also needs repair, despite the earlier account below describing it as built. Preserve the real current base before snapshot bookkeeping; a stale clean flag cannot authorize overwriting intervening edits.

## Implementation and evidence, 2026-10-06

The component range `cd53294cf..32ce59c06`, integrated as `d95272dcf..0478909af`, implements clean adoption and the dirty first-attach choice, with product changes through source `b19817922` (integration `1528dd873`) and only browser-fixture corrections after it. The session retains the saved base, receives peer updates while it holds local edits, and keeps classic saves out. Reload takes the latest received authority without committing the discarded input; Overwrite uses the existing collaboration channel and current shadow version. Cancel leaves the hold in place without reopening its modal on each edit. Acquisition waits for an in-flight classic save for both document and drawing callers; scene reconciliation is unchanged.

The author's complete frontend gate at `b19817922` passed, including 6,360 workspace-app tests. Independent review ran the ordered regression cases and mutations; the corrected focused suites passed 101 document and 128 scene tests, and the previously surviving peer-before-editor mutation failed after its assertions were repaired. The review accepted the component, then closed its remaining browser finding from the final check 67 artifacts at `32ce59c06`.

Check 67 passed its clean, Reload, Overwrite and reconnect arms in one final-tip headless Chrome 154 run on Linux, with screenshots and editor, peer, disk and socket observations. Held arms sent no document push or observed file PUT; Overwrite sent exactly one push against version 1. The reconnect arm closed the first document socket from inside the page, refused dials for 3.5 seconds, and completed the choice on a framed second socket. It proves that induced reconnect path, not a physical network outage. Its file-PUT observer starts after the classic refusal used to prepare the tab, and its editor reader uses a CodeMirror internal. Six earlier fixture failures are retained; the preceding fixture tip also passed. This is not a stability series.

The unit tests alone cover Cancel followed by editing, a peer update before the editor binds, a disk reload during the hold, a throwing commit hook and two held tabs. WebKit and the whole browser suite with this check are not established by this component result. Combined-candidate checks remain the lead's responsibility. Local evidence is in `dev/v0103-team/reports/browser-check-DocSync103-1.md`, `tasks/task-DocSync103-Lead103-16.md`, and `reviews/review-Review103-DocSync103-range-1.md` under that coordination root.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, by the owner's ruling of 2026-10-03 that moved it to a later version; accepted for a build.

Record before the move: accepted by the owner on 2026-10-03 for a build: see Owner ruling. Raised the same day by the builder of [a-sync-socket-closed-before-a-frame-stays-off](a-sync-socket-closed-before-a-frame-stays-off.md), with a case run as a unit test. Read in the code of that item's build on the v0.102.0 integration branch; no browser was driven.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: a tab with edits of its own whose file changed under it is shown the conflict prompt at its first attach, as a classic save shows it. A rebase of the tab's edits over the snapshot is not built, since the tab does not reliably hold the text its edits were made on.

That evening the owner moved this item to a later version, as the lead recommended, with the revised ruling on [a-sync-socket-closed-before-a-frame-stays-off](a-sync-socket-closed-before-a-frame-stays-off.md): the latch stays in this version, so a tab does not go from classic saves to a session and the case stays as narrow as it is today (a tab whose first dial failed after another session of the page had a frame). The conflict prompt at a dirty first attach was built once and did not land: the review found that a tab which leaves its socket to stay classic still has a session at the server for 30 seconds, which refuses a save that names no authority version. What the later version has to settle, from the three reviews of that work: what a held tab's save names and what the detached session does with it; that nothing is pushed over another writer's text unasked and an open conflict prompt is never answered by an attach; that one edit travels one channel when a classic save is on the wire at a first frame, for a drawing as for a document; a backoff when one hold follows another; a tab that carries an unanswered push; and what Overwrite does when the snapshot is itself conflicted.

## What was seen

A document tab that joins a sync session for the first time, on an editor with no collab installed, pushes the difference from the session's snapshot to its own buffer as its own edit (`tryAttach`, `web/packages/workspace-app/src/state/docSync.svelte.ts`). When another writer, a peer's save, an agent or git, changed the file after the tab loaded it, and the tab holds edits of its own, the snapshot carries the other writer's change and the push undoes it. A tab that loaded "hello", typed "!" and attaches over a snapshot of "hello there" leaves "hello!" at the authority: " there" is gone, with no prompt.

The classic path asks in the same state: a save sends the load's token, the server answers 409 with `write_conflict`, and the tab opens the conflict prompt with Reload and Overwrite; nothing is written until the user picks.

The tab's saved text cannot serve as the base of a rebase there. The session writes every snapshot into it ahead of the attach, a session with no editor does so at each socket's snapshot, and a classic save in a degraded window moves it to the buffer. A rebase over a wrong base applies a change twice where both sides hold it.

A tab with no edits of its own is the other half, built with the latch's item: it takes the snapshot.

## Desired contract

A tab with edits of its own that attaches for the first time over a snapshot that differs from the text it loaded pushes nothing unasked. The user is shown the conflict prompt, and the authority keeps the other writer's change until the user picks.

## What to do

Red first: the case above, asserting what the authority holds and that the prompt is open. A dirty tab's attach compares the snapshot with the text the tab loaded, which the session keeps for the clean tab's rule; where they differ it opens the conflict prompt in place of the push. Reload takes the snapshot and Overwrite pushes the buffer. A dirty tab whose loaded text equals the snapshot attaches as it does today.

## Boundaries

`web/packages/workspace-app/src/state/docSync.svelte.ts` and the conflict prompt's callers in `web/packages/workspace-app/src/state/tabs.svelte.ts`, with their tests. The scene session is not in this: a board's first snapshot is reconciled element by element.

## Acceptance

1. A dirty tab that attaches over a snapshot differing from its loaded text shows the conflict prompt, and nothing is pushed until the user picks; pinned red first on what the authority holds.
2. Reload and Overwrite each end with the tab attached and the buffer, the saved text and the authority in agreement.
3. A dirty tab whose loaded text equals the snapshot, and a clean tab, attach as they do today.
