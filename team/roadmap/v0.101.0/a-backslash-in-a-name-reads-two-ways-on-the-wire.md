# A backslash in a file name reads two ways on the wire

Status: raised during v0.101.0 on 2026-09-26 by the independent review of the frontend dedup order that unified `parentDir` and `basename` (`dev/v0101-team/reviews/review-Frontend-4.md`, finding 5, in the development tree). A source reading against `main` at `cdd266b09`; not reproduced.

## What was seen

On Unix a file may be named `a\b.md`. chan-workspace keeps that raw name in the one-level listing (`crates/chan-workspace/src/rooted_fs.rs:864`) and rewrites `\` to `/` in the recursive walks and the index keys on every platform (`crates/chan-workspace/src/fs_ops.rs:841`, `:876`, `:1950`, `:1990`). The SPA therefore receives `a\b.md` from `/api/fs` and `a/b.md` from the tree walk, search and the graph for one file, and its own `basename` helpers disagree with each other on the same name (`state/format.ts` splits on `\`, seven kept copies do not). No single client-side rule can make the name read the same on every surface while the server sends two spellings.

## Desired contract

One spelling of a name crosses the wire on every route, and the SPA's path helpers follow that one rule.

## What to do

Decide the spelling (the raw name, since `\` is a legal character in a POSIX name and the one-level listing already keeps it; the walks and index keys then stop rewriting it, or the rewrite is documented as the contract and the listing follows it), fix the side that disagrees, pin it with a test that lists, walks, searches and graphs a workspace holding `a\b.md`, and then move the SPA's `basename` to the one rule so the seven kept copies fold. Windows never produces such a name; the test is Unix-only.

## Boundaries

`crates/chan-workspace/src/rooted_fs.rs` and `fs_ops.rs`, the wire tests in chan-server, then `web/packages/workspace-app/src/state/format.ts` and the kept copies the frontend dedup report lists.
