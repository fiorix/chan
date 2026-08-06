# Ghostty live-output scroll stability

> Status: shipped in [v0.85.0](../../release/release-v0.85.0.md).

Status: REGISTERED for v0.85.0, grounded 2026-08-03, ruled 2026-08-03, specified 2026-08-03, implemented, owner validation pending.

## What

While Kimi is emitting output in a Ghostty terminal, manually scrolling can drive the scrollbar to the top of the scrollback instead of leaving navigation under the user's control. The same Kimi session behaves correctly under xterm.js.

Kimi is the reproducer, not a special case. Any process can emit the same byte and timing pattern, and the terminal output path has no reliable reason to identify the producer. The contract is therefore generic: a Ghostty viewport already at the bottom follows output; once the user scrolls away, visible history remains anchored and an active gesture remains authoritative. Incoming output must never send the viewport to the oldest scrollback unless the user's gesture actually requested the top.

## Verified current state

- The issue was reproduced by the owner on 2026-08-03 with Kimi under the Ghostty backend. xterm.js on the same Chan Desktop setup behaves as expected.
- Pinned Ghostty calls `scrollToBottom()` after every write whenever its viewport is away from the bottom. Chan compensates in `writeGhosttyPreservingScroll` by reading the viewport and scrollback length, writing synchronously, then restoring `viewportBefore + appendedLines` (`web/packages/workspace-app/src/terminal/ghosttyCompat.ts:204-224`).
- Ghostty defines `getViewportY()` as the possibly fractional number of rows scrolled back from the bottom. Its wheel path animates a private target over the default 100 ms. `scrollToBottom()` and `scrollToLine()` update the current viewport but do not synchronize that in-flight target. A wheel animation and repeated output writes can therefore keep acting on different viewport state. This is the leading failure mechanism from source inspection, not yet causal proof from a reproducing automated test.
- `TerminalTab.svelte` routes every Ghostty PTY write through the workaround (`web/packages/workspace-app/src/components/TerminalTab.svelte:897-905`). The synchronous callback is load-bearing for `PtyWriteTracker`; returning to Ghostty's deferred write callback would wedge replay-origin suppression in a backgrounded page.
- `ghosttyCompat.test.ts` covers bottom-follow, a static scrolled viewport, an in-place update, and scrollback clearing (`web/packages/workspace-app/src/terminal/ghosttyCompat.test.ts:164-200`). Its fake has no animation target, scheduler, or interleaved wheel input, so it cannot reproduce the Kimi failure.
- Browser smoke check 94 covers Ghostty loading, fallback, OSC 52, keys, mouse capture, selection, and SGR wheel reports. It does not interleave primary-buffer navigation with streaming PTY output.
- No Kimi-specific branch exists or belongs on this path. The server-derived Kimi identity and submit chord live above the byte stream and are unrelated to viewport ownership.

## Contract

### Bottom-follow

- A viewport at the bottom continues to follow new output exactly as today.
- In-place screen updates that add no scrollback do not manufacture an offset.
- Reaching the bottom through a downward gesture while output is active is possible; incoming writes cannot continually pull the target away from zero.

### User-owned history

- Once the user scrolls away from the bottom, appended output preserves the same visible logical content by rebasing the distance from bottom only as the scrollback grows.
- An in-flight upward or downward gesture remains the navigation authority. Writes arriving between wheel events or animation frames do not restore a stale target, amplify the gesture, reverse it, or force the viewport to the top.
- The top is reached only by a user gesture that asks for it or by a necessary clamp after the retained scrollback itself changes. Repeated output alone never drives a partially scrolled viewport to the oldest retained line.
- Clearing, trimming, resetting, or replacing the scrollback clamps both current and intended viewport state to the new valid range. No stale offset survives a terminal teardown or respawn.

### Scope

- The invariant applies to every Ghostty terminal and every output producer on every supported client. Kimi supplies the live owner acceptance scenario.
- xterm.js keeps its native viewport behavior.
- Mouse-tracking reports and alternate-screen application input remain terminal input, not local viewport movement, and retain their current behavior.
- The fix adds no agent detection, Kimi command matching, submit-chord change, persisted viewport, or user setting.

## Implementation shape

- Replace the stateless write-only restoration model with one owner for Ghostty's current and intended local viewport state. A small `GhosttyViewportController` beside `ghosttyCompat.ts` is the expected shape, but an equally testable public-API solution is acceptable.
- Route both ordinary local wheel movement and PTY writes through that owner when Chan must compensate for Ghostty behavior. A write rebases a user-owned viewport against appended scrollback without discarding the live wheel target; a bottom-owned viewport remains zero.
- Prefer eliminating or owning the conflicting smooth-scroll state through Ghostty's public options and scrolling methods. Do not mutate private `targetViewportY`, animation-frame handles, or WASM fields; those are not part of the pinned package's API.
- Preserve the synchronous `termWriter` callback and the existing `PtyWriteTracker` origin ordering. Every PTY write origin, and every generated terminal reply it can trigger while parsing, must retain the same ordering and replay suppression.
- Dispose controller state with the terminal instance. Reconnects that retain the renderer may retain the live viewport; teardown, backend fallback, and respawn start with fresh state.
- This controller may also carry the macOS pixel calibration from `ghostty-macos-trackpad-scroll-parity`, but the output state machine must be correct with factor `1`, and its tests must not depend on sensitivity tuning to hide the jump.

## Acceptance checks

Deterministic unit tests drive a fake Ghostty terminal and scheduler through these transitions:

1. Bottom plus repeated writes stays at bottom and follows output.
2. An idle viewport away from bottom remains on the same logical lines as scrollback grows.
3. Repeated output interleaved with an upward gesture moves only by the gesture plus the exact anchor rebase; it does not converge on the top.
4. Repeated output interleaved with a downward gesture can reach and remain at the bottom.
5. Kimi-like high-frequency in-place redraw chunks that add zero logical lines do not move the viewport.
6. A buffer clear or trim clamps current and intended positions, and teardown clears all pending motion.
7. Reintroducing the current stateless restore while leaving an old animation target live makes at least one interleaving test fail. A controller that merely asserts a final in-range value is insufficient; tests pin the intermediate user intent and visible anchor.

Component integration tests keep the Ghostty writer synchronous, prove all Ghostty PTY bytes use the controller, and preserve the existing mouse-wheel report hook. Browser smoke check 94 and the xterm.js regression check 97 remain green.

The automated reproducer uses deterministic streaming terminal output, not the Kimi executable or account. Owner-run acceptance uses real Kimi in Chan Desktop:

- start a response long enough to keep emitting output;
- scroll upward into history while output continues and confirm the viewport neither jumps nor drifts to the oldest line;
- scroll downward while output continues and confirm the live bottom is reachable;
- stop scrolling away from bottom and confirm the same visible content remains anchored as more output arrives; and
- repeat once under xterm.js as the behavioral oracle.

The owner records the Kimi version, backend, platform, and result in implementation evidence. CI never installs or authenticates Kimi.

## Boundaries

- No Kimi-specific viewport or output logic.
- No xterm.js changes.
- No persisted scroll position across a terminal teardown.
- No scrollback-capacity, scrollbar-style, selection, or terminal-output protocol change.
- No Ghostty dependency upgrade or patch to installed package files.
- No trackpad sensitivity tuning in this item; that is `ghostty-macos-trackpad-scroll-parity`.
