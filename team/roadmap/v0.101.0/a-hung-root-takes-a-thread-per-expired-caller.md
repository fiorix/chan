# A root that answers its key and then hangs takes one blocking thread per caller that gives up

Status: raised during v0.101.0 on 2026-09-26 from the independent review of the root locks lane (`dev/v0101-tasks/reviews/review-rlock-2.md`, finding 5, with the "two spellings" row of its table of paths left on purpose folded in as a note below). It follows from [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md). A source reading against the root locks lane at `3746c268f`, which had not landed on the integration branch when this was raised, so every line cited is as it is at that sha; read in code, not reproduced.

## What was seen

The root locks lane made the key hop single-flight. `WorkspaceHost::root_key` (`crates/chan-library/src/host.rs:2958-2983`) goes through `RootKeys` (`crates/chan-library/src/root_locks.rs:136-210`), which runs one canonicalization per spelled path at a time on the blocking pool and makes every later caller of that spelling wait on it. A root that hangs while its key is computed therefore holds one blocking thread however often it is asked for, which `closes_of_a_hung_root_hold_one_blocking_thread` pins (`crates/chan-server/src/devserver.rs:5655-5670`).

The calls after the key are not shared that way:

- The devserver registers the root on the blocking pool, inside the mount bound and under no lock (`mount_key_at`, `devserver.rs:891-904`), and the launcher's add does the same with no bound beyond its client (`crates/chan-server/src/routes/library.rs:1832-1848`). `register_workspace_with_name` stats the root first (`crates/chan-workspace/src/library.rs:240`).
- `open_or_get_registered_workspace` takes the root lock (`host.rs:1303`) and holds it across the open on the blocking pool (`:1211`, with `library.open_workspace` at `:1224`) or, for a root already mounted, across the revalidation (`revalidate_mounted_root`, `:1328-1341`, whose comment says nothing bounds that stat, `:1323-1327`).

The lock belongs to the caller. It is released when the caller's future is dropped, at the devserver's bound (`time_bound_mount`, `devserver.rs:701-708`, used at `:1008-1015`) or when an HTTP client disconnects, and the blocking closure keeps running. The open's cancel flag (`host.rs:1209-1210`) is read between attempts (`:1218`, `:1233`), so it stops a further attempt, not the call in progress; the revalidation and the registration have no flag.

The review's scenario: a root answers its key but hangs on the next call, the shape the lane's `root_stall::stall_after` seam gives a test and one an NFS attribute cache can give a real mount. Each request for it that expires or is cancelled leaves one more blocking thread behind. This reading adds the ceiling: the CLI runtime caps its blocking pool at 32 threads (`crates/chan/src/main.rs:64`, `MAX_BLOCKING_THREADS` at `crates/chan-server/src/bulk_transfer.rs:41`), so a client that keeps retrying such a root can fill the pool, and every other root's key hop, open, registration and blocking work then queues behind the hung calls.

The words claim more than the code does: `crates/chan-library/design.md:28` ("a root that stops answering holds one blocking thread however often its callers retry"), which the lead's notes on the review rule the lane corrects before it lands, and the `RootKeys` doc comment (`root_locks.rs:139-146`), which says the same and is not named there.

**Note, two spellings of one root.** `RootKeys` keys its computations by the path as spelled (`root_locks.rs:172-190`), so two spellings of one hung root, a symlink and its target for example, are two computations and hold two blocking threads. The review's table adds that they can give two prefixes: a prefix's slug comes from the spelling given (`workspace_prefix_for`, `crates/chan-library/src/prefix.rs:40-44`), so spellings whose last components differ name different prefixes for one root. What two prefixes for one root lead to was not examined here; the review places the cost on the hung root alone.

## Desired contract

However many of its callers expire or are cancelled, a root that stops answering holds a fixed number of blocking threads, at most one per kind of call in flight, and the rest of the pool stays free for every other root; the design text says only what the code does.

## What to do

The review gives no fix beyond raising the item or correcting the sentence. A suggestion: let the blocking work own what serializes it, not the caller. Moving the root lock's owned guard into the blocking closure keeps the lock held until the filesystem call returns, so the next caller waits on the lock inside its own bound instead of starting another thread; a close of that root then waits on it as well, which it cannot usefully avoid. The registration hop needs the same sharing, through the root lock or through a single flight of its own keyed by the root's key. Decide separately whether two spellings of one root need to share a computation. Red first: with the stall seam letting the key through and holding the next canonicalization (`stall_after`, `crates/chan-workspace/src/paths.rs:499-502`; the registration and the open both canonicalize through `match_root`), expire several mount requests for the root and show the blocking threads held stay at one; today they grow by one per request.

## Boundaries

`crates/chan-library/src/host.rs` (`open_or_get_registered_workspace`, `open_registered_workspace_inner`, `revalidate_mounted_root`), `crates/chan-library/src/root_locks.rs`, the registration hops in `crates/chan-server/src/devserver.rs` (`mount_key_at`) and `crates/chan-server/src/routes/library.rs` (`handle_add_workspace`), and the sentence in `crates/chan-library/design.md` if the lane's correction has not already made it true. The health probe's thread per hung root is [a-hung-root-keeps-reading-running](a-hung-root-keeps-reading-running.md).
