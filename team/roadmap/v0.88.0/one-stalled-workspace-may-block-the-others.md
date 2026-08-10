# One stalled workspace may block turning off the others

Status: REGISTERED 2026-08-09 as an **unverified lead**, from diagnosing the watcher-reconcile stall ([gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md)). No reproduction was attempted. The cause below is a hypothesis that fits the observation; it is not established, and it must be reproduced before anything is built against it.

**NOT REPRODUCED 2026-08-10.** The reproduction ran (see [Reproduction, 2026-08-10](#reproduction-2026-08-10)) and the stated mechanism is falsified: closes do not serialize, do not exhaust the runtime, and are bounded. No code changed. The observation itself **remains unexplained**: two candidate mechanisms are now ruled out and a third is named but uninvestigated.

## What was observed

While one workspace was parked in the recovery stall, the other workspaces on the same devserver could not be toggled off from the UI. An out-of-process `chan close {path}` did work, after disconnecting from the devserver and reconnecting.

That is the whole observation. Everything below is inference.

## The hypothesis, and why it fits

Turning a workspace off runs `self.host.close_workspace(prefix, force).await` (`crates/chan-server/src/devserver.rs:970`), and mounts serialize on one global `mount_attempt_lock` (`devserver.rs:789`). A close that blocks inside workspace teardown, either joining the recovery worker or contending on `write_serial`, occupies a tokio worker thread, and the runtime has 8. Enough blocked closes would exhaust them.

It fits both halves of what was seen: the in-process UI path stops responding while the out-of-process `chan close` still works, because the latter does not go through the blocked runtime.

## Why it is not a finding

Nothing was measured. No thread dump was taken while the UI was unresponsive, no close was traced to where it blocked, and the worker-exhaustion claim was not tested against the actual number of pending closes. The competing explanation, that the UI path was blocked on something entirely unrelated to `mount_attempt_lock`, was not excluded. A hypothesis that explains an observation is the first plausible explanation, which is usually the wrong one.

## What needs to happen first

Reproduce it. Hold one workspace in the recovery stall, attempt to toggle another off, and establish where the close actually blocks: thread state, the lock it waits on, and whether runtime workers are in fact exhausted. Either the mechanism is confirmed and this becomes a real item with a contract, or it is falsified and this item closes as not reproduced.

> **This instruction could not be followed as written, for the reason this item went on to document.** "Hold one workspace in the recovery stall" assumes that state is reachable; [What was not staged, and why](#what-was-not-staged-and-why) establishes that `53f8b5e6` made it structurally unreachable on a served workspace. Left standing rather than rewritten, because an instruction that expires when a later section answers it is the shape worth seeing. What was done instead, and why the substitute answers the same question, is recorded there.

Do not fix this by widening the runtime or by making the lock finer-grained on the strength of the hypothesis alone. Both would be changes to concurrency structure justified by a story rather than by evidence, and a symptom that pattern-matches a known failure shape may have a different cause.

## Contract

Deliberately empty until the mechanism is established. Writing a contract now would commit the project to a cause nobody has confirmed.

**Resolved 2026-08-10: it stays empty permanently.** The mechanism was not established, it was falsified, so there is no cause to write a contract against. The emptiness is now the conclusion rather than a placeholder.

## Rough size

Unknown, and it stays unknown until the reproduction lands. The reproduction itself is small.

**Answered 2026-08-10.** The reproduction landed and was small, as predicted. The size of the *repair* is **zero**: there is nothing to fix, because the mechanism this item was registered to size does not exist. The one number this section could not carry when it was written was that the answer might be "no work at all".

## Reproduction, 2026-08-10

Run in container `chan-dsrig` against chan `0.87.0 (build git-73a33b9cf12e)`. That build is the `v0.87.0` tag itself, and `git diff 73a33b9c e239c770 -- crates/chan-library/src/host.rs crates/chan-library/src/tenant.rs crates/chan-server/src/devserver.rs` is empty, so the whole close path is byte-identical to this round's baseline. One devserver under a lingering user manager, eleven workspaces, no tunnel.

### The hypothesis needs a load the stall cannot supply

Before any measurement, the mechanism has a hole that does not depend on one. Worker exhaustion requires the stalled workspace to be **occupying** runtime workers. The defining property of this stall is that **no worker is assigned to the pass**: `active_generation: null`, `pending_generation: 14`, indexer idle, queue depth 0. A pass nobody is running consumes nothing, so it cannot exhaust a pool.

The parent item recorded the same thing from the live host, in the sentence directly describing the stalled devserver: *"The server was never deadlocked: it answered HTTP in under a millisecond throughout, having burned 9m03s of CPU in 12h26m with all 52 threads parked on futexes."* Threads parked on futexes are idle, not starved. Evidence against runtime exhaustion was already in the file this lead was extracted from.

### What the close path actually does

- `mount_attempt_lock` is a `tokio::sync::Mutex` (`devserver.rs:663`). Awaiting it parks the task, not a worker thread, so contending on it cannot exhaust a pool.
- It is taken on the **mount** path (`devserver.rs:789`). The toggle-off path, `set_workspace_on` (`devserver.rs:970`, `:992`), calls `host.close_workspace` under no cross-workspace lock at all. The observation was about toggling other workspaces **off**.
- The one genuinely blocking wait runs inside `tokio::task::spawn_blocking` (`host.rs:485` calling `wait_for_workspace_release`, `host.rs:2947`) — its own pool, not the async workers.
- Both waits are deadline-bounded: the flock verifier gives up after 5s with a named warning (`host.rs:2948`, `:2958`), and `TenantTaskOwner::shutdown` runs against `TENANT_TASK_SHUTDOWN_GRACE = 5s` (`tenant.rs:140`) and then **aborts** stragglers. A close cannot hang; worst case is about ten seconds, once.

### Measured

| Condition | Result |
| --- | --- |
| Toggle-off, all workspaces healthy, n=5 | min 0.016s, max 0.047s, **median 0.030s** |
| `.gitignore` write on a served workspace | generation 1→2, readiness stayed `ready`, converged in 0.002s |
| Toggle-off of B while A is `readiness: recovering` / `indexer: building` over 4000 files, n=8 | min 0.025s, max 0.111s, **median 0.064s** |
| Closing the busy workspace itself, mid-rebuild, 3 trials | 0.152s, 0.032s, 0.051s |
| **8 concurrent closes** | wall **0.198s**, slowest single close 0.193s |
| Authenticated `GET` during that concurrent storm, n=22 | median **0.002s**, max 0.032s, zero non-200 |

The concurrency row is the direct test. Wall clock equal to the slowest single close means the eight ran in parallel; serialization on a shared lock would have produced a wall of roughly their sum. A runtime with no free workers cannot answer an unrelated request in two milliseconds.

### The competing explanation is still not established

This item said the competing explanation — that the UI path was blocked on something entirely unrelated — was never excluded. It still is not established. What has changed is that **two** mechanisms are now ruled out rather than one, and what remains is a named candidate nobody has investigated.

**Ruled out: server-side concurrency.** Falsified by the measurements above.

**Ruled out: the boot overlay.** This reader first proposed that the pre-v0.87.0 locked overlay blocked the operator client-side — you cannot click a toggle an overlay is covering — and that this explained all three parts of the observation at once. **It does not hold, and the falsification is @@Overlay's.** The toggle was never under the overlay, because the two live in different SPAs in different documents:

- `<PreflightOverlay />` is mounted exactly once in the whole tree, at `web/packages/workspace-app/src/App.svelte:1595`, and has never existed in the launcher in any commit.
- Every `setDevserverWorkspaceOn` reference is inside `web/packages/launcher/`. The workspace on/off toggle is a **Launcher** surface.
- `workspace-app` carries no workspace on/off affordance at all.

The overlay is `position: fixed; inset: 0; z-index: 40000`, which covers its own document. It is not a window-manager layer and cannot occlude a different SPA in a different window. Three steelman readings — an embedded Launcher, a missed workspace-app affordance, the overlay mounted elsewhere in the v0.87.0-era tree — all fail against those greps.

**Named, not claimed: the Launcher's library view.** @@Overlay observes that a library view left stale or wedged after a devserver stall would fit all three parts without needing either ruled-out mechanism, and that the observation's own wording points there: `chan close` worked *"after disconnecting from the devserver and reconnecting"*, and reconnecting is what re-renders and re-fetches the Launcher's library view — the SPA that actually owns the toggle. **Nobody has investigated this**, it is recorded as the next place to look rather than as a cause, and no lane investigates it this round.

The discipline is the point, and it is why this section reads as it does. The original lead was a confident mechanism built by reading an observation without checking the evidence recorded beside it. The overlay explanation repeated that error one level down: it fit the observation and was never checked against which SPA owns the toggle, which a single grep for the mount point would have settled. Replacing it now with a third confident client-side story would repeat it a third time, inside the item that names the failure mode.

### What was not staged, and why

The literal parked stall was **not** recreated, because `53f8b5e6` closed it structurally: every path that parks a pass announces it to a `RecoveryDriver`, and `Indexer::spawn` installs one before the server answers a poll, so on a served workspace the state is unreachable at this commit. Every reachable busy state was tested instead. Staging the literal antecedent would need a fix-reverted build; it was judged not worth it, because a parked pass owns no worker and therefore cannot be the load this hypothesis requires — the gap it would close is the one the first section above already closes without a build.

### Outcome

Closed as **not reproduced**. No concurrency change was made. Widening the runtime or making the lock finer-grained would have been a change to concurrency structure justified by a story, which is what this item warned against, and the measurements say there is nothing to widen: the close path is already parallel, already bounded, and already fast under every condition reachable at this commit.
