# The editor's URL bubble overlaps its label and outlives its tab

Status: raised by the owner on 2026-11-02 from chan-desktop 0.120.1 on macOS, with two screenshots; filed by the owner the same day ("a couple minor UI fixes, you could write for another agent to fix") and accepted for v0.121.0 ("yes on v121").

## What is there now

A click on a URL in the editor raises the link bubble with an `OPEN <url>` row (`editor/bubbles/wiki.ts`). With a long URL the row reads `OPENhttps://...`: the `OPEN` tag and the URL overlap. The bubble is attached to `document.body` and closes on an outside mousedown or Escape (`editor/bubble.ts`), so a tab switch that runs no mousedown leaves it painted over the tab that replaced the editor, until the next click anywhere. The owner's words: "it's ok to stay visible on the editor tab but not ok to show in other tabs".

## Desired contract

1. A bubble row's tag and its text never overlap: with a URL of any length the tag shows whole, then a gap, then the URL ellipsized before the copy button.
2. An editor's bubbles and popovers show only while their editor is shown; anything that stops showing the editor closes them, as a click elsewhere does. While the editor stays shown, the bubble behaves as before.

## Acceptance

1. A mounted test, red first: the URL bubble closes when its pane switches to another tab by a path that runs no mousedown, and when the pane flips; the same for each other body-attached editor overlay found affected.
2. A layout reading in a real engine, before and after: the tag's right edge left of the URL's left edge with a 200-character URL.

## Closing

The external URL row's label has `flex-shrink: 0`; its existing margin separates it from the ellipsized URL and the copy button retains its space. The non-flex heading, block and ID rows keep their styles.

`FileEditorTab` passes its existing `active` signal as `Wysiwyg.shown`, independently of focus. Hiding the editor dismisses its active bubble through the adapter's cleanup, which also removes the caret anchor. Calendars and file previews register with an editor-owned lifetime that dismisses them and removes their document listeners on hide or destruction. The calendar's synthetic caret anchor retains that owner, so a deferred macro cannot reopen a popover after the editor hides, closes or changes to source mode. Hidden document updates cannot open a new bubble; returning to the tab does not reopen its dismissed trigger. Focus moving to another pane leaves the still-shown editor's overlay alone. Alex also authorized the same fix for Rich Prompt: `TerminalTab` passes its existing visibility through the composer to its editor. No `Pane.svelte`, `App.svelte` or tab-state change was needed.

Mounted-App regressions use the real editor and demo transport. The file-editor suite first failed 21 assertions against the base code, including the URL bubble's mouse-free host-command tab switch and pane flip, plus the date pill, caret calendar and file preview. The Rich Prompt extension first failed nine assertions before its visibility was passed through. The final focused run passed 58 tests in six files, including the existing bubble dismissal, anchor, calendar and preview suites. The new cases cover Hybrid Nav, tab and pane closure, tab moves, preserved editor instances and content, synthetic-anchor removal, released calendar keys, delayed preview responses and deferred calendar creation. Six deliberate mutations each failed a relevant assertion: removing the host visibility signal, allowing hidden bubble creation, allowing hidden popovers, allowing destroyed-owner popovers, dropping synthetic-anchor ownership, and omitting destruction cleanup. `npm run check -w @chan/workspace-app` returned 0 with no errors or warnings; `git diff --check` returned 0.

Layout was measured on Linux x86_64 in headless Chrome 150.0.7871.186 on 2026-11-02, at 1280 by 800 CSS pixels with a 200-character URL, using the mounted app, actual stylesheet and demo transport. The baseline is at 12:41:14 UTC and the fixed reading at 13:04:27 UTC. Boxes below are `(x, y, width, height)` in CSS pixels; the label text is measured with a DOM Range as well as its span because the text overflows the shrunken span before the fix.

| Element | Before | After |
| --- | --- | --- |
| OPEN span | `(42,217.5,22,15)` | `(42,219.5,30.640625,15)` |
| OPEN text | `(42,217.5,30.640625,15)` | `(42,219.5,30.640625,15)` |
| URL span | `(69.5,215.5,414.5,19)` | `(78.140625,217.5,405.859375,19)` |
| Copy button | `(484,214,22,22)` | `(484,216,22,22)` |

Before: the span's right edge is already left of the URL, but its text ends at 72.640625 while the URL begins at 69.5, a 3.140625px overlap. After: both the span and its text end at 72.640625, the URL begins at 78.140625, and the gap is 5.5px. The URL ends at the copy button's left edge, 484, and retains `text-overflow: ellipsis`; its scroll width is 1364px versus a 406px client width. The Chrome probe asserted overlap on the baseline and separation on the fix, then passed file-editor tab-switch and pane-flip checks plus Rich Prompt tab-switch and calendar-flip checks, with no page errors.

Local screenshots: [before](../../../dev/v0121/evidence/linux/urlbubble/layout-before.png) and [after](../../../dev/v0121/evidence/linux/urlbubble/layout-after.png). The gitignored evidence directory `dev/v0121/evidence/linux/urlbubble/` retains the probe, JSON boxes, screenshots, red and green test logs and mutation results. The final committed-sha `make web-check` result and exact command log are recorded in `dev/v0121/handbacks/linux-urlbubble.md`.

Open: the real macOS WebView was not exercised on this Linux host. Browser checks used the demo transport, so they do not exercise native menus or the `cs` transport; those paths share the tab visibility signal covered by the mounted host-command test. The merger owns the full pre-push gate.
