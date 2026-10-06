# A dirty tab's first sync attach overwrites what changed under it

Status: accepted for build in v0.103.0; prompt, session lifetime and save authority are one change.

## Owner decision, 2026-10-06

Build the accepted Reload/Overwrite choice before a dirty first attach sends its buffer over a changed authority. Verify both choices, an already-open prompt, a pending classic save and reconnect, including document and drawing callers where they share the path. Keep scene-session reconciliation outside scope.

Lead scope reconciliation on the same date: the documented clean-tab half belongs to the same first-snapshot judgment: a buffer still equal to its saved base adopts the snapshot instead of pushing the old text. Source review at the launch base found that this half also needs repair, despite the earlier account below describing it as built. Preserve the real current base before snapshot bookkeeping; a stale clean flag cannot authorize overwriting intervening edits.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, by the owner's ruling of 2026-10-03 that moved it to a later version; accepted for a build.

Record before the move: accepted by the owner on 2026-10-03 for a build: see Owner ruling. Raised the same day by the builder of [a-sync-socket-closed-before-a-frame-stays-off](../done/a-sync-socket-closed-before-a-frame-stays-off.md), with a case run as a unit test. Read in the code of that item's build on the v0.102.0 integration branch; no browser was driven.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: a tab with edits of its own whose file changed under it is shown the conflict prompt at its first attach, as a classic save shows it. A rebase of the tab's edits over the snapshot is not built, since the tab does not reliably hold the text its edits were made on.

That evening the owner moved this item to a later version, as the lead recommended, with the revised ruling on [a-sync-socket-closed-before-a-frame-stays-off](../done/a-sync-socket-closed-before-a-frame-stays-off.md): the latch stays in this version, so a tab does not go from classic saves to a session and the case stays as narrow as it is today (a tab whose first dial failed after another session of the page had a frame). The conflict prompt at a dirty first attach was built once and did not land: the review found that a tab which leaves its socket to stay classic still has a session at the server for 30 seconds, which refuses a save that names no authority version. What the later version has to settle, from the three reviews of that work: what a held tab's save names and what the detached session does with it; that nothing is pushed over another writer's text unasked and an open conflict prompt is never answered by an attach; that one edit travels one channel when a classic save is on the wire at a first frame, for a drawing as for a document; a backoff when one hold follows another; a tab that carries an unanswered push; and what Overwrite does when the snapshot is itself conflicted.

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
