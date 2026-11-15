# An accessibility press on a tab also closes it

Status: accepted for v0.131.0 by the owner on 2026-11-13; built, reviewed and merged into `v0131/int` on 2026-11-15; its macOS line waits for the owner's batch.

Record: seen on 2026-11-13 on the owner's Mac (macOS 27.0.1, chan-desktop built from `8a44e110e`) by the agent that ran his checks, as an observation it was not asked for: "pressing a tab in the tab strip through AX (AXPress, the action VoiceOver uses) selected it and also opened its `Close tab?` prompt, as if its close button had been pressed; a terminal tab with no live session closed outright" (`dev/v0129/owner/reports/parts-abc-at-8a44e110e.md`, Part C, "Observations, not judged"). Listed for him as a candidate (`dev/v0129/row-notes.md`, the Mac report for Parts A, B and C) and among v0.129.0's known limits (the [release record](../../release/release-v0.129.0.md)). At v0.130.0's planning he placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`; WebKit's code read at its `main` on 2026-11-13.

- A tab in a pane's strip is a `div` with `role="tab"` and `tabindex="0"` (`web/packages/workspace-app/src/components/Pane.svelte`). It selects on `mousedown` (a terminal tab on `mouseup`), has no `click` handler and no key handler, and holds one native button: its close button (`button.close`, named `close <label>`), whose `click` runs `closeTab`. Closing a live terminal asks "Close tab?" (`confirmCloseTabs`, `state/tabs.svelte.ts`).
- WebKit, which chan-desktop runs on macOS (WKWebView) and Linux (WebKitGTK), performs an accessibility press on its action element, and for the role `tab` that is the first native `button` or `select` inside the element when there is one (`AccessibilityNodeObject::actionElement` and `nativeActionElement`, `Source/WebCore/accessibility/AccessibilityNodeObject.cpp`); `AccessibilityObject::press` activates it with a simulated click (`AccessibilityObject.cpp`). So a press on a tab lands on its close button. The report's selection fits the press's mouse down reaching the tab's handlers before its click closes the tab; that part is inferred from WebKit's names, not traced.
- By the same reading, VoiceOver's activate on a tab, an AT-SPI client's action on chan-desktop for Linux, and Safari on the web build do the same. Chromium and Firefox were not read. Only the one macOS reading has seen it.
- Enter and Space on a focused tab label do nothing.

## Desired contract

1. An accessibility press on a tab selects it and focuses its pane, as a mouse press on its label does, and never closes it or asks to.
2. The close control stays its own accessible button, named `close <label>`, and an accessibility press on it closes the tab as a click does, with the same prompt.
3. A mouse press, a right press and a drag on a tab behave as today, a terminal tab's selection on release included.

## Boundaries

- The markup and handlers of a tab in the strip (`Pane.svelte`), and the tests and browser checks that find the close button inside a tab. Whether the close control moves out of the element with role `tab` or stops being one WebKit takes as that element's action is the build's choice.
- Not here: Enter and Space on a focused tab label, arrow keys along the strip, and the rest of the window's roles.

## Acceptance

1. A workspace app test that presses each kind of tab as WebKit does, on the first native `button` or `select` inside the element with role `tab` or on that element when it holds none, with mouse down, mouse up and click: the tab is selected and still open; red on today's markup, where the press reaches the close button. The same press on the close control closes the tab.
2. On the owner's Mac, on chan-desktop: AXPress on a live terminal tab, a file tab and a terminal tab with no session (System Events' `perform action "AXPress"` on each tab's element, as the report did) selects each and closes none; AXPress on each close button closes it, with the prompt for the live terminal; VoiceOver's activate on a tab selects it.
3. In an sdme guest on chan-desktop for Linux: the AT-SPI default action on a tab, from a script, selects it and closes nothing.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, points 9 and 11) on 2026-11-14: "as you recommend".

