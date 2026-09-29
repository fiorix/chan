# Two registry rows can name one directory, and the devserver's on route then refuses one of them

Status: raised for a decision on 2026-09-28 by the independent review of one devserver record per workspace (`dev/v0101-team/reviews/review-Runtime-18.md` in the development tree, finding 6, read at `c0b29d01c`), whose fix round built nothing for it and raised it, as the lead ruled (`dev/v0101-team/reports/report-Services-33.md`, "Finding 6, raised"; `dev/v0101-team/followups/followup-Lead-Services-23.md`, question 2). Read again at `ada0ecc4c`; not run, and that a probe misses its budget at a devserver's start is inferred. Recommendation, the lead's: accept for v0.101.0, with the orders that are left of the relinked root ([a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md)).

## What was seen

A registration canonicalizes the path it is given and matches it against the registry without the registry's mutex: a row whose cached canonical path is that path, else the rows whose stored root re-resolves to it within the probe's two seconds, and a row that has not answered by then is taken not to be the one looked up; with no match it appends a row stored at the canonical path (`Library::register_workspace_with_name`, `crates/chan-workspace/src/library.rs:235-254`; `match_root`, `:556-565`; `alias_candidates`, `crates/chan-workspace/src/registry.rs:345-359`; `RootMatch::resolve`, `:459-467`; `ALIAS_PROBE_BUDGET`, `:475-481`; `touch_matched`, `:384-408`, the append at `:392-401`). So one process alone can come to hold two rows for one directory, in two ways:

- **A probe that misses its budget.** A registration of a relinked root's canonical path, or of any other spelling of it, while the probe of the row's stored root takes longer than two seconds appends a row stored at the canonical path. The devserver's restore makes such a call for an overlay row whose path the registry does not go by (`register_restore_rows`, `crates/chan-server/src/devserver.rs:1876-1917`, the registration at `:1886-1889`), at a start, when a loaded registry's cached paths are its stored roots (`cached_canonical_path`, `registry.rs:233-238`); that a root answers slowest then is inferred.
- **A relink onto another registered root's directory.** When a user relinks a registered root onto the directory of another registered root, a registration of the first matches the second's row by its cached path, with no probe (`alias_candidates`, `registry.rs:346-353`; `position_matched`, `:365-374`), and the first row stays.

What the devserver does then, read at the tip:

- It lists one row per registry row (`workspace_entries`, `devserver.rs:1720-1754`), so the directory is listed twice.
- **The on route at the first row's prefix can refuse with a 500.** It registers the first row's root, is answered the other row, and hands that row's root to `begin_registered_mount` (`mount_key_at`, `:1058-1096`). With a record under the first row's root already at that prefix, as after an off from the row or a restore of the row's overlay row, the record's root is neither the other row's root nor the key the request resolved, so the mount is refused with "workspace prefix <prefix> already belongs to <root>" (`begin_registered_mount`, `:1144-1150`), which the route answers 500 (`handle_set_workspace_on`, `:3171`). With no record there, it makes one under the other row's root at the first row's prefix (`:1159`). The review read that the build before one record per workspace kept the record there, since the request's own root matched.
- The choice among records that join one row serves only this state (`Listing::shown`, `devserver.rs:633-653`).

Read again at `e07f3862f` on LANDING-DATE, when a close's and a removal's own hops took permits ([a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md)), from the independent review of that work (`dev/v0101-team/reviews/review-Runtime-19.md`, finding 3, a walk of the code, not run). A close or a removal of a root no runtime holds takes the first row in the registry's list, most recently touched first (`crates/chan-workspace/src/registry.rs:403`), one of whose stored keys is the root's key or the path as given (`closing_row`, `crates/chan-library/src/host.rs:3510-3518`), while the removal's unregister asks the library by the path as given (`host.rs:3680`; `Library::unregister_workspace`, `crates/chan-workspace/src/library.rs:280-300`). With two rows for one directory the two can name different rows: by the review, a removal can then forget the overlay rows under both spellings and unregister the other row's workspace. And a lookup whose probe of a moved root misses its two seconds (`ALIAS_PROBE_BUDGET`, `crates/chan-workspace/src/registry.rs:481`) answers that no row goes by the root, so a close of that root records no off for a registered workspace.

## Desired contract

One directory has one registry row, whichever spelling registers it and however slowly another row's root answers; and where two rows name one directory, as a registry another process wrote can still bring, the devserver treats them as one workspace and answers the on route of either without a 500.

## What to do

From the fix round's report: a fix can live in the registry, so that it keeps one row per directory (the registration's probe and append in `crates/chan-workspace`), or in the host's lookups by root, so that they go by every row of a directory, since a runtime is found only by its canonical root or the root it was opened at (`found_by`, `crates/chan-library/src/host.rs:617-619`). The smallest devserver change, keeping the on route's own row's root as the record's root, would remove the 500 but leave the first row reading starting beside a tenant that serves; the lead ruled a refusal that a user sees better than that. Red first: two rows for one directory made by a relink onto another registered root, an off from the first row and then its on through the devserver's route; today it answers 500.

## Boundaries

`crates/chan-workspace/src/registry.rs` and `library.rs` (the registration's match and append), or the host's lookups by root in `crates/chan-library/src/host.rs`, and the mount and list in `crates/chan-server/src/devserver.rs`, with their tests and the design documents named below. The probe's two seconds stay unless the ruling says otherwise.

## Acceptance

1. Neither way above leaves two rows for one directory, or, where two rows exist, the devserver's on route of either answers the workspace's row and not a 500; pinned red first through the route.
2. `crates/chan-library/design.md`, which describes the registry's lookup and its two seconds (`:48`), and `crates/chan-workspace/design.md` say what a registration does when its probe misses its budget.
