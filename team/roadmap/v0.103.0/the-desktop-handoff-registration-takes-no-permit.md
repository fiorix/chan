# The desktop's handoff registration holds a thread of the blocking pool with no permit

Status: implemented and independently reviewed; scoped checks passed, with combined native packaging and full-gate validation pending.

## Owner decision, 2026-10-06

The blocking registration must retain its permit after the caller times out, so another handoff to the same root starts no additional registration thread. Preserve progress for unrelated roots and give permit waiters a clear bounded answer. Reuse the host ownership model where applicable and prove the order with a held test operation, not a genuinely hung filesystem.

Lead clarification on the same date: state path-key and alias limits with the implementation.

## Implementation evidence, 2026-10-06

The seven-commit range is integrated as `0a4195cee..d1d7b7951`. A desktop handoff acquires a permit for its lexically normalized sent path before dispatching registration. The blocking call owns the permit until it returns, including after the caller's sixty-second bound ends. A later handoff for that key waits inside its own bound without dispatching another registration; unrelated keys proceed independently. The existing timeout notice remains pinned and documented in `desktop/design.md`.

Ordered tests hold the registration operation and observe the next handoff's poll or dispatch decision. Independent execution confirmed the permit-lifetime regression fails at the dispatch count and that a single key for unrelated paths breaks their progress. That second mutation also exposed an unbounded wait in the new map test; the final repair polls once and fails its labeled assertion. The author's corrected mutation compiled and ended normally with the expected failures, its restored diff matches the committed repair, and the final committed scoped gate passed formatting, clippy, all 580 desktop tests and rustdoc. Lead independently reviewed that last test repair. The native debug binary linked before the final test-only edit; the combined native package, Windows-target check and full gate remain pending.

The key does not resolve the filesystem. Distinct sent aliases can therefore hold distinct permits, and this desktop permit does not order work against the host's registry operations. The new retry wording for a registration refused as already open is pinned separately; its interaction with the registry claim repair awaits combined validation. No genuinely hung filesystem or additional native platform is claimed by the held-operation tests.

Evidence and retained failures are in `dev/v0103-team/reports/handback-Desktop103-item13.md`, `dev/v0103-team/reviews/review-Review103-Desktop103-item13-1.md`, `dev/v0103-team/reviews/review-Lead103-Desktop103-item13-1.md` and `dev/v0103-team/evidence/Desktop103/item13/`. The earlier source-scanner failure and the reviewer's terminated mutation remain recorded beside their corrections.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: raised for a decision on 2026-10-05, before the v0.102.0 GA, and listed under v0.103.0 from the start: the owner asked that day that what leaves v0.102.0 be put in the next version's list to be checked, and this is the lead's proposal for that list. `raised | decide`: not accepted and not built; the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Raised by the lead as what a later version may build of [a-hung-root-takes-a-thread-per-expired-caller](../done/a-hung-root-takes-a-thread-per-expired-caller.md): the last thread of that item, which the lead ruled a written cost on 2026-10-05, so that its row moved to cut with nothing built for that thread. Read in the code at `22c1e8fc8`, the commit of the version's second release candidate. Nothing was run, in that item's record or for this one.

## Owner ruling

Not ruled by the owner. The lead ruled on 2026-10-05 that the thread is a written cost and is not bounded; that item records that the owner was told to expect the ruling and can overrule it. No word of the owner's on it is recorded. This item puts the other side to the owner: whether the permit is built.

## What was seen

Nothing was seen in a run or in use. What follows was read in the code at `22c1e8fc8`.

A `chan serve` handed to a running desktop for a path it does not serve is taken on a task the desktop spawns (`open_workspace_from_handoff`, `desktop/src-tauri/src/main.rs`). The task registers the path and then opens it, under one bound for both, the devserver mount's sixty seconds, which [the-desktop-handoff-registration-has-no-bound](../done/the-desktop-handoff-registration-has-no-bound.md) built (`register_and_open_from_handoff`, same file). The registration is a blocking call handed to the runtime's blocking pool, and it calls the library's own registration directly (`register_workspace_path`, same file). It does not go through the host's keyed registration, which waits for the root's registry-write permit before its blocking call and lets that call own the permit until it returns (`WorkspaceHost::register_workspace_keyed`, `crates/chan-library/src/host.rs`), and which, by that item's record, the devserver's mount, the launcher's add and the startup restore go through. When the bound ends the task's wait ends and the blocking call does not: it is not cancelled, and it ends when the path answers. So each handoff given up on a path that hangs in registration holds one thread of that pool for as long as the path does not answer, or until the desktop quits. `desktop/design.md` says so.

The pool. The handoff's task runs on the app's own async runtime (`tauri::async_runtime::spawn`), for which the desktop's source builds no runtime and sets no cap. The one cap in that source, 32 blocking threads, is on the runtime the binary builds when it is invoked as `chan` (`run_as_chan_if_requested`, same file), and a test in that file holds that it is the only one; that runtime is not the one a running desktop takes a handoff on. The size of the default pool was not read: the runtime's crates are in no commit of this repository.

## Why it matters

The contract of the item this comes from is that a root that stops answering holds a fixed number of blocking threads however many of its callers give up. With this thread written as a cost, the count on this one path is one thread for each `chan serve` a user runs against a path that already hangs in registration, inside one desktop process, until the path answers or the desktop quits. The lead's reasons for a cost and not a permit, as ruled: that count needs a path that already hangs and a user who runs the command against it again; the pool is the runtime's default; and a permit is new behaviour on the handoff's path, with a refusal of its own to word and to test.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. What the lead's ruling leaves for a later version is the permit: the handoff's registration runs under a permit for its root, as the owner's shape for that item gives the open, the revalidation and the host's own registrations, so that a second handoff of a path that hangs waits on the first inside its own bound and starts no thread. A path that hangs in registration then holds one thread of the desktop's pool however many handoffs give up on it. What a handoff is answered when it does not get the permit, the notice's words included, is not chosen. The other choice is to let the lead's ruling stand: one thread for each handoff given up, as `desktop/design.md` says.

## Boundaries

`register_and_open_from_handoff` and `register_workspace_path` in `desktop/src-tauri/src/main.rs`, with their tests, the sentence of `desktop/design.md` and the notice's words. Not the handoff's bound, which is built; not the host's permits; and not the command's own registrations, which that item read as needing no permit.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: the permit is built, or the lead's ruling of a written cost stands.
2. If it is built: however many handoffs give up on a path that hangs in registration, the desktop holds one blocking thread for that path, and a later handoff of it starts none; pinned red first, on a clock the test holds.
3. If it is built: what the later handoff is answered is worded, pinned and written in `desktop/design.md`.

## Not established

That the state occurs outside a reading: nothing was run and there is no report from use; it needs a path whose registration hangs. The size of the pool the thread is taken from. How the handoff's task would reach the host's keyed registration or a permit of its root: the desktop's embedded server was not read for it. What a second handoff is answered while the first holds the permit: the host's keyed registration waits its release budget, one second by that item's record, and then answers the retry error, and the record of the ruling speaks of a wait inside the handoff's own bound; the two are not reconciled here.