- The close button moves out of the element with `role="tab"`. The outer `div.tab` keeps its class, pointer handlers, drag and tooltip and loses the role; an inner element holding the icon and the label takes `role="tab"`, `tabindex` and `aria-selected`; the close button is that element's sibling. A press then lands on the tab element and bubbles to the outer element's `mousedown` and `mouseup` handlers, the mouse path.
- Folded in: Enter and Space on a focused tab label select it, as a press on the label does (a keydown on the same element running the same selection, with its test). This replaces the boundary's "not here" for those two keys; arrow keys along the strip stay out.
- What moves with it: anything that reads `aria-selected` or `tabindex` off `.tab`, and focus styles on `.tab`. Screenshots of the strip at base and tip in both engines.

## Built, 2026-11-14: implementation; native proof pending

The outer tab keeps its pointer selection, drag, tooltip and visual state. Its icon, label and status marks sit in a focusable inner element with the tab role and selected state; the native close button is a sibling. The existing mouse handlers still select a terminal on release. Enter or Space on the focused label selects the tab and its pane through the same selection function; modified chords and Hybrid Nav retain their existing key handlers. There was no tab-specific focus CSS to move: native focus follows the inner element's tabindex. The inner flex row retains the icon and label spacing, with screenshots still required below.

The mounted acceptance test uses WebKit's native-action selection rule and sends mouse down, mouse up and click. At the base it opens the live terminal's close prompt and closes the clean file and sessionless terminal; all six Enter/Space cases also fail. The three explicit close-control cases pass at the base, including the live-terminal confirmation. The red log is `dev/v0131-team/evidence/Edit131/axclose-stage1/base-red/red.log`. The implementation's mounted tests also cover modifier chords, untouched arrow keys and Hybrid Nav keyboard ownership. Tests and browser/native observation selectors follow the inner role for selection and the outer tab for its tooltip, close control and drag.

The subsystem design and navigation manual describe the separate controls and Enter/Space. Native AT-SPI, base/tip Chrome and WebKitGTK screenshots, the owner's macOS AXPress and VoiceOver line, and the final review are still pending. This implementation section does not close the row; the guest request draft is `dev/v0131-team/handoffs/request-Edit131-axclose-stage2.md`.

## Built, 2026-11-15: native and browser proof

The mounted suite passes 22 cases. Seven isolated mutations fail assertions: putting the close button inside the tab role, removing keydown or Space handling, and removing each Ctrl, Meta, Alt or Hybrid Nav guard. The original source is restored after each mutation; evidence is under `dev/v0131-team/evidence/Edit131/axclose-stage1/`. The adjacent pane and focus suites pass 51 and 24 cases.

The base browser reading completes all 18 arms: nine failures reproduce the three synthetic WebKit activations and six trusted Enter/Space selections; nine pointer, drag and explicit-close controls pass. Native WebKitGTK 2.52.6 reproduces the selection fault for all three kinds through actual AT-SPI default actions. The base's three explicit close targets are unavailable under the required exact accessible name and role, so that native run remains exit 2, not a pass. The raw base evidence is `dev/v0131-team/evidence/Ops131/J144/`.

At `0a5f3d26c92368ec9062d0759c4cafe4411e1f43`, both browser invocations, check 266 alone and after focus check 137, pass with no skipped check. Each invocation completes all 18 activation, keyboard, pointer, drag and close arms; check 137 also passes on xterm and ghostty. The native reading invokes all six actual AT-SPI actions successfully. Selecting the live terminal, clean file and exited terminal preserves the tabs and global sessions; each separately named close action removes only its target, with the live prompt and Cancel preserving the session until confirmation. Every native postcondition holds for at least 500 ms. A separate native pane reading passes split, focus, tab drag and close. Screenshots include the ordinary strip at 1600 and 640 pixels in Chrome and the native selection and close states. Results, command logs, identities and screenshots are under `dev/v0131-team/evidence/Ops131/J154/`.

