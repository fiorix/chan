# The connecting window offers Retry before it has tried

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (findings DESKTOP-01 and DESKTOP-04, medium, trivial), re-verified against `main` at `d3de0180b` by reading. `desktop/src` ships in every desktop release on three platforms and has no test and no static check.

## What was seen

`desktop/src/connecting.html` ships its actions row with the `hidden` attribute and `connecting.js` only flips `els.actions.hidden`. The author rule `.connecting-actions { display: flex }` in `connecting.css` beats the user-agent `[hidden] { display: none }`, and no `[hidden]` override exists in `desktop/src`. So Retry and Disconnect are live from the first frame of every remote devserver connecting window, and a user can tear down a window that is connecting normally.

The elapsed timer is rewritten once a second inside a `role="status" aria-live="polite"` container, so a screen reader queues the whole row every second for the life of the window, and a second polite region announces each attempt twice.

## Desired contract

The actions appear when the connection has failed or timed out, as the markup intends. The live region announces state changes, not the clock.

## Boundaries

`desktop/src/connecting.css`, `connecting.html` and `connecting.js`. The close-key handlers in the same files are left alone here: how they match keys belongs to [shortcuts-ignore-the-keyboard-layout](shortcuts-ignore-the-keyboard-layout.md). The 579 dead lines of `desktop/src/styles.css` and the hand-copied palette are the next version's sweep.

## Acceptance

1. The actions row is not displayed until `connecting.js` reveals it, checked against the shipped stylesheet and not against the attribute alone.
2. The elapsed value sits outside any live region, and each attempt is announced once.
3. `desktop/src/*.js` passes the static check that [frontend-gate-holes-let-broken-bundles-ship](frontend-gate-holes-let-broken-bundles-ship.md) adds.
