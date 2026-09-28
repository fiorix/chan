# A released command that succeeds paints its success over what the deck shows by then

Status: raised for a decision on 2026-09-28 by the lead, who found it beside the production diff of where a command's error shows, which landed that day with [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md); read in code at `3fa7d86de` and again at `30ffb8027`, and not run. It is older than that landing: the same success path is on `main` at `efad59095` (`web/packages/web-shared/src/components/CommandDeck.svelte:278-285` there). Recommendation: accept for v0.101.0, as an order of its own in the lane that built where a command's error shows.

## What was seen

The shared command deck lets the user release a pending card: Escape on it, or its Dismiss, runs `releaseOperation`, which gives the card back to the results list and drops the run's token, and whose comment says that the result of the command behind it stays off screen (`web/packages/web-shared/src/components/CommandDeck.svelte:349-356`, called at `:396-398` and `:597`).

The error's path keeps that promise since this landing: a rejection paints its card only while the run still owns it, and otherwise goes to the host (`reject`, `:248-265`, the test at `:249-251`). The success path does not. Once the command's promise answers (`:290`), it checks only that the deck's draft is the same object (`:294`), and the run's token only when the answer is a confirmation (`:299`). A success whose item is dismissed at once then calls `succeed` (`:311-313`); any other paints a success card into the draft (`:315`) and calls `succeed` 260 ms later if the draft is still the same object (`:316-318`). `succeed` runs the host's `onSuccess` (`:221-231`), which in both hosts closes the deck and clears its draft (`succeeded`, `web/packages/launcher/src/components/CommandLauncher.svelte:656-659`; `web/packages/workspace-app/src/components/CommandLauncher.svelte:729-732`).

So a pending card that the user released, whose command then succeeds, gets a success card painted over whatever the draft shows by then, the list, a newer command's card or a question, and the host closes the deck and clears its draft under the user. The commands that keep a pending card are the awaited ones, the window commands of both decks among them (`web/packages/launcher/src/components/CommandLauncher.svelte:256`, `:311`; `web/packages/workspace-app/src/components/CommandLauncher.svelte:401`, `:500`, `:524`), and since this landing a window command can wait up to sixty seconds for its page (`web/packages/web-shared/src/window-page.ts:9`). An example, inferred and not run: in a launcher that a devserver serves to a browser, while the devserver restores its sessions, run New window on a workspace from the deck, press Escape to release its card, and start a second command or open a question; when the first command's page answers, the deck closes and its draft clears.

**Read again at `fe2708e45` on 2026-09-28,** when the waiting windows' wait landed with [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md): a Focus or a Show of a window that another page is still opening now follows that page's wait before it answers, where it answered at once, and the follower's pending card can last the other wait's remaining lease, up to sixty seconds, and then a wait of its own of sixty (`web/packages/web-shared/src/window-page.ts:122-160`, `:153`, `:178`; `web/packages/launcher/src/state/computerActions.ts:127-150`; `web/packages/workspace-app/src/api/libraryWindows.ts:196-221`). That widens the time in which such a card can be released and its command's success then paint over the deck. Read, not run.

## Desired contract

A command whose card was released, or taken by a newer run or a question, shows its success nowhere and closes nothing: the deck paints a success card and runs its host's success handler only for a run that still owns the card, as it paints an error only for one.

## What to do

Give the success path the ownership the error path has: after the command answers, and again after the success card's 260 ms, paint and call `succeed` only when the deck is open on the draft that ran the command and the run still holds its token and, for an awaited run, its own pending card; otherwise retire the run's own pending card if it is still on the draft, and do nothing else. Say in both design documents which run shows its success. Red first: deck tests in which an awaited command's card is released and the draft shows the list, a newer command's card or a question when the command succeeds, asserting that the draft keeps what it shows and `onSuccess` is not called.

## Boundaries

`web/packages/web-shared/src/components/CommandDeck.svelte` (`execute`) and its tests, `web/packages/launcher/design.md` and `web/packages/workspace-app/src/design.md`. The hosts' `succeeded` handlers are unchanged.

## Acceptance

1. A released awaited command that succeeds paints nothing and runs no success handler, with the draft showing the list, a newer command's card or a question; pinned red first.
2. A command that still owns its card shows its success and runs its host's handler as before; pinned.
3. Every new pin has a mutation that turns it red at its own assertion, and the two design documents say which run shows its success.
