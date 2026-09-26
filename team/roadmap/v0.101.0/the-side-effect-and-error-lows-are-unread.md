# The side-effect and error-handling lows were never read

Status: landed on 2026-09-25 as a reading lane with no code change; accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Rust-lows follow-up. A source reading against `main` at `6237c2677`.

## What was seen

The v0.100.0 triage of `dev/rust-review-lows.md` read the 116 findings of the five defect-shaped kinds. The 82 side-effect and error-handling lows (15 and 67 in the ledger's by-kind table) were not read, so none of them has a disposition or a re-verified line against the current tree.

## What to do

Read each against `main`, give it a disposition in the ledger (fixed, refuted or carried with a reason), and raise any real defect as its own item or fix it with a test shown red first.

## What shipped

A reading lane read all 82 findings against `main` at `f063ddd45` and wrote a disposition for each into the development ledger `dev/rust-review-lows.md`, with a `path:line` at that sha: 6 real, 59 real-minor (the mechanism holds and the consequence is negligible), 16 stale (the code changed under them) and 1 duplicate, none false. The lane fixed nothing; each real finding is an item of its own.

- The six real findings are raised as [a-watcher-loss-leaves-the-code-report-stale](a-watcher-loss-leaves-the-code-report-stale.md), [terminal-env-overrides-are-silently-dropped](terminal-env-overrides-are-silently-dropped.md), [a-corrupt-devserver-config-re-mints-the-library-identity](a-corrupt-devserver-config-re-mints-the-library-identity.md), [the-detached-daemon-keeps-the-launching-shells-directory](the-detached-daemon-keeps-the-launching-shells-directory.md), [a-scripted-reports-disable-exits-zero-having-changed-nothing](a-scripted-reports-disable-exits-zero-having-changed-nothing.md) and [a-keychain-failure-freezes-a-connected-gateways-roster](a-keychain-failure-freezes-a-connected-gateways-roster.md).
- The duplicate, review line 3251 (the untyped error `ensure_copy_destination_absent` returns), is acceptance 3 of [two-copies-to-one-free-name-can-collide](two-copies-to-one-free-name-can-collide.md).
- The lane's own re-read covered every real finding, the duplicate and four stale or renamed-symbol rows; the other rows rest on its reading subagents' citations. The report is `dev/v0101-tasks/report-unread.md`.
