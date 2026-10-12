# Check 131 timed out once waiting for a new draft beside an indexer warning

Status: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's record (Web's quiet whole run at `6a0e16b16`); the record read on 2026-10-12 (see "Reading"), the reproduction's route chosen, not yet run.

## What was seen

In one whole browser suite run on a quiet host, check 131 `drafts-image-promote` failed in its `newDraft` helper after 20,591 ms: `timed out waiting for the new draft in the server's list`. As the check began, the server log recorded an indexer per-file apply warning for a file that had disappeared. Check 130 `drafts-lifecycle` and the later draft checks passed in the same run. The check was green in seventeen other whole runs of the round (3.9 to 4.5 s), the lead's and Web's runs at the candidate among them. The check opens no terminal and nothing in v0.105.0 touches drafts or the indexer. Record: `dev/osc7501-team/evidence/Web7501/task10/guest-results/full/` in the round's archive.

Not established: why the draft did not appear in the list (the indexer's warning, a watcher miss, a list cache), and whether the vanished file the indexer named is the check's own.

## Desired contract

A draft created by the page appears in the server's list within the check's bound, or the list's refresh says why it cannot.

## What to do

Read the saved timeline and the server log around the indexer warning; reproduce with the indexer made to see a file disappear during a draft creation; decide whether the list refresh or the indexer's apply path is at fault; pin it red first.

## Boundaries

The drafts list route, the indexer's per-file apply path and check 131; nothing in the terminal or program status code.

## Acceptance

1. The cause written down with its source lines and a run that shows it, or the red recorded as unexplained after a bounded reproduction attempt with its count.
2. If a cause: a pin red first on its own assertion and check 131 green in twenty runs in a loop.

## Reading 2026-10-12

The frontend seat read the saved timeline and the server log of the one red run (`reports/chk131-reading-Frontend106.md`): the indexer's per-file apply warning named `smoke-drafts-mv2l1vup/lone.md`, which was check 130's promoted target, not a file of check 131's own; check 131 timed out in its first `newDraft` poll after 20,590 ms; checks 130, 132 and 133 passed in the same run. The recorder kept neither the page's draft POST nor the runner's `/api/drafts` response bodies, so the record cannot assign the warning as the cause or rule it out. The lead's ruling on the route: a deterministic `chan-server` test first, in the drafts route's tests, that removes the indexed workspace file after the indexer's metadata check while a draft is created and listed, in a guest with no browser; only if the draft stays visible there, one bounded browser run of check 131 against a built `chan` with the page's POST and each list response captured. No owner answer is needed.
