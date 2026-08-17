# An external edit intermittently never reaches an editor with unsaved text

Status: REGISTERED 2026-08-10, ruled forward out of v0.88.0 rather than into it. Found while closing [browser-smoke-is-unrunnable-and-rate-based](../done/browser-smoke-is-unrunnable-and-rate-based.md): removing that item's network-idle waits let a content assertion run for the first time, and it failed. Accepted as not data loss and deliberately left out of scope, on a precondition recorded below that a later change could invalidate.

## What

A file is open in the editor with unsaved typed text in the buffer. The same file is then written externally on disk. Intermittently, the new content never reaches either the server's read API or the editor, and does not arrive later.

Observed for 60 seconds, sampled every 500ms:

- `GET /api/files/<path>` returns the **old** content.
- The editor shows the **old** content.
- The file on disk holds the **new** content, verified by reading it directly on every run.

## The distribution is bimodal, which is what makes it a defect rather than a slow path

Every converging run lands between **516ms and 535ms**. Every non-converging run is still stale at a **60s ceiling**. Across more than twenty runs nothing has ever converged at 7s, or 20s, or 40s.

So the reconciler is not running late under load. On any given run it either does the work in about half a second or it does not do it at all. That distinction was established deliberately, because a bound that is merely too short and a read that is simply wrong are indistinguishable from a single sample at a fixed delay, and the check that first exposed this sampled once after a fixed 5s sleep.

## The rate drifts without a code change, which is the trap

| when | converged | not |
| --- | --- | --- |
| first series, two trees interleaved | 8 | 3 |
| after a rebuild whose only source deltas were a doc comment and a `mod tests` body | 4 | 0 |
| immediately after that | 1 | 1 |
| a ten-run acceptance series of the check that hunts it | 10 | 0 |

The shipped binary was byte-identical in behaviour across all of those. **A clean series is not evidence this is fixed**, and the ten-for-ten above is the strongest available demonstration of that: it was measured after the failures, on the same runtime, and proves nothing.

Host load does not predict it either. Failures were observed at `loadavg` 36.0, 26.4 and 18.6 against successes at 35.6, 33.6, 29.4, 27.7, 34.2, 17.4, 15.7 and 14.8 on eight cores; the distributions interleave. A separate low-load observation of five consecutive convergences at `loadavg` 2.79 is consistent with a threshold below the sampled band and equally consistent with no effect, at roughly a one-in-five chance of arising by luck on the measured rate.

## Why it was accepted rather than fixed, and the precondition that carries

Accepted as not data loss: the external edit survives on disk, and the conflict banner appears from the external write onward, before any save is attempted, offering both `Reload from disk` and `Keep mine`. The banner is therefore load-bearing to the decision rather than incidental to it.

> If a later change makes the save a no-op **while that banner is absent**, that acceptance does not carry over. What was accepted is a pending decision the user can see and act on, not a save that does nothing.

## Reproducing it

The probe is preserved as a browser-smoke check. Drop it in `scripts/e2e/browser-smoke/checks/` and run `SMOKE_ONLY=199 SMOKE_SKIP_BUILD=1 node scripts/e2e/browser-smoke/run.mjs`. It records rather than asserts, so a non-converging run still returns its evidence.

Reading a run, and the distinction that matters most:

- both convergence fields around 500-600ms: converged.
- both `null` with `converged: false`: the defect.
- **no probe line emitted at all**: the run **aborted**, it did not fail. Count it as neither. The usual cause is the opener refusing because the window is not yet addressable, which is a different outcome, and folding it into the rate inflates the defect.

The preserved copy carries the window-liveness barrier that makes that abort rare. An earlier copy did not, and a reproducer without it turns aborts into apparent confirmations of the defect.

## Why this is worth a real item

The path has taken four consecutive releases of hardening and one of them, `mtime-cas-silently-overwrites-external-edits`, was a silent data-loss path that survived three releases. This was found on the first day the browser suite could run in a container, by the first execution of a content assertion that had previously been unreachable behind a wait that timed out first.

Its most dangerous property is that it goes quiet. Anything that closes it needs the bimodality and the drift above as the standard of proof, not a green series.

## Not established, deliberately

Whether it is a regression or long-standing; whether it is a data-loss path under any sequence; and any diagnosis of the mechanism. Nobody has read the reconciler. All three were left open rather than guessed, and the measurements above are the entire evidence.

## Resolution

Resolved 2026-08-17 as not a defect. The non-converging arm is a retained conflict, a stable terminal state rather than a reconcile that never ran. Once the session enters `SessionState::Conflicted`, automatic flushing pauses. A later `reconcile_conflicted_locked` with `hash == retained` refreshes the retained disk token and returns, leaving the authority and durable baseline frozen until the user chooses a side. The read API therefore serves the old authority indefinitely rather than serving the external edit late.

The two modes differ because the durable ancestor can change while the browser is typing. Without an intermediate flush, the baseline remains the original V1: the local prefix insertion and the external V1-to-V2 edit do not overlap, so the merge succeeds. A partial flush can instead commit a typed prefix as the durable baseline while later keys leave a newer dirty authority. Relative to that intermediate baseline, the external side deletes text that the local side extends, so the edits genuinely overlap and retaining all three sides is correct.

Commit `d8cdab63` adds `external_edit_after_intermediate_flush_enters_retained_conflict`, which constructs that transition deterministically and passed in 0.02s. The unchanged control `same_line_nonoverlapping_external_edit_merges_without_conflict` proves that the same endpoint triplet merges when the durable baseline has not advanced. For the conflicting inputs, the banner appears before any save and offers both `Reload from disk` and `Keep mine`. That preserves both sides and satisfies the visible-decision precondition under which the behavior was accepted as not data loss.

Whether the historical red runs had the intermediate-baseline input shape cannot be established. The preserved archive contains no durable baseline, authority version, or flush epoch, and was searched for those records rather than assumed not to have them. The preserved banner screenshot does establish that the non-converging arm was conflicted.

Two test risks remain. `56-external-edit-matrix` fails solely when `editorHasV2` is false and never queries the banner, so it can go red on a correct visible retained conflict. The suite also never presses Ctrl+S while that conflict is pending or asserts the `Keep mine` resolution, leaving the silent-no-op-save half of the original acceptance precondition unguarded.
