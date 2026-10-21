# A Rich Prompt reopened before its closing write lands shows and keeps the older draft

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the landing gate's read of check 177's one red in three alone at the integrated tip; closes in the round.

## What was seen

Hiding the Rich Prompt card, by its close button or the terminal menu's Hide Rich Prompt row, unmounts it; the card's draft write is started on the way out (`RichPrompt.svelte`, `closeCard` and the unmount's `flushWrite`) and nothing awaits it. Showing the card again mounts a new card that reads the stored draft (`mountDraft` through `loadContent`) with nothing that waits for a write this window has in flight, and an open card takes no `draft` frame. So a card reopened before its closing write has answered shows the server's older draft, and then writes that older text back 400 ms after its mount, which lands after the closing write: the text typed before the close is gone from the draft. Check 177 showed it at `4e118d262` in the integration guest under a parallel cargo load: the close's three draft writes answered after five seconds (a filesystem stall under the shared pool, not a page-side queue), the card reopened in between showed the earlier text, and its own write came last (`dev/v0109-team/evidence/Lead109/int/proof-chain-int3/run-3/`, the timeline and the screenshot; the read in `dev/v0109-team/followups/followup-Frontend109-Lead109-4.md`). A person meets it by typing, hiding the card and showing it again within one round trip plus the server's write, seconds on a remote devserver or a loaded disk. The race is older than the close button: the menu toggle at the base closes through the same unmount write.

## Desired contract

A Rich Prompt shown again after it was hidden shows the draft as it was when it was hidden, whatever the write's latency, and the stored draft ends holding that text.

## What to do

Build, on the read above: in `RichPrompt.svelte` alone, a module-level map by draft path shared across card instances, holding the path's write chain and the text this window last intended for the path. Every write the card makes goes through one helper (`flushWrite`'s PUT, the gone-draft rebind's write and the seed write) that appends to the chain, reads the content when its link runs rather than when it is appended, keeps at most one queued link per path (a later flush replaces the queued one), swallows a rejected link so a later mount is not blocked, and clears the intended text when a write of that text answers. A mount that finds an intended text for its path shows it at once and writes it through the chain, waiting on no write; a mount that finds none awaits the chain and then reads. No server change. Pins, red first, in a mounted test over the draft api mocks (`RichPrompt.chrome.test.ts`): `api.write` held on a deferred promise and `api.read` answering what the last landed write stored; type, close, mount the card again: the typed text shown and, once the write resolves, stored; a write held forever, then a reopen: the typed text shown at once and the card's own write queued behind the held one; a rejected write neither blocks nor rejects a later mount; two flushes during one deferred write give exactly one more PUT carrying the later text; a gone draft rebinds, the card closes and reopens with the rebind write deferred, and the reopened card shows the text. Red at the parent on the shown text; mutants, one per guard: the mount's intended-text read dropped, the rebind write unchained, a rejected link that stops the chain, the queued link not replaced. Check 177 is unchanged (its wait for "kept draft" is what the card then shows); run it alone three times at the commit with a parallel cargo job beside it.

## Boundaries

`web/packages/workspace-app/src/components/RichPrompt.svelte` and `RichPrompt.chrome.test.ts`, the workspace app's `design.md` sentence on the card's draft. Not changed: the server's draft write, the draft frames, check 177, the menu row, `state/tabs.svelte.ts`. Outside the contract: a terminal moved to another window while its closing write is in flight (the move carries the draft path and the receiving window's card reads on its own; the chain is per window), and a reload while a write is in flight (the page's unload cancels the draft PUT, which carries no keepalive, and the reloaded card reads the older draft; older than this row).

## Acceptance

1. The mounted pins red at the parent on the shown text and green at the commit; the mutants red; the commands and logs recorded here.
2. `make web-check` green at the commit; check 177 alone green three times at the commit beside a parallel load, the runs' timelines retained.
