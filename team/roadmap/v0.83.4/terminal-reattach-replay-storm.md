# Terminal reattach replay storm

Status: REGISTERED for v0.83.4, grounded 2026-08-04, needs a spec (the lane pins the mechanism and writes the contract here).

## What

Reported from live use by the owner on 2026-08-04: since v0.83.3, terminal scrollback replays after reattach are more aggressive, and on boot/reattach the replay sometimes loops repeatedly before eventually settling. Severe enough to obstruct testing. The owner bisects the behavior to new-in-v0.83.3 relative to v0.83.0, and reproduces it with a branch-build desktop against a v0.83.3 devserver.

## Verified current state

From code reading and git archaeology on 2026-08-04 (lead, before this item was assigned):

- The replay DECISION logic did not change in the span: the snapshot/cursor/generation contract (`web/packages/workspace-app/src/terminal/session.ts`, `snapshotCache.ts`, and the attach orchestration in `TerminalTab.svelte` around the `session`/`ready` frames) is identical in v0.82.0 through v0.83.3. A full replay happens only on generation mismatch, `missed_bytes > 0`, or an unusable snapshot, same as before.
- The only behavioral change on the replay APPLICATION path in the span is the secret-masking write hook (`1d5b4902` plus hardening `d0c3d515`, `e98a181f`): every parsed write completes through the masker's capture/scan. Per-write cost is bounded (visible rows), so it makes replays heavier but does not loop.
- The wake-gap detector and socket recycle (`installWakeGapDetector` / `recyclePtySocketAfterWake`) date from v0.69; the server's lagged-consumer path only prints a notice and never auto-reconnects; the SPA's error frames never force a reconnect. None of those loop by themselves.
- The v0.83.0..v0.83.3 span is small: the launcher inline-deck fixes (`c4e1df96`, `26713148`), the retired command-launcher overlay removal (`bbef5041`), the timing-test hardening (`fd0c21da`), docs and release chores. A local repro plus bisect across this span is cheap.
- A loop that eventually settles implies repeated attach or reload cycles, not one replay misbehaving. The two discriminating observations on a looping window: whether the DevTools console keeps clearing (page reloads, i.e. desktop navigation/retarget) or persists (ws reconnects, i.e. SPA-side), and whether `session` frames arrive repeatedly.
- Suspect classes, unranked until grounded: reconnect/retarget storms (each reattach replays), wake-detector false positives under main-thread load, replay-application slowdown making ordinary replays read as storms, or a serve/launcher-side change in the span causing repeated window reloads.

## Contract

- Pin the mechanism with a deterministic local reproduction (headless is fine; the browser-smoke harness or a scripted devserver-plus-reload loop both qualify). The bisect across v0.83.0..v0.83.3 should name the introducing change.
- The fix removes the loop: one reattach produces at most one replay (incremental when the resume contract allows it), and a settled terminal stays settled. The resume contract itself (`since` cursor, generation, missed-bytes invalidation, snapshot priming) is unchanged.
- Write the spec section of this item when the mechanism is pinned, replacing "needs a spec".

## Acceptance checks

- A regression test (vitest, browser-smoke check, or route test, whichever fits the mechanism) that fails on the introducing commit and passes with the fix.
- Focused tests, clippy, fmt, and `npm run check` green.
- Owner hand-smoke: with a gateway-connected window on a busy terminal, restart the devserver and watch one clean reattach per terminal; no repeated replay loops on boot or wake.

## Boundaries

- No redesign of the replay, snapshot, or generation protocol.
- No change to the secret-masking feature contract (visual-only, post-parse); if the masker is implicated, fix the interaction, not the feature.
- No gateway changes.

## Implementation evidence (2026-08-04)

The controlled investigation did not reproduce a replay storm. Browser probes counted PTY WebSocket creations plus `session` and `ready` frames so repeated rendering could not be mistaken for repeated attachment.

| Case | Observed attachment and replay |
| --- | --- |
| Busy preserved PTY through a real systemd devserver restart and tenant reauthorization | The same session survived with `NFileDescriptorStore=1` before and after restart. Reauthorization produced one successful PTY socket, one `session`, one `ready`, and one bounded 2.09 MiB replay. |
| Full page reload with 12 MiB of terminal output and no usable snapshot | One PTY socket, one `session`, one `ready`, and one bounded 2.09 MiB replay. |
| Explicit PTY WebSocket drop | One replacement PTY socket, one `session`, one `ready`, and redraw-only incremental bytes. |
| Seven-second main-thread/wake gap | One replacement PTY socket, one `session`, one `ready`, and redraw-only incremental bytes. No follow-on recycle. |
| Retry with the pre-restart tenant token | The WebSocket handshakes failed authorization and delivered zero `session` frames and zero replay bytes. Loading the fresh tenant token then produced the single successful attach recorded above. |

The v0.83.0..v0.83.3 comparison has no introducing change in the attach path. `TerminalTab.svelte`, `web/packages/workspace-app/src/terminal/**`, the watcher store, the terminal route/session registry, desktop watcher wiring, and desktop devserver connection code are byte-identical across the tags. `serve.rs` differs only for the retired command-launcher overlay removal; its navigation and retarget path did not change. A behavioral bisect therefore cannot name an introducing commit in this window.

There is a matching historical desktop precedent: `c05d1ffb` stopped gateway feed token churn from changing `RemoteLaunchKey` and retargeting every open WebView on every feed push. Its regression test is `remote_launch_key_ignores_token_churn_for_gateway_windows`. That fix predates and is an ancestor of both v0.83.0 and v0.83.3, so it does not explain a new regression between those releases.

The mechanism remains **UNPINNED**. If the storm recurs on the fixed build, the next step is an owner-side live trace that records whether the DevTools console clears between repetitions (page navigation/desktop retarget) or persists (SPA WebSocket reconnect), together with timestamps and cadence for every PTY `session` and `ready` frame. That trace, rather than another protocol change, determines the owning lane and the regression test.
