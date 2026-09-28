# The desktop's `chan serve` handoff registers a path with no time limit

Status: raised for a decision on 2026-09-28 by the plan for the open's bound (`dev/v0101-team/followups/followup-Services-Lead-15.md` in the development tree, section 8), which read it at `d5a38d0fd` and left it out of that order, as the lead ruled (`dev/v0101-team/followups/followup-Lead-Services-22.md`, "Not in this order"). Read again at `fe2708e45`; not run. It is not a part of [an-open-with-no-bound-holds-a-hung-roots-lock](an-open-with-no-bound-holds-a-hung-roots-lock.md) by that item's own words: its callers hold a root's lock across a call to the root's filesystem, and this registration holds none. Recommendation, the lead's: accept for v0.101.0, with the same bound, the devserver mount's.

## What was seen

A `chan serve PATH` handed off to a running desktop is answered at once, and the desktop registers the path and mounts it on a task of its own (`open_workspace_from_handoff`, `desktop/src-tauri/src/main.rs:2955-3030`; its doc, `:2939-2953`). The registration runs on the blocking pool and the task awaits it with no time limit (`:2987-2993`). It stats the path, creates it when it is missing, and registers it (`register_workspace_path`, `main.rs:1127-1143`), which stats the path again and resolves it (`Library::register_workspace_with_name`, `crates/chan-workspace/src/library.rs:235-254`, the stat at `:240`, the resolution through `match_root` at `:243`, `:556-565`). Only when it returns does the task reach `serve::start`, whose open stops at the devserver mount's bound since 2026-09-28 (`main.rs:3014-3027`; `EmbeddedServer::open_workspace`, `desktop/src-tauri/src/embedded.rs:299-313`).

So for a path whose filesystem stops answering, the task waits for as long as the path does, and the desktop shows neither a window nor a notice, since both come after the registration (`main.rs:2994-3027`). A second `chan serve` of the same path finds nothing running and starts a registration of its own (`:2964-2977`, `:2987`), each holding a blocking thread while it waits (inferred). The registration holds no root lock of the host's, and it resolves the path before it takes the registry's mutex (`library.rs:240-244`), so a close or a removal of that root is not held behind it, unlike the callers of the item that landed. That the registration's threads take no permit is the class of [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md), whose record names the devserver's mount and the launcher's add as the callers that register and not this one.

## Desired contract

The desktop's handoff stops waiting on a path's registration within the bound the devserver's mount has, and its notice names the path that did not answer.

## What to do

Await the registration within `WORKSPACE_MOUNT_TIMEOUT` (`crates/chan-server/src/devserver.rs:392-395`) from the handoff's start and answer its expiry with the desktop's notice in the words of `mount_timed_out` (`crates/chan-server/src/error.rs:99-109`); decide whether the open after it keeps a bound of its own, as today, or gets what is left of one bound, as the launcher's add does (`crates/chan-server/src/routes/library.rs:1864-1883`). The registration runs on past the bound, and its thread is the other item's. Red first: with the stall seam holding the registration, as the launcher's add pin holds its own (`routes/library.rs:3560-3563`), a handoff whose registration hangs emits its notice at the bound, on a paused clock; today it emits nothing.

## Boundaries

`desktop/src-tauri/src/main.rs` (`open_workspace_from_handoff`, `register_workspace_path`) and its tests, and `desktop/design.md`. Not the host's registration or its threads.

## Acceptance

1. A handoff whose registration hangs gives its notice at the bound, naming the path, pinned red first on a paused clock.
2. A handoff whose registration answers opens as now.
3. `desktop/design.md` names the handoff's bound.
