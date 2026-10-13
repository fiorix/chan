# A second page loading into a window drops a tab the first page was just given

Status: raised by the review seat on 2026-10-13 from its runs of the terminal size instrument's two-page arm (the observation O1 of `reviews/review-Review106-termsz-design-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; dispositioned at the candidate: a reading if reached, else recorded with the observation below.

## What was seen

In the review seat's guest, in three of five runs of the instrument's co-view arm (two pages of one window at different sizes, forced onto one window id by the URL), a terminal tab created through `cs terminal new` and shown on the first page was gone from both pages seconds after the second page of the same window loaded: never attached on the second page, its socket closed on the first, the first page's last sample holding the other two tabs with the probe shown again. In the two runs that completed, the second page attached all three tabs. The seat's own three final arms completed in its guest. The runs' records are under `evidence/Review106/termsz2-*` in the round's bus; the driver then looked for a tab that was gone and ended inconclusive (status 3, "timeout: tab selectable").

Not established: what the second page restores at load and what it writes back to the window's layout; whether the tab's session was ended or only dropped from the layout (a running terminal lost without a close, or a tab whose session survives unattached); whether one page reloading inside the same interval does the same; whether the arrangement (two pages on one window id) is one a user reaches outside the instrument, and whether a desktop window and a browser page on one workspace share it; the cause at source (the layout's restore and save on page load against a tab added by the control socket a moment before).

## Desired contract

A tab added to a window is not removed by another page's load of that window; a page that loads restores the window's layout as it is at that moment, a tab just added included, or the layout's rule says which writer wins and the losing tab is closed by a close, never dropped.

## What to do

Read the workspace app's layout restore and save on page load (`web/packages/workspace-app/src/state/store.svelte.ts`, the restore constructors and the layout hash's write) against the control socket's tab creation (`crates/chan-server/src/control_socket.rs`, `terminal new`) and say what a second page writes back; then reproduce in a guest's Chrome with the instrument's own arrangement and without it (one page reloaded right after a tab is added), reading whether the tab's session is ended or dropped, with the expected readings written first. The repair, if one is needed, is designed after the reading.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` and `state/tabs.svelte.ts` (the restore and the layout's save), their tests, and a browser check if the reading asks for one. Not changed: the shared layout hash's content, the control socket's tab creation, the terminal size item's instrument.

## Acceptance

1. A reading of what a page load writes back to the window's layout and when, with line numbers, and a reproduction in a guest's Chrome in the instrument's arrangement and in a single page reloaded after a tab is added: the tab's fate (session ended, or dropped from the layout with its session alive), with the count of attempts.
2. If a repair: a pin red first on its own assertion that a tab added a moment before a page's load is in the layout after it, on both pages; `make web-check` green at the commit in the owning guest.
3. If the arrangement is the instrument's own: the item says so, with the reading that shows a user cannot reach it.
