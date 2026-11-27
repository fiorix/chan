# A Tab walk lands in another pane's terminal and types into it without making that pane active

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27.

Record: found outside [the unfocused-survey row](../done/a-survey-over-an-unfocused-pane-takes-tab-and-its-keys.md) while that row was reviewed. The review of its first range noted that browser check 348's walk ends on pane A's terminal `TEXTAREA` at step 2 with pane B still the focused pane, and that whether typing there reaches A's PTY was not established (`dev/v0135-team/reviews/review-u5.md`, "Outside the row"); the lead recorded it for the owner (`dev/v0135-team/decisions.md`, D21). The WebKitGTK reading answered that question (D123 item 3), and the owner's Mac reading found the same in WKWebView (D124 item 2).

## What is there now

Read at `aabb9d039`, by reading, except the readings named.

- The terminal widget makes its host element focusable with `tabindex="0"` when it has none (`web/packages/ghostty-web-ng/lib/terminal.ts:401-403`) and gives its hidden input textarea `tabindex="0"` (`:434`). By reading, every mounted terminal of every pane is in the page's Tab order. Once a terminal holds the keyboard it takes Tab and Shift+Tab as its own keys (the owner's Mac reading, check 5, third session).
- A pane becomes the active pane on a press: its `mousedown` calls `setActivePane` (`web/packages/workspace-app/src/components/Pane.svelte:1514-1523`). A focus that arrives by sequential navigation moves nothing: the terminal tab's `focusin` only records which of its own surfaces holds the keyboard (`noteKeyboardSurface`, `web/packages/workspace-app/src/components/TerminalTab.svelte:872-877`, bound at `:3370`).
- Read in three engines, each with pane B active and a survey up over pane A's terminal, the unfocused-survey row's setup:
  - Chrome, browser check 348: Shift+Tab from B's tab label reaches A's terminal textarea at step 2 (review-u5, above). Typing was not read there.
  - WebKitGTK 2.52.6 in an isolated Ubuntu 26.04 guest at `08b5a96d1`: Shift+Tab from B's tab label passes B's close button, B's other tab label and the pane divider and lands in A's terminal textarea; the active pane stays B, and a typed `zq` reaches A's PTY while A's survey stays unanswered (`dev/v0135-team/evidence/reports/v0135-173-webkitgtk-ops-report.md`, check 5, "Adjacent defect"; `dev/v0135-team/evidence/v0135-173-webkitgtk/item3/walk.log`, the adjacent reading at 20:42:54Z; screenshot `item3/c5-08-keys-in-pane-a.png`).
  - WKWebView on the owner's Mac at `5915fd54f`: a forward Tab walk from B's tab label passes B's close button, its side toggle and the menu button and lands in A's terminal while `cs pane list` still names B active; the `zq` typed next reaches A's PTY (`7a 71`) (`dev/v0135-team/evidence/owner-mac-results-v0135.md`, check 5, "Adjacent defect").
- That a Tab walk reaches another pane's terminal with no survey up is by reading: the widget's `tabindex` does not depend on a survey. No reading has been made without one.

## Desired contract

1. A terminal in a pane that is not the active pane is not reachable by sequential keyboard navigation: its host element and its input leave the Tab order while their pane is not active, and return to it when the pane becomes active.
2. A press on such a terminal makes its pane the active one and gives the terminal the keyboard, as today.
3. The active pane's terminals, a window with one pane and Tab inside a terminal that holds the keyboard (which goes to its program) behave as today.

## Boundaries

- The terminal's Tab order (the widget's `tabindex`, or the tab that mounts the widget in `TerminalTab.svelte`) and its tests. The active-pane rule in `Pane.svelte` and the keyboard-owner arbiter are consumed, not changed.
- Other panes' tab strips and their buttons stay in the Tab order. The survey card's own rule belongs to the unfocused-survey row and is not touched.

## Acceptance

1. Mounted tests, red at the base: two panes with a terminal each and pane B active; A's terminal host and input read `tabIndex` -1 and B's 0; once A is made active by a press, the reverse. One mutation that drops the rule turns them red.
2. A browser check in an isolated guest, with no survey up and then with one over pane A: Tab and Shift+Tab walks from B's tab label never land in A's terminal, and a key typed after the walk never reaches A's PTY. Red at the base, green at the tip.
3. The same walks on WebKitGTK in an isolated guest and in WKWebView on the owner's Mac, the two engines where typed keys reached the inactive pane.

## The options as drafted

- (a) A terminal outside the active pane leaves the Tab order (recommended: it closes the path the readings found and keeps the rule the unfocused-survey row kept, that sequential focus never moves the active pane).
- (b) Focus that enters a terminal makes its pane the active pane, as a press does. The unfocused-survey row named this a new precedent: nowhere else does Tab across panes move the active pane.
- (c) A guard that sends no typed key from a terminal outside the active pane, with the Tab order left as it is: the walk still lands there, on a terminal that answers nothing.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125), answering the candidate rows of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "Tab across panes"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125). The options above are the lead's draft, with (a) recommended; the owner's word did not choose among them.
