# Hybrid Nav staged editor chips and stale-layout safety

Status: REGISTERED for v0.84.0, grounded 2026-08-02, specified 2026-08-03, ready to implement.

## What

Hybrid Nav queues `n` (new draft) and `i` (new diagram) outside the draft
layout because the server does not allocate their paths until commit. Unlike a
staged terminal, browser, graph, or dashboard, those queued intents have no
visible tab chip and cannot be removed individually.

Hybrid Nav also needs a collaboration boundary. If the shared layout changes
while a local draft is open, committing that draft can overwrite newer work.
The transaction must become stale, refuse commit, and require Escape to discard
the local draft before the newest shared layout is applied.

This item makes queued editors visible and makes the whole Hybrid Nav
transaction fail closed on a conflicting layout change.

## Verified current state

- `paneMode.draft` in
  `web/packages/workspace-app/src/state/tabs.svelte.ts` holds staged layout and
  tab changes. `paneModeStagedTabIds()` lets `Pane.svelte` render those real
  draft tabs with the existing dimmed, dashed `.tab.staged` style.
- New drafts and diagrams instead append `{ paneId, side, kind }` to
  `paneMode.stagedDraftEditors`. They do not enter the layout and therefore do
  not render in the tab strip.
- `materializeStagedDraftEditors()` in `App.svelte` creates each file through
  the API and then calls `openInPane`. The server owns collision-safe file
  naming, so no final path exists while the intent is staged.
- `commitPaneMode` and `cancelPaneMode` both clear the editor-intent queue.
- During active Pane Mode, `reconcileLayout` currently reports divergence for
  an incoming shared layout. `applyRemoteSessionBlob` then schedules the local
  layout to be saved back. That can replace the collaborator's newer layout
  instead of protecting either transaction.
- `.pane-mode-preview` in `Pane.svelte` is already an always-visible strip in
  every pane while Hybrid Nav is active. `PaneModeHelp` is optional and can be
  toggled with `h` / `H`, so it cannot be the only stale warning.
- Shared layout application already preserves this client's focus/active
  markers when their targets still exist. Stale handling must retain that
  per-client focus rule.

## Contract

### Transaction state

Pane Mode gains explicit stale state and one optional pending remote session
blob. At mode entry, the live layout is the comparison baseline. While the mode
is active, an incoming authoritative change is conflicting when it changes any
of these domains:

- pane inventory, nesting, split direction, or split ratios;
- tab inventory, order, pane placement, or Hybrid side placement;
- active pane, active side, or active tab; or
- a terminal tab's authoritative live name or group.

These do not make the transaction stale:

- editor caret or scroll position;
- inspector state;
- graph selection;
- dashboard rotation;
- terminal output;
- file content; or
- surface appearance and theme preferences.

Implement the decision as one named semantic comparator rather than serialized
blob equality. Tests must pin every included and excluded field so later
session-blob additions do not silently widen the conflict domain.

On the first conflict:

1. mark Pane Mode stale permanently for this transaction;
2. retain the incoming session blob as the pending remote layout;
3. do not reconcile, rebase, commit, or save the local draft back; and
4. keep accepting incoming shared blobs only by replacing the pending value,
   so the newest snapshot wins.

No intermediate snapshot is replayed. A semantically non-conflicting update
continues through ordinary reconciliation and does not poison the transaction.

A server-authoritative terminal rename or group change can arrive through the
terminal roster rather than a session blob. Apply that live metadata to the
authoritative tab immediately, then mark Pane Mode stale if it differs from the
entry baseline. It does not synthesize a pending layout. If a remote session
blob is also pending, that blob still follows the newest-only rule.

### Stale interaction

While stale:

- the focused pane's always-visible `.pane-mode-preview` shows exactly
  `Layout changed. Esc to discard.`;
- staged tabs and staged editor chips remain visible but gain the stale/dimmed
  treatment;
- Enter and every navigation or mutation action are inert, including chip
  removal by keyboard or pointer;
- `h` / `H` may still toggle help; and
- Escape is the only exit.

Escape runs the normal cancellation cleanup, including staged terminal
cleanup, without materializing any draft or diagram. It then applies the newest
pending remote layout, if present. Application retains the established
per-client focus rule: keep this client's active targets when they still exist,
otherwise fall back through the existing reconciliation behavior.

Stale state cannot clear because a later remote snapshot happens to resemble
the baseline. The user must discard the transaction.

