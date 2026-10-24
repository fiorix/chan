# Closing an ended terminal asks whether to close a running process

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

## What was seen

Closing a terminal tab whose process has exited, or whose session never started, asks "<title> is still running. Close anyway?". `closeRisk` in `web/packages/workspace-app/src/state/tabs.svelte.ts` calls a terminal live when `isLiveTerminal` finds its input sink, and every mounted terminal component registers one, ended or never started; the message names a process that is not running. The same test lets a tab that holds a session but no mounted sink, which a render boundary's caught throw leaves behind, close without the confirm, its session killed through the close route. Seen in Chrome for Testing 156 with the xterm.js backend on an exited shell, an exited command terminal and a tab whose server had not answered.

## Desired contract

A terminal with no live session closes without a confirm; the confirm and its words are for a terminal whose session is running.

## What to do

`isLiveTerminal` reads the tab's session id alone, so the confirm guards exactly the closes that kill a session (both kill paths key on the session id) and a terminal that holds none is not live; the single and multi-tab messages change together through `confirmCloseTabs`, whose count then excludes ended tabs; pins red first for an ended terminal and a never-started one, the live case unchanged, and a tab with a session and no mounted sink still asking.

## Boundaries

`state/tabs.svelte.ts` at `isLiveTerminal` and `closeRisk`, and their tests. Not changed: the confirm for a live session, the sessionless cross-window move's own close.

## Acceptance

1. Pins red first at the parent for the ended terminal and the never-started one, each asked there, and for a tab with a session and no mounted sink, closed there without asking; the live case's pin green; one mutant (the session id read dropped) red.
2. `make web-check` green at the commit.

## Lead's rulings 2026-10-22

On the review seat's read of the sessionless move, 00:41Z: "`isLiveTerminal` reads `!!t.terminalSessionId` alone, so the confirm guards exactly the closes that kill (both kill paths key on the session id); a third pin, a tab with a session and no sink asks; the single and multi-tab messages change together through `confirmCloseTabs`, and the multi-tab count then excludes ended tabs."

On the frontend seat's open point at the sessionless move's hand-back, 12:22Z: "endcls's commit adds the pin of the live move's drag-end closing with no question and marked as a move, so the `force` keeps a red mutant (your XM11) at endcls's tip; name the pin and its mutant in endcls's hand-back."

## Built 2026-10-22

`isLiveTerminal` in `web/packages/workspace-app/src/state/tabs.svelte.ts` reads the tab's session id alone: a terminal is live when its tab holds a session id, not when its component registered an input sink, which every mounted terminal does whether or not it runs. Both paths that kill a session on close key on the session id (the mounted tab's `close` frame, and the close route `runTerminalCloseSink` takes for a tab whose component is not mounted), so the confirm asks exactly for the closes that kill. `closeRisk` and `confirmCloseTabs` read it unchanged, so the single and the multi-tab confirms change together and a close of several tabs counts only the running sessions. The tests that stand a live terminal in for the confirm (`state/closeTabAfterPrompt.test.ts`, `state/fileTabMoveDuringLoad.test.ts`, `state/tabs.drawingSave.test.ts`, `App.paneMode.test.ts`, `state/tabs.test.ts`'s live case) give it a session id beside its sink; the close-route tests answer the confirm the route meets for a running session, and the moved tab's close there is forced as the source's drag-end forces it.

Acceptance 1, in the frontend seat's guest (logs under `dev/v0109-team/evidence/Frontend109/endcls/build/`). `components/TerminalTab.closeConfirm.test.ts` (new) mounts the tab over the stand-in xterm and socket and closes it as its X does: a running terminal asks "... is still running"; one whose shell exited and one whose socket never connected close without asking. In `state/tabs.test.ts`, a running session with no mounted component asks, and its route is not called when the answer is no; a close of a running and an exited terminal names the running one alone ("build is still running", no "live terminals"); the live case asks. With `tabs.svelte.ts` as it is at the parent `e7a1220a2` and these tests (`redgreen-1`), six fail on their own assertions: the ended and the never-started pins (the parent asks "Terminal is still running. Close anyway?"), the unmounted session's pin (no question; the route runs), the count's ("2 live terminals is still running"), and the two close-route tests, which answer the confirm a running session meets and find none there; the live case passes at both. One mutant, the input sink read again in place of the session id, fails the same six. The live move's drag-end pin (`components/terminalMoveAcrossWindows.test.ts`: the source lets the tab go without a question, marked as a move) passes at the parent and here; dropping the drag-end's force fails it alone, since a tab with no session closes without asking either way.

Acceptance 2: `make web-check` at `7a5739b1a`, this commit without this section (`gate-1.log`, rc 0, 18 minutes): svelte-check clean in every package, web-shared's 218 tests, the launcher's 624, the workspace app's 7551 in 592 files and the profile's 20, both production builds, the web lock unchanged and the checkout clean after. The browser checks that close or move a terminal, 104 (a live terminal closed, its confirm accepted when shown) and 124 (the moves with no session, no question), pass at the commit and at the parent (`c104-124-tip-1`, `c104-124-parent-1`); neither reaches the changed close, which the mounted pins read.

The count's sentence agrees with it (`confirmCloseTabs`): one running terminal reads "<name> is still running", several "N live terminals are still running". A close of two running sessions reads "2 live terminals are still running. Close anyway?" (`state/tabs.test.ts`); it fails at its parent `59430006a` on "is", a mutant saying "is" for several fails it, and one saying "are" for one fails the three pins of a single running terminal (`dev/v0109-team/evidence/Frontend109/endcls-verb/build/redgreen-1.log`); `make web-check` passes at `d47da9073`, that commit without this paragraph (`endcls-verb/build/gate-1.log`). The sentence's parts hold the terminals' one entry, so the plain confirm's " and " never joins two, and the confirm beside refused files joins its sentences with a space.

A limit, recorded with no code repair: a session that ends while the page is disconnected keeps its id in the tab until the socket's next answer, so a close in that window asks about a session that no longer runs, and the confirmed kill does nothing.
