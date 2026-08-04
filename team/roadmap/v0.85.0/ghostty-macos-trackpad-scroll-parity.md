# Ghostty macOS trackpad scroll parity

Status: REGISTERED for v0.85.0, grounded 2026-08-03, ruled 2026-08-03, specified 2026-08-03, implemented, owner validation pending.

## What

On Chan Desktop for macOS, a trackpad gesture moves an ordinary Ghostty scrollback materially farther than the same gesture under xterm.js. Ghostty should feel like xterm.js on the same terminal content and hardware. The target is perceptual parity, not an identical implementation or exact arithmetic reproduction of xterm.js; a fixed empirically calibrated multiplier is acceptable, with `0.5` as the initial estimate.

This is a Ghostty compatibility correction, not a user preference. It applies only to macOS pixel-mode trackpad scrolling in the primary buffer. TUI mouse reports, alternate-screen wheel-to-arrow behavior, line/page delta modes, non-macOS clients, and xterm.js keep their current behavior.

## Verified current state

- `TerminalTab.svelte` constructs Ghostty and xterm.js from the same font, cell geometry, scrollback budget, and theme (`web/packages/workspace-app/src/components/TerminalTab.svelte:846-963`), so the observed travel difference is in wheel handling rather than rows having different heights.
- The workspace pins `ghostty-web` `0.4.0-next.20.g1858a59` and xterm.js `^6.0.0` (`web/packages/workspace-app/package.json:50,55`; `web/package-lock.json:6387,6392`).
- Ghostty's pinned primary-buffer wheel path converts `DOM_DELTA_PIXEL` directly from `deltaY` to rows using the renderer cell height, then animates toward that row target. xterm.js first normalizes the browser wheel event and applies its default `scrollSensitivity: 1`. The engines therefore do not share a wheel-normalization path; the observed WKWebView mismatch is consistent with that divergence, but the final factor still requires the owner calibration below.
- Chan already installs `handleGhosttyWheel` through Ghostty's public `attachCustomWheelEventHandler` hook (`TerminalTab.svelte:908-912,1768-1803`). The hook currently claims a wheel only while mouse tracking is active; otherwise it returns `false` and upstream Ghostty owns both primary-buffer scrolling and alternate-screen arrow synthesis.
- The existing Ghostty browser smoke, check 94, proves the custom SGR mouse-wheel report reaches the PTY. Check 97 is the xterm.js mouse regression proof. Neither checks ordinary scrollback sensitivity.
- The separately specified `ghostty-live-output-scroll-stability` item owns viewport movement caused by incoming output. This item owns the distance produced by a macOS trackpad gesture; either implementation may share one Ghostty viewport adapter, but both contracts remain independently testable.

## Contract

### Targeted gesture

The correction applies only when all of these are true:

- the live backend is Ghostty;
- the client OS is macOS;
- the wheel event uses `WheelEvent.DOM_DELTA_PIXEL`;
- Ghostty is navigating ordinary primary-buffer scrollback; and
- terminal mouse tracking is inactive.

For every other event, Chan leaves the existing owner in place. In particular, `DOM_DELTA_LINE` and `DOM_DELTA_PAGE` events pass through unchanged, as do non-macOS pixel events. A terminal program that owns mouse tracking still receives the same SGR or legacy wheel report, and an alternate-screen program without mouse tracking still receives Ghostty's existing arrow synthesis.

### Perceptual parity

- Replaying the same representative macOS trackpad delta sequence against equal numbered scrollback moves Ghostty in the same direction and approximately the same number of rows as xterm.js.
- Start calibration at a `0.5` Ghostty factor, reflecting the observed roughly twofold mismatch. The implementer may adjust that constant from a side-by-side Chan Desktop measurement; the chosen value and measurement belong in implementation evidence.
- Preserve fractional movement across small pixel deltas so a slow two-finger gesture remains controllable. Scaling must not introduce a dead zone, reverse direction, quantize every event to a whole row, or turn momentum events into isolated jumps.
- The correction is a code-owned compatibility constant. It adds no config field, Settings control, environment variable, or per-terminal toggle.

### Unchanged behavior

- xterm.js is untouched and remains the comparison oracle.
- Ghostty mouse reporting keeps its current coordinates, modifier bits, encoding, and one-report contract.
- Ghostty alternate-screen arrow synthesis keeps its current repeat and cap behavior.
- Scrollback capacity, scrollbar appearance, terminal font metrics, selection, and output-follow behavior are out of scope.

## Implementation shape

- Put the platform/mode decision and scaled pixel-to-row calculation in a pure helper under `web/packages/workspace-app/src/terminal/`, next to the existing Ghostty compatibility code. Keep `TerminalTab.svelte` responsible only for routing the event to the live terminal and preserving the existing mouse-report path.
- The existing custom wheel hook may claim the narrowly targeted local-scroll event and apply the calibrated motion through Ghostty's public scrolling API. All non-target events return to their current path.
- Preserve fractional state either in the helper/controller or through a Ghostty API that accepts fractional rows. Reset any accumulator with the terminal instance so a closed or respawned tab cannot inherit momentum.
- Do not patch `node_modules`, reach into Ghostty's private WASM terminal, or mutate private animation fields. A public `ITerminalOptions` setting or public scroll method is an acceptable implementation boundary.
- If this item and `ghostty-live-output-scroll-stability` share a stateful Ghostty viewport controller, its wheel and write transitions remain separately unit-tested; fixing one item must not make the other an implicit, untestable side effect.

## Acceptance checks

Automated checks must cover:

1. A table-driven unit matrix for backend, OS, `deltaMode`, mouse-tracking state, and primary/alternate buffer ownership. Exactly the macOS pixel-mode primary-buffer case is scaled and claimed.
2. Representative positive, negative, tiny fractional, zero, and momentum-like pixel sequences. Their accumulated row travel pins the chosen factor, preserves direction, and proves small events are not discarded.
3. Line/page modes, non-macOS pixel events, and xterm.js remain pass-through cases.
4. The existing Ghostty mouse-report tests and browser smoke check 94 remain green, including SGR reporting with mouse capture on and no report with mouse capture off. The xterm.js check 97 remains green.
5. An adversarial mutation restoring factor `1` makes the representative macOS sequence test fail. A mutation that claims line/page or mouse-tracking events also fails.

Owner-run acceptance on Chan Desktop for macOS uses the same long numbered scrollback under both backends and the same built-in trackpad:

- compare several slow and medium two-finger gestures in both directions;
- confirm Ghostty no longer travels roughly twice as far and remains controllable at low speed;
- confirm a physical click-drag selection and a mouse-tracking TUI still behave as before; and
- record the final constant and the observed comparison in implementation evidence.

Exact equality between two physical gestures is not required. The acceptance oracle is that repeated Ghostty gestures land in the same practical range as xterm.js and no longer exhibit the reported twofold sensitivity.

## Boundaries

- No user-facing scroll-sensitivity setting.
- No global multiplier across browsers, operating systems, or wheel delta modes.
- No change to TUI mouse reports or alternate-screen arrow synthesis.
- No xterm.js option or behavior change.
- No Ghostty dependency upgrade as part of the correction.
- No attempt to fix live-output viewport jumps in this item.
