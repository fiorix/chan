# An accessibility press on a tab also closes it

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

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
