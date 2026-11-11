# A local close outlasts its CLI reply window

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

Origin: proposed from loadres T2's contract 2 reading on 2026-11-11; not accepted scope. Lead ruling is pending in followup-Core128-Lead128-18.md.

## Observed

At 94103e8fb17ce096eb302bbc5f33a1582021cfd4, `Request::CloseWorkspace::reply_budget()` falls through to three seconds in `crates/chan-server/src/handoff.rs:284`. A mounted workspace's close deliberately awaits its blocking teardown hop for five seconds from dispatch (`WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT`, `crates/chan-library/src/host.rs:57`), after its tenant tasks shut down. If a workspace reference still holds the writer lock, the close reports `workspace is still releasing; retry`, records the workspace off, and leaves teardown running until release. A retained workspace reference is a valid way to reach that documented reply.

A sandbox-local test held an `Arc<Workspace>` across `close_workspace_from_handoff`, with another registered root stalled. It received the correct retry after 5.002018818 seconds on a host whose measured durable-write pace was 605.651 microseconds. The desktop test's CLI reply-budget assertion failed at three seconds plus four pace samples. Evidence: `evidence/Core128/loadres-2/initial-desktop.log`. No induced load, listening devserver or GUI display was needed. This is a direct handler measurement; a real CLI/socket round trip has not been measured.

## Proposed contract

A local close or forget that waits on teardown should be able to return the host's retry result through the CLI handoff before the client gives up. Decide whether the client wait or a desktop-specific wait should change, accounting for tenant-task shutdown before teardown, and preserve teardown ownership when a caller leaves. Cover local close and forget; remote variants already use a different reply budget.

## Proposed evidence

A deterministic held-release handler case and a real handoff round trip should see the retry result; after release, the workspace must be unmounted, the off intent must remain recorded, the writer lock must be free, and a repeat close must report NotFound. Registry-only verbs keep their separate short reply budget. The construction must fail against the current three-second local-close deadline.

## Lead ruling, 2026-11-11

Followup-Lead128-Core128-6.md accepts the CLI reply-budget fix for this release as loadres T3 after T2 acceptance. T2 remains test-only. The eventual row closing section will distinguish the corrected test expectation from the CLI budget fix and cite the latter's commit. This draft remains the finding record for the owner's next survey.
