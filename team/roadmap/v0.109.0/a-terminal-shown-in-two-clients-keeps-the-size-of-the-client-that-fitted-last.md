# A terminal shown in two clients keeps the size of the client that fitted last

Status: built on 2026-10-23 on the owner's branch; the section Built 2026-10-23 holds the evidence; it closes at the GA as shipped.

## What was seen

Two clients can show one terminal session, for example two chan-desktop processes holding the same window id. The PTY takes the grid of whichever client sent one last, and a shown view sends its grid only when its own grid changes. When a layout change made in one client reaches the other, the other fits its own narrower pane and sends its grid last, so the PTY keeps that width while the first client's renderer draws a wider grid until its pane is resized.

## Desired contract

A shown terminal view whose grid the PTY does not hold sends its grid again on the next trusted key press, pointer press or paste in that view, before the input that event produces, and never in answer to another client's resize frame or to chan's own focus moves, so two shown clients cannot resize the PTY back and forth: the PTY follows the client last used. Automatic fits send a grid only when it changes. A sent grid counts as the PTY's at once, so further keys before the server's echo send nothing more. The root `design.md` terminal sizing paragraph states the rule.

The owner's word of 2026-10-23, bringing the build to the round: "done with both patches, 1 for the pty resize, 1 for the `cs session` and being able to identify a client to detach other clients when needed".

## What to do

Land `d7d9144b8` (on `investigation/client-attachments`, over the frozen commit `759aac125`) as this row's commit after the review seat's read, with this row and its closing section, its message in the repository's form.

## Boundaries

No change to a hidden view's conditional sizing, a restart's reattach order or the server's size rule. Two desktop processes on one window are out of the suites' reach, and no hand smoke is run: The owner's word of 2026-10-23: "there will be no rc and no manual testing in this round, we're going from here to ga, tag and release". That case stays unverified in chan-desktop.

## Acceptance

1. The size ownership suite's new cases pass on the xterm and Ghostty backends and fail without the capture listeners; a mutant without the trust check and one without the early grid record each fail their pins.
2. `make web-check` passes at the landed commit in a guest at the pinned Node 22, and the combined gate passes there.
3. The browser suite passes whole and with every check alone at the frozen commit that ships.

## Built 2026-10-23

The product change is `d7d9144b8`, over `759aac125`; its integration adds this row and a message in the repository's form. `TerminalTab.svelte` listens on the tab root in the capture phase for key presses, pointer presses and pastes; `shouldReclaimPtySize` in `terminal/resize.ts` answers yes for a trusted event while the PTY holds a known grid other than the renderer's, and `publishLocalSize` then sends the renderer's grid and records it as the PTY's at once, so a second key before the server's echo sends nothing. Hidden views, reveal publication, restart declarations and the server's last-size-wins rule are unchanged. The root `design.md` terminal sizing paragraph states the rule.

Acceptance 1, the review seat's run at `d7d9144b8` in its guest (Node 22.23.3, one Vitest worker, logs under `dev/v0109-team/evidence/Review109/ptyown179/export-2/`): `TerminalTab.sizeOwnership.svelte.test.ts` and `resize.test.ts` pass 75 tests, 66 mounted cases on the xterm and Ghostty backends and 9 for the predicate (exit 0). The tip's new mounted cases run against `759aac125` fail six resize assertions beside four passing controls (exit 1). Removing the key, pointer or paste capture, the `isTrusted` check or the early grid record, or moving the key reclaim to the bubble phase, each fails its pin on both backends (exit 1), and the restored suites pass 75 again. Sixteen independent probes pass (exit 0): the resize frame before the input for all three events, hidden and revealed views, a third client's grid arriving before this client's echo, a frame the closed socket did not send, a backend replacement and a disposed view.

Acceptance 2: `make pre-push` in the integration guest at `0ddfbb658`, which contains that product change, exits 0 in 1,686 s with `make web-check`'s 7,675 workspace app tests under Node 22 (`dev/v0109-team/evidence/Lead109/int/gate-cssess-tip/`). The containing commit's symlink-temp tests exit 0 and its Windows test-target check exits 2 on clsess. Acceptance 2's gate at the landed and frozen commit and Acceptance 3's whole and individual browser runs remain pending; their results belong in the release report.

Not exercised: two chan-desktop processes on one window, by the owner's word that the round runs no manual testing.
