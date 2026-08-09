# One stalled workspace may block turning off the others

Status: REGISTERED 2026-08-09 as an **unverified lead**, from diagnosing the watcher-reconcile stall ([gitignore-write-strands-the-workspace-in-recovering](gitignore-write-strands-the-workspace-in-recovering.md)). No reproduction was attempted. The cause below is a hypothesis that fits the observation; it is not established, and it must be reproduced before anything is built against it.

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

Do not fix this by widening the runtime or by making the lock finer-grained on the strength of the hypothesis alone. Both would be changes to concurrency structure justified by a story rather than by evidence, and a symptom that pattern-matches a known failure shape may have a different cause.

## Contract

Deliberately empty until the mechanism is established. Writing a contract now would commit the project to a cause nobody has confirmed.

## Rough size

Unknown, and it stays unknown until the reproduction lands. The reproduction itself is small.
