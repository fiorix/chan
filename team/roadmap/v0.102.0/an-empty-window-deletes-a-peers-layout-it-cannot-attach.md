# An empty window deletes a peer's layout it cannot attach

Status: raised on 2026-10-04 by an independent review of a Frontend range on the v0.102.0 integration branch, which read that a window holding no layout answers a co-viewer's layout it cannot attach by deleting the blob they share; ruled by the lead that day a defect with one defensible fix under the team's rule for a discovery, for a build on the branch; the owner has not ruled on it and reviews it on the branch and in the lead's rulings. Read in the code; nothing here was run.

## Owner ruling

Not yet put to the owner.

## What was seen

Every line in this item is cited at f23f7c77b. Two windows on one window id share one session blob, and each reads the other's save back and reconciles it onto its live layout (`applyRemoteSessionBlob` and `applyRemoteSessionLayout` in `web/packages/workspace-app/src/state/store.svelte.ts`, 3432-3463 and 3465-3484). A sync never spawns a terminal: a terminal in the peer's blob that carries no session id, and that finds no live terminal here to pair with, is skipped, and the reconcile answers "diverged" (`web/packages/workspace-app/src/state/tabs.svelte.ts`, the ordinal pairing at 7840-7846, the skip at 8019-8023, the result at 7725). A peer writes such a blob when its save fires while a terminal has no session id: the id is written only when the tab holds one (`tabs.svelte.ts` 6923-6925), and a window with no durable content and no terminal to re-attach saves its structure without ids (`store.svelte.ts` 3278-3282, 3297-3300). That is a terminal saved before its id arrived, or after its session ended.

What the window does with "diverged". The branch nulls the save snapshot and arms the save (3478, 3482), which is how a window pushes back a tab it kept. When the apply kept nothing and the window holds nothing, there is nothing to push back, and the armed save is a save of an empty layout: 750 ms later `commitSessionSave` (3348-3370) finds an empty payload, and unless the first-save rule holds it back (3355-3358: no blob at load, nothing sent or applied since) it records the empty snapshot and sends a DELETE (3366). A `pagehide` inside those 750 ms sends the same DELETE with keepalive (3625, 3638-3640).

When the DELETE goes out. All of these at once: the apply left the window holding nothing, because every tab of the peer's blob was a terminal it could not attach, in one pane, and the window held nothing or held only tabs the peer's blob lacks and that the apply closes (a dirty or mid-save file tab is the one kind it keeps, `tabs.svelte.ts` 7749-7755); the window's load flag is `true`, because its boot read answered a blob (2511, 2662) or an earlier diverged apply left it holding a layout (3481), and no line writes the flag `false` after the boot; and the follower rule does not hold the DELETE back (3332-3334), so the window is a desktop window or a web page whose own role is not follower. The apply is started by a peer's `session_changed` frame (3417) or by Hybrid Nav's settled sink (3486-3488).

What it destroys. The DELETE removes the blob the peer has just written, and the route then forgets the window: `forget_window` closes every terminal session bound to that window id except one marked as moved out (`crates/chan-server/src/routes/sessions.rs` 217-223; `crates/chan-library/src/terminal_sessions.rs` 2720-2748). So the peer's shell is killed and the window leaves the saved-window list. The peer hears the `deleted` frame, seeds its own snapshot (3404-3416) and does not write its layout again until its next change.

How old it is. The released v0.101.0 has no first-save rule, so there every window that holds nothing after such an apply deletes. The first-save rule of [a-windows-first-save-can-swallow-a-peers-unsent-split](a-windows-first-save-can-swallow-a-peers-unsent-split.md) silenced the window that found no blob and never held a layout, and left this one: that item's contract speaks of a window that never held a saved layout, and this window loaded a blob or held one. Its record says a divergence that kept nothing leaves an empty window as it was and sends nothing; that holds while the load flag is `false` and not while it is `true`.

## Desired contract

A diverged apply after which the window holds no layout is an apply of nothing: the window records the empty layout as the state it has already sent, arms no push-back and sends no DELETE and no PUT for it, at the save's delay, at a later save of the same empty state or when its page goes away, whatever its load found. The blob stays the peer's, and the window takes the peer's next save, which carries the terminal's id. A window that holds a layout after a diverged apply pushes it back as before, and from then on its empty save deletes. A window its user empties deletes as before, and so does a window emptied after it kept a tab through a diverged apply.

## What to do

In the diverged branch of `applyRemoteSessionLayout`, ask first whether the window serializes to nothing (`serializeSession()`, the call the save itself makes at 3350). If it does: set the save snapshot to the empty string and return, with no save armed. The empty string is the part that matters beside the missing push-back: the layout change of the apply also re-arms the app's own save, and that save and the exit flush both stop at the dedupe (3359, 3629) only when the snapshot already says the empty layout was sent. Otherwise the branch does what it does: null the snapshot, set the load flag, arm the save; the flag write loses its condition there, which can no longer be false.

## Boundaries

`applyRemoteSessionLayout` in `web/packages/workspace-app/src/state/store.svelte.ts` and its tests; one sentence of `web/packages/workspace-app/src/design.md`; and the two comments in `web/packages/workspace-app/src/state/tabs.svelte.ts` that say what the caller does with "diverged" (7648-7660, 7988-7993). The reconcile itself, the save, the first-save rule, the follower rule, a deliberate discard and the server's routes stay as they are.

Not covered, and raised as an item of its own: a window that refuses a peer's terminal while it holds tabs still pushes back its layout, a PUT without that terminal, and the peer then removes its live terminal.

## Acceptance

1. Pins in vitest that need no browser, in `sessionSync.test.ts` with its fake timers and `api` spies, red before the fix at their own assertions: an empty window whose load flag is `true` applies a peer's blob of one terminal with no session id and sends no DELETE at the save's delay, and none and no PUT at a later save of the same state; a window that holds a clean tab and is emptied by such an apply sends no DELETE; a `pagehide` after such an apply sends no keepalive DELETE. Each has a mutation that reds it: the new branch removed; the empty string replaced by null.
2. The existing pins pass unchanged: a window that found no blob stays silent after such an apply; a window that kept a dirty tab through a diverged apply still pushes it back, and still deletes when it is then emptied; a window that loaded a blob or applied a peer's layout and is emptied by its user still deletes.
3. `web/packages/workspace-app/src/design.md` says in one sentence what a page does when it holds nothing after a peer's layout it could not attach.

## Not established

How often a peer saves a terminal without its id. What the peer's page shows once the reap has closed its session. Whether any whole-app test relies on the DELETE after such an apply: only `sessionSync.test.ts` was read for it.
