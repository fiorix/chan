# A local close outlasts its CLI reply window

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Landed on 2026-11-11.

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

## Built, 2026-11-11

The local close and forget handoff clients use the tenant-task grace and teardown release budget from chan-library, plus three seconds for dispatch and the reply (thirteen seconds in total). Both the Unix socket and Windows named-pipe paths read that request budget. A held workspace can answer `workspace is still releasing; retry` through the longer window; the host still records off before teardown and retains the release work until the workspace and writer lock are free. Registry-only and remote request budgets are unchanged. Tasks that do not finish even after abort can still outlast this wait; the server design states that limit.

The held-close regression fails on the base's three-second window. Held close and forget are checked through the desktop handler for the retry, off intent, eventual unmount, writer-lock release and NotFound on a repeat close. A separate real Unix socket case covers both close and forget reaching the CLI after the release wait; reverting just the Unix client's timeout must make it red. Fixed as 0ea59713b and merged as 6522fe3f9; the real-socket case ran ten times green in the lead's isolated environment with the reverted Unix timeout red. Windows runtime verification remains separate from the Unix proof.
