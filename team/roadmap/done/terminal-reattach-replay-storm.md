# Terminal reattach replay storm

Status: SHIPPED in [v0.83.4](../../release/release-v0.83.4.md). The apparent replay storm was one full-ring replay paying a per-chunk masker capture and scan; replay-window writes are now batched behind one whole-buffer scan after the drain, taking a 2.1 MiB reattach from over 180 s to 2.8 s. Owner-confirmed live.

## What

Reported from live use by the owner on 2026-08-04: terminal scrollback replay after reattach appeared to loop repeatedly before eventually settling and was severe enough to obstruct testing. Follow-up A/B evidence corrected the initial report: this is one full-ring replay applying extremely slowly, and the slowdown bisects to v0.83.0 (the secret-masking release), not to a v0.83.3 attach change.

## Verified current state

From code reading and git archaeology on 2026-08-04 (lead, before this item was assigned):

- The replay DECISION logic did not change in the span: the snapshot/cursor/generation contract (`web/packages/workspace-app/src/terminal/session.ts`, `snapshotCache.ts`, and the attach orchestration in `TerminalTab.svelte` around the `session`/`ready` frames) is identical in v0.82.0 through v0.83.3. A full replay happens only on generation mismatch, `missed_bytes > 0`, or an unusable snapshot, same as before.
- The relevant behavioral change on the replay APPLICATION path is the secret-masking write hook (`1d5b4902` plus hardening `d0c3d515`, `e98a181f`): every parsed write completed through `captureWrite` plus `scanWrite`. A retained 2.09 MiB server ring arrived as 3,464-6,247 binary chunks in controlled runs, multiplying the mask work by the same count. Because xterm drains writes asynchronously, captured markers can also scroll out before their callback and make `scanWrite` fall back to `scanAll`.
- The wake-gap detector and socket recycle (`installWakeGapDetector` / `recyclePtySocketAfterWake`) date from v0.69; the server's lagged-consumer path only prints a notice and never auto-reconnects; the SPA's error frames never force a reconnect. None of those loop by themselves.
- The v0.83.0..v0.83.3 span is small: the launcher inline-deck fixes (`c4e1df96`, `26713148`), the retired command-launcher overlay removal (`bbef5041`), the timing-test hardening (`fd0c21da`), docs and release chores. A local repro plus bisect across this span is cheap.
- The controlled socket trace disproved the repeated-attach interpretation: each page reload, socket drop, wake gap, and real devserver restart produced one `session`, one bounded replay, and one `ready`. The apparent repetitions were intermittent progress while that single replay monopolized the browser main thread.
- The owner can avoid the pathological path on an unfixed build by disabling terminal secret masking; replay protocol and retention are not implicated.

## Contract

- A `session` frame starts one secret-mask replay batch before snapshot priming or ring writes are parsed.
- While `attachReplayActive` is true, replay writes keep their existing bytes and `PtyWriteTracker` origin/order but do not take per-write mask snapshots or scans.
- A `ready` frame closes the batch. The one whole-buffer mask scan runs only after both `ready` and the last queued replay write callback, so it sees the fully parsed terminal. A zero-byte replay still scans once at `ready`.
- Live writes retain the existing per-write `captureWrite`/`scanWrite` behavior, including live writes that arrive while an older replay callback is draining. Mask toggle semantics and the visual-only, post-parse contract are unchanged.

## Acceptance checks

- A Vitest regression pins that replay writes perform no per-write captures/scans, one scan runs after `ready` plus write drain, live writes retain their scan path, and abandoned attach callbacks cannot scan an obsolete batch.
- Existing secret-masking, real-xterm, Ghostty, connection/origin, and terminal protocol tests stay green, together with the workspace-app Svelte/TypeScript check.
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

The v0.83.0..v0.83.3 comparison has no introducing change in the attach path. `TerminalTab.svelte`, `web/packages/workspace-app/src/terminal/**`, the watcher store, the terminal route/session registry, desktop watcher wiring, and desktop devserver connection code are byte-identical across the tags. `serve.rs` differs only for the retired command-launcher overlay removal; its navigation and retarget path did not change. That is consistent with the corrected owner bisect: the slow application path was already present in v0.83.0.

There is a matching historical desktop precedent: `c05d1ffb` stopped gateway feed token churn from changing `RemoteLaunchKey` and retargeting every open WebView on every feed push. Its regression test is `remote_launch_key_ignores_token_churn_for_gateway_windows`. That fix predates and is an ancestor of both v0.83.0 and v0.83.3, so it does not explain a new regression between those releases.

### Masker A/B and fix timing

The deterministic headless probe retained the same approximately 2.096 MiB ring and counted WebSocket control/binary frames, so every timing below is one `session`/`ready` attachment rather than a reconnect loop. The corpus is deliberately secret-dense to exercise the worst masking path.

| Build/path | Replay chunks | Session to rendered tail marker | Result |
| --- | ---: | ---: | --- |
| Before fix, masking off | 6,247 | 1.63 s | Replay/parser baseline. |
| Before fix, masking on | 5,166 | >180 s | Browser main thread still blocked when the probe timed out; greater-than-110x versus the off baseline. |
| After fix, masking off | 3,464 | 1.39 s | Replay/parser baseline. |
| After fix, masking on | 3,466 | 2.78 s | 1.99x versus off and greater-than-64x faster than the pre-fix lower bound. |

Chunk counts vary with PTY read boundaries, while retained bytes remained 2.095-2.097 MiB. Source-path profiling identifies the catastrophic multiplier as one `captureWrite`/`scanWrite` pair per chunk, including whole-buffer fallback when queued-write markers are disposed. With that multiplier removed, a sampled masking-on run concentrates its remaining work in the intended single scan: `#scanGroup` used about 1.45 s self time and xterm marker/decorations about 0.19 s on the secret-dense corpus.

`ReplayMaskScanBatch` now joins server `ready` with xterm write-drain completion and invokes one `scanAll`. `TerminalTab.svelte` leaves the WebSocket frames, replay bytes, `PtyWriteTracker` origin ordering, snapshot/generation rules, and live-write mask path unchanged. The regression pin is `web/packages/workspace-app/src/terminal/replayMasking.test.ts`, whose six cases cover the contract clause for clause: live writes stay on the per-write scan path, replay writes skip per-write scans and take one `scanAll` after ready drains, an attach with no replay writes still scans once, live writes stay byte-identical while a replay drains, a new attach supersedes an abandoned replay's callbacks, and the `TerminalTab.svelte` wiring is source-pinned. Focused verification: 24 terminal/secret-mask/xterm/Ghostty Vitest files passed (202 tests), and the full web `npm run check` passed with 0 Svelte errors or warnings.
