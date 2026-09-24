# The side-effect and error-handling lows were never read

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Rust-lows follow-up. A source reading against `main` at `6237c2677`.

## What was seen

The v0.100.0 triage of `dev/rust-review-lows.md` read the 116 findings of the five defect-shaped kinds. The 82 side-effect and error-handling lows (15 and 67 in the ledger's by-kind table) were not read, so none of them has a disposition or a re-verified line against the current tree.

## What to do

Read each against `main`, give it a disposition in the ledger (fixed, refuted or carried with a reason), and raise any real defect as its own item or fix it with a test shown red first.
