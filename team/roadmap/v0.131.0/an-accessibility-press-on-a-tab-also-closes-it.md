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
