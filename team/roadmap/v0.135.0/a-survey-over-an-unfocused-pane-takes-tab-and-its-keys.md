# A survey over an unfocused pane takes Tab and its keys

Status: split from the keyboard-owner row's amendment by the lead on 2026-11-19 and carried to v0.133.0 under the owner's "move them and cut"; the owner accepted the amendment itself on 2026-11-17. Not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record: the amendment of 2026-11-17 to [the keyboard-owner row](../done/the-rich-prompt-takes-the-keyboard-from-a-survey-a-dialog-an-overlay-or-the-launcher.md), accepted by the owner by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"), with option (a) below as the draft recommended; he may revisit it before the build. Item 5 of `dev/v0131-team/reports/owner-candidates-2.md` in the development tree, from `dev/v0131-team/reviews/review-surveykeys-3.md`, note 1, found pre-existing while [the survey row](../done/a-terminals-survey-takes-the-keyboard-from-another-pane.md) was reviewed. The keyboard-owner row shipped in v0.132.0 without it, and at that release's cut the owner moved what was not done to v0.133.0. The same owner rule as the keyboard-owner arbiter, from the other side: a survey card that does not own the keyboard can still receive it.

## What is there now

Read at `b0bf23e9a`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- The keyboard-owner arbiter (`state/keyboardOwner.svelte.ts`) ranks the survey over the focused pane's active terminal as an owner, and `mayFocus` keeps a card that is not the owner from taking the keyboard by its own focus paths. Nothing keeps the keyboard from reaching such a card by sequential navigation.
- The card's option, follow-up and dismiss buttons are plain `<button>`s (`components/BubbleOverlay.svelte:210-242`), in the page's Tab order whatever pane is focused; the card itself has `tabindex="-1"` (`:195`). A Tab or Shift+Tab from the focused pane's element walks into them. No press happens, so the active pane does not move: the pane sets it on `mousedown` (`components/Pane.svelte:1514-1518`).
- The card's keydown (`onCardKeydown`, `:156-176`) answers 1 to 9, F, and X or Escape whenever the event reaches the card, without reading `ownsKeyboard()` (`:45-48`). So with pane B focused and a survey over pane A's terminal, a Shift+Tab into A's last option button and a bare `1` answers A's survey while B is the active pane, the focus ring visible on the button. Every pointer path sets the active pane first, so only keyboard navigation reaches this.
- When its survey loses the keyboard, the overlay blurs a focused element inside the card only if the card took the keyboard itself (`if (focusedSurveyId && !eligible && card?.contains(document.activeElement))`, `:101`). A survey that appeared while its pane was unfocused never set `focusedSurveyId`, so focus that reached its card by Tab is never released.
- `design.md`'s survey paragraph says an unfocused pane's survey keeps its answer buttons usable, and the manual's teams page (`web/packages/marketing/src/pages/manual/teams.html:155`) says you can click an answer there; neither says Tab cannot reach it.

## Desired contract

1. A survey over a terminal whose pane is not the focused pane is not reachable by sequential keyboard navigation: its option, follow-up and dismiss buttons leave the Tab order while that pane is unfocused and return to it when the pane is focused. A press on them still answers, and sets the active pane first, as today.
2. The card's keys (1 to 9, F, X, Escape) answer only while the survey owns the keyboard; a key that reaches the card otherwise is not consumed. The overlay's release at a pulse or an ownership change applies to any focus inside the card, whether or not the card took the keyboard itself.

## Boundaries

- The card's buttons, keydown and focus effect in `components/BubbleOverlay.svelte`, with their tests. The arbiter's rules are consumed, not changed.
- A window-wide survey is not touched.

## Acceptance

1. Mounted tests, red at the base: two panes, a survey appears over the unfocused pane's terminal; its buttons have `tabIndex` -1 while the other pane is focused and 0 once its pane is focused; focus placed on an option button by script (the Tab model of `components/Pane.browserFocus.test.ts`) and a typed `1` answer nothing while the other pane is focused, and the next pulse moves the keyboard off the card; a click on an option answers and makes its pane the focused one. One mutation per guard turns a case red: the Tab-order rule, the key guard, the release's dropped `focusedSurveyId` condition.
2. A browser check in a guest, on both backends: pane B focused, a `cs terminal survey` on pane A's terminal; Shift+Tab from B's terminal does not land in A's card, and a `1` reaches B's PTY as byte 31; a click on A's option answers it.
3. `design.md`'s survey paragraph and the manual's teams page say that an unfocused pane's survey is answered by a press only.

## The options as drafted

- (a) Buttons leave the Tab order while the pane is unfocused, plus the key guard and the release (recommended: closes the only path in, inside the existing model where sequential focus never moves the active pane).
- (b) Focus entering the card makes its pane the focused pane, as a press does. A new precedent: nowhere else does Tab across panes move the active pane.
- (c) Key guard and release only: a focus ring sits on a button that answers nothing until the next pulse.

## Built, 2026-11-25: option (a), merged at `a59ba6aba`

Built on the integration line as option (a), Ghostty only (the acceptance's "both backends" reads as Ghostty since no terminal opens on xterm.js). While a per-terminal survey does not own the keyboard, nothing in its card is in the Tab order (its option, follow-up and dismiss buttons, and every link or control its body renders), its keys (1 to 9, F, X, Escape) answer nothing and are not consumed, and focus inside the card is released at the next pulse or change of owner whether or not the card took it; all of it returns when its pane is focused, and a press still answers and focuses its pane first. A window-wide survey is unchanged, now pinned by a test. `design.md` and the manual's teams page say an unfocused pane's survey is answered by a press only.

Read: mounted tests red at the base and green at the tip, one mutation per guard; browser check 348 (Tab order, a Shift+Tab walk from pane B's tab label past a linked body, a typed `1` reaching B's PTY as 0x31 and answering nothing, a click answering and focusing pane A) red at the base and green at the tip in Chrome in an isolated guest, and the terminal browser suite green beside it; the web gate on the merge commit; three reviews. One existing test changed: a survey-store case had built a card whose tab is in no pane, a state the product never mounts. Not read: WebKitGTK and the Mac (WebKit may skip links on Tab by default). Open, not built: a body's raw-HTML shapes the rule does not reach (an SVG `xlink:href` link, a `details` with no `summary`, a styled scroller), and three test pins, a follow-up; outside the row, Tab can reach another pane's terminal without moving the active pane, and a body link followed in a plain browser navigates the app's tab away.


## The body's remaining shapes, 2026-11-25

Merged at `91e7586a2`: while its pane is not focused, a survey's body also holds out of the Tab order SVG links in either spelling, an image map's area, a `details` with or without a `summary`, a scroll container by its computed overflow, form controls, media with controls, the video embed's frame and an element with an authored `tabindex`, and each gets its own value back when the pane takes focus; a window-wide survey is untouched. Browser check 348 gains a leg that presses a link in the unowned body: at the tip in Chrome the press lands on the link, its pane becomes the focused one, the survey stays up and no reply or PTY byte follows; with the body planted `inert` only that leg fails, the press landing on the card. Read: unit and mounted cases for every kind, one mutant per guard, the web gate at the tip and at the merge. Not read: Tab passing a held `details`, scroller, media or embed frame in a real engine (jsdom reads the attribute only); WebKitGTK and WKWebView for the whole body rule. Open, in a follow-up: a MathML body makes jsdom's style read throw and takes the terminal tab down under jsdom (no browser trigger known); an element made editable by `-webkit-user-modify` is not held; check 348 does not yet walk the raw-HTML shapes.
