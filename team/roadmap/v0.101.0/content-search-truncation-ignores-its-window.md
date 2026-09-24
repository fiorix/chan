# Content search can report a truncated result as complete

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Rust-lows follow-up (worklist L81, the contract finding); it needs an owner decision on what the flag promises. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended, which settles the open question: the flag means more hits exist than were returned. It is set from the fetch window's cut-off as well as from the collapse, and both cases are pinned in a test.

## What was seen

`run_content_search` (`crates/chan-workspace/src/workspace_search.rs:837`) sets `truncation.content_hits` from `collapsed.len() > request.limit` (`:895`), where `collapsed` is what the fetch window returned. When the window itself cut the candidates short, the flag can read false for a result that is incomplete.

## What to do

Decide whether the flag means "more hits exist" or "more hits were fetched than returned". Then set it from the fetch window's own cut-off as well, and pin both cases in a test.