The committed frontend, marketing, shell, workflow and e2e gates all exit 0, followed by explicit web and chan/chan-desktop builds with complete bundles. Source, binary and bundle provenance is unchanged across the readings. The browser timelines retain the known library command-capabilities 404s; the title loader catches that unavailable snapshot, and no page exception or fixture cleanup failure occurs. These runs cover the ordinary strip, not native title-bar placement. The owner's macOS AXPress and VoiceOver acceptance remains unrun; Linux AT-SPI does not replace it. Final review remains with the lead.

## Built, 2026-11-15: input guards and focus details

The label's Enter and Space handler stands down for a full-window cover or modal. The pill has a negative tabindex solely to receive native mouse focus on its padding and forward it to the label, without cancelling the press that starts a drag or selecting a terminal before release. The forwarding preserves focus on the separate close control and stands down in stale Hybrid Nav. The label's visible focus ring has a 3 px outward offset, and a keyboard-focused close button is visible on an inactive tab. The manual and subsystem design describe these input and focus rules.

The native instrument keeps a completed arm's fault even when that arm's final snapshot, screenshot or cleanup fails, recording those failures separately as `evidenceError` or `cleanupError`. It judges any observed fault before an unavailable or incomplete arm, or a missing remaining arm. Replaying the original J144 result with three observed faults and three unavailable close targets derives controller exit 10, which the lifecycle maps to observed-fault exit 1. J144's original JSON and exit 2 are unchanged. Recorded J144 and J154 result files are the verdict test's fixtures; no desktop or server is started by that test.

The fix-round evidence is under `dev/v0131-team/evidence/Edit131/axclose-fix1/`. The mounted suite adds blocked-key, padding-focus and focus-style checks. In jsdom only the focus-visible pseudo-class is substituted to exercise the component's own style rules; actual keyboard modality and padding click/drag are also observed by browser check 266. The committed gate and updated browser reading remain pending in this section until their results are recorded.

Review notes retained without a product change: Shift+Enter and Shift+Space select like the mouse; the label's key handler has no target/currentTarget check while its descendants are spans; an earlier mutation baseline differs by one comment byte, with the committed source separately green; check 266's pane-focus assertion uses a one-pane fixture, with the two-pane proof in the mounted suite. The owner's macOS acceptance also reads the tablist's children and the label's AXHelp, alongside AXPress, VoiceOver and title-bar placement; those native Mac observations remain unrun.

## Built, 2026-11-15: padding focus scheduling

Padding focus forwards to the label after the native mouse-focus action completes. The callback only forwards while the outer pill still holds focus and Hybrid Nav is not stale, so a terminal, close control or other surface that takes focus keeps it. The mounted test rejects synchronous forwarding and covers focus moving away, a pane becoming stale and a tab unmounting before the callback.

J196 verifies the native finalizer fix at `455fe8bada3b15e315a3b18311728ed0c93849af`: all 12 native verdict cases and 295 tests in the 17 Pane files pass; workspace Svelte checking reports no errors or warnings. The new padding timing tests fail twice on that commit and all 33 mounted cases pass with deferred forwarding. Three isolated mutations restore synchronous forwarding, ignore moved focus or ignore a newly stale pane; each fails its intended assertion, and the restored source passes all 33 cases. Evidence is under `dev/v0131-team/evidence/Edit131/axclose-fix2/` and `axclose-fix3/`.

Browser check 266's right-padding reading identifies the active element and requires the selected terminal to keep the keyboard while its tab menu is open. The style reading reaches the inactive label from its own close control with Shift+Tab, so it does not depend on a preceding drag's tab order. The pending quiet comparison uses the old product before the padding forwarder, `0a5f3d26c92368ec9062d0759c4cafe4411e1f43`, as its control. Its result, the committed gate and the cause of the drag regression remain pending; this section claims no successful browser repair yet. The owner's macOS padding-focus and drag line remains unrun.

## Build ruling, 2026-11-15: one focus owner per gesture