### Staged editor chips

Each queued draft/diagram intent receives a stable client-only id. In each
pane/side tab strip, render matching intents after real tabs, in queue order,
using the existing staged visual language:

- draft label: `New draft`
- diagram label: `New diagram`

The chip is a projection of the queue, not a synthetic tab. It never enters
`paneMode.draft`, session persistence, active-tab selection, or staged-terminal
cleanup.

In a healthy transaction, each chip has a close affordance that removes only
that intent by id. The chip has no selection behavior. In a stale transaction,
the affordance remains visible with the chip but is disabled because Escape is
the only allowed mutation.

### Healthy commit and materialization

On Enter in a non-stale transaction:

1. snapshot the staged editor-intent queue;
2. commit the draft layout immediately;
3. start every draft/diagram creation request independently and in parallel;
4. open each successful result in its recorded pane and side; and
5. report each failed request independently.

Use all-settled semantics. One API failure does not cancel siblings, roll back
the committed layout, delete a successful file, or close a successful editor.

The pane target is resolved after each create request returns. If its recorded
pane or side no longer exists, keep the created file and open it in the
then-current active pane/side. Show the transient message
`Target pane disappeared; opened here.` Never delete or orphan a successfully
created file because its staged destination disappeared.

## Implementation shape

In `state/tabs.svelte.ts`:

- give `PaneModeStagedDraftEditor` a stable intent id;
- expose a per-pane/side queue projection and remove-by-id operation;
- add stale state, the semantic conflict comparator, and newest-only pending
  remote layout storage;
- make commit/cancel reset all three; and
- ensure terminal-roster reconciliation can mark the active transaction stale
  without reverting authoritative live metadata.

In `components/Pane.svelte`:

- append the projected intent chips after `visibleTabs`;
- reuse `.tab.staged`, add the disabled stale treatment, and wire remove-by-id;
  and
- put the persistent warning in the focused pane's `.pane-mode-preview`.

In `state/store.svelte.ts`:

- replace the active-Pane-Mode save-back behavior with semantic conflict
  detection and newest-only queuing; and
- after cancellation, apply the pending layout through the existing remote
  reconciliation path so focus preservation is not reimplemented.

In `App.svelte`:

- gate the Pane Mode keyboard dispatcher at its top while stale; and
- snapshot, commit, and materialize editor intents with independent parallel
  results and the target-disappearance fallback.

Do not introduce a server transaction, a merge protocol, or a second draft
layout representation.

## Acceptance checks

Focused SPA tests must cover:

- multiple draft/diagram chips, labels, queue order after real tabs, stable
  keyed rendering, individual removal, no selection, and stale disabling;
- each included conflict field and each excluded transient field;
- first-conflict permanence, newest-only pending replacement, no local
  save-back, and Escape ordering;
- stale key gating, including inert Enter and pointer/keyboard removal, with
  only Escape and `h` / `H` active;
- authoritative terminal name/group reconciliation marking the transaction
  stale without losing the settled metadata;
- successful cancellation cleanup and preservation of existing per-client
  focus behavior when the newest remote layout applies;
- parallel all-settled creation with mixed successes/failures; and
- fallback to the then-current pane/side when a recorded target disappears,
  including the transient message and preservation of the created file.

Add a real two-window co-view smoke against the same `?w=` session:

1. Window A enters Hybrid Nav and stages at least one draft/diagram.
2. Window B changes the shared pane or tab layout, then changes it again.
3. Window A shows the persistent stale warning and dimmed staged chips.
4. Enter and another mutation in A do nothing and create no draft file.
5. Escape discards A's transaction and applies only B's newest layout.
6. Repeat with terminal output and a file-content change and prove neither
   makes Hybrid Nav stale.

The terminal rename/group end-to-end smoke must also assert that a roster
metadata change stales an open Hybrid Nav transaction.

## Boundaries

- No automatic rebase, three-way merge, or conflict-resolution UI.
- No commit-anyway escape hatch after a conflict.
- No shared focus semantics; existing per-client focus preservation remains.
- No file creation before a healthy Enter commit.
- No synthetic editor tab or guessed draft filename during staging.

## Implementation evidence