The lead settled the focus owner after reviewing both terminal backends: a primary padding press focuses the label; a right or middle press leaves the keyboard with the selected surface, falling back to the label only when that surface takes no focus. The implementation uses the existing selection focus pulse after the native mouse-focus default, with no dependency on the terminal widget's backup focus timer. Pending work stands down for moved focus, a stale pane or an unmounted tab. The right and middle rule covers the label as well as the outer padding.

Mounted terminal tests use a synchronous focus target with no retry. Both non-primary padding cases fail on `cb4bec3c8b22b2d1c5a7655d94756879f413883d`, where the label retains focus. The dashboard provides the no-caret fallback control. Browser check 266 exercises xterm and ghostty separately, tags every fixture and arm with its backend, restores the backend preference after each fixture, and reports the observed focus-trace count against its 512-event limit. J200 verifies `b818ed6234f2e70bf01b1d669b3fab00b306fceb`: all 310 tests in the 17 Pane files pass, and workspace Svelte checking reports no errors or warnings. J198's quiet browser comparison remains pending at that same commit, with the rebuilt pre-forwarder `0a5f3d26c92368ec9062d0759c4cafe4411e1f43` as its control.

The final mounted suites pass 41 accessibility cases and 28 focus-follow cases. Complete right gestures on a no-caret dashboard also reproduce a body-focus loss when menu selection runs before or after the deferred press; the menu now uses the same fallback after its own pulse. Twelve branch and guard mutations fail assertions. The first detached-node mutation survived because Svelte unmount had already removed the label; detaching the intact pane exposes that guard and the corrected mutation fails. Restored source passes both suites. Logs and the mutation audit are under `dev/v0131-team/evidence/Edit131/axclose-fix4/`.

## Built, 2026-11-15: name-text context-menu focus

The name text has its own context-menu handler, which now calls the same guarded label fallback as the outer pill. A dashboard-name gesture reproduces body focus on `b818ed6234f2e70bf01b1d669b3fab00b306fceb`; the other 41 accessibility cases pass. With the shared fallback, all 42 pass. Removing that call reproduces the intended focus assertion, and restoring it returns all 42 cases to green. Evidence is under `dev/v0131-team/evidence/Edit131/axclose-fix5/`. Its Pane suites (17 files, 311 tests) and svelte-check (no errors or warnings) passed at that commit (J202).

The browser reading at this commit is J208, below. Check 266's plain right arms press the name text of a live terminal and a file tab, whose surfaces take focus, so the fallback added here stands down on every gesture it reads; no arm right-presses a dashboard's name, which this change's mounted regression test covers. The owner's macOS acceptance remains unclaimed.

## Merged, 2026-11-15

The row's range (`f766fa845..107f91c97`) was accepted by eight Fable reads (`dev/v0131-team/reviews/review-axclose-1a.md`, `-1b.md` and `-2.md` to `-6.md`: the build, five fix rounds and the held arm of check 266) and merged into `v0131/int`. Check 266's held arm now waits, bounded, for the target label's focus while the button is held (the first sample came about 3 ms after the press, before the deferred focus step). J208, at the final product commit `48782fc69` with that check (`107f91c97`), passed all 44 arms on both terminal backends; the same check failed on the old product (no forwarder: the held arm acquired no label focus within its bound) and on a product mutation dropping the deferred step, and the source was restored exactly. The committed gates passed at `107f91c97` (J207). The padding drag that the first synchronous forwarder blocked in Chrome starts and reorders on both backends since `b818ed623` (J198).

Open, not built here:

- The native verdict test (`scripts/e2e/desktop-observations/axclose-verdict.test.mjs`) runs in no gate; `make e2e-check` checks its syntax only.
- The jsdom style tests read the component's CSS with `:focus-visible` substituted; the real cascade and keyboard modality rest on check 266's style arm.
- Two test models of the browser's press-focus default (`Pane.menuFocus.test.ts` and the accessibility suite's helper) differ for a `tabindex=-1` element.
- Check 266's held arm records interim focus owners before acquisition without asserting them, and samples every 50 ms, so a focus bounce between samples would pass.