- `cbb30eb9` adds the fixed entry snapshot, permanent stale state, newest-only pending layout, and the named semantic comparator. Its declarative field sets include layout structure, ratios, tab order and placement, focus/active markers, file and extension identity, and authoritative terminal name/group/session identity. They exclude caret and inspector state, graph/browser/dashboard transients, terminal interaction state, and appearance fields. A runtime closed-partition test spans split/leaf nodes and all eight serialized tab kinds, while `Record<keyof ...>` sentinels make a newly typed field fail until it is classified.
- The same commit screens remote session blobs before echo dedupe, cancels any pending local save on conflict, and reuses the normal reconciliation path after Escape. Cancellation closes draft-only terminal sessions first, resets Pane Mode and queued editors second, then hands the newest pending layout to the store. Tests prove first-conflict permanence, replacement by every later snapshot, and preservation of the local focus target while the newest remote ratio applies.
- Settled terminal roster name/group changes update the live tab first and then stale an active transaction without manufacturing a pending session layout. A one-sided missing terminal session id is normalized as attach settlement; two different settled ids remain a conflict.
- `e44f4577` gives every queued draft/diagram a stable client-only id and projects matching intents after real tabs in pane/side queue order. Chips use the exact `New draft` and `New diagram` labels, have no tab-selection semantics, remove only by id while healthy, and remain visible but disabled/dimmed when stale. Stale panes also disable pointer mutations and show `Layout changed. Esc to discard.` only in the focused preview.
- Healthy Enter snapshots the queue, commits the layout, and then starts one independent creation promise per intent under `Promise.allSettled`. Each success resolves its recorded destination after creation; a missing target falls back to the then-current destination with `Target pane disappeared; opened here.` Failures are reported by kind without cancelling siblings or rolling back the committed layout.
- `e44f4577` also adds browser smoke 123. Two clients share one `?w=` session: the collaborator writes two successive layouts, the local transaction remains frozen with zero create requests, and Escape applies only the three-pane newest layout. A second transaction accepts terminal output and editor content without staling, while a real terminal WebSocket rename/group settlement through the roster does stale it.

## Validation evidence

- `npx vitest run src/state/paneModeConflict.test.ts src/state/paneModeStaging.test.ts src/state/reconcileLayout.test.ts src/state/sessionSync.test.ts src/state/tabs.test.ts src/components/paneModeKeymap.test.ts src/components/newDraftCmdN.test.ts` passed 386 tests across 7 files. This includes the closed field partition, included/excluded comparisons, newest-only deferral, no save-back, cancellation ordering, focus preservation, roster metadata, stable ids, queue projection/removal, stale key allowlist, all-settled source contract, and destination fallback source contract.
- `npx vitest run --reporter=verbose src/components/Pane.test.ts -t 'Pane staged editor chips'` passed 3 mounted component cases. They cover queue order after a real tab, stable keyed DOM identity, individual removal without selection, stale dimming/disabled removal, and the exact warning.
- Workspace-app `npm run check` passed with 0 errors and 0 warnings. Scoped `git diff --check`, `git diff --cached --check`, Prettier for the new smoke, and `node --check scripts/e2e/browser-smoke/checks/123-hybrid-nav-stale.mjs` passed.
- With fresh `TMPDIR` and output directories under `$HOME`, `SMOKE_SKIP_BUILD=1 SMOKE_ONLY=123 node scripts/e2e/browser-smoke/run.mjs` passed in 26.576 seconds. Results are at `/home/fiorix/.cache/chan-smoke-out/hybrid.2if0ot/results.json`. The first run exposed only an over-strong editor-visibility assertion after cancellation; the final smoke asserts the collaborator accepted the content update and that the open transaction remained healthy, while existing smoke 50 owns cross-client editor convergence.
- `make shell-check workflow-check` passed. `make web-check` passed launcher Svelte checks and 312/312 launcher tests, then workspace-app Svelte checks with 0 errors and 0 warnings. Its broad workspace Vitest run exposed unrelated peer-owned failures in `src/editor/widgets/diagram.test.ts` and `src/components/teamBootstrapOrchestrator.test.ts`; it was stopped under the shared-tree isolation ruling rather than reported green. The lead owns the final integrated gate on a committed isolated tip.
- Mixed create success/failure and target disappearance were not injected through the browser. Their focused checks are source-contract tests that pin independent promise construction, `Promise.allSettled`, per-entry error handling, post-response destination resolution, and the exact fallback message. Smoke 123 verifies the complementary safety property that stale Enter issues no create request. No full `make pre-push` was run in the shared worktree.
