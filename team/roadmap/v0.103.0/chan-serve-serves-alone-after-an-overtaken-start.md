# `chan serve` serves a folder alone after a devserver refused its handoff in a race with a turn-off or a forget

Status: implemented and independently accepted at the component level for v0.103.0; the combined gate passed at the candidate `7fa1676c3` (whole `make ci-linux`, including the four-suite symlinked-temp arm and the Windows GNU target lint).

## Owner decision, 2026-10-06

Make an overtaken handoff end chan serve with one actionable retry message and a nonzero exit, without standalone fallback or re-registration. Test overtaking before and after the mount opens with controlled ordering. Document mixed command/devserver versions and check other causes of the same error before broadening its treatment.

## Implementation and evidence, 2026-10-06

The lead integrated the independently accepted four-commit range `ee756a311..e470900b3` as `864aabf8a..9d029ddf9`. An overtaken mount now has a distinct internal refusal; only the registration handoff turns it into the fixed retry sentence. `chan serve` ends on that answer from any selected devserver, without reaching its standalone registration or open. A devserver of another library is reachable through an explicit port, parentage or single-instance discovery, so the original same-library guard would not satisfy this decision. That guard remains only on the writer-lock refusal.

The exact sentence is `a later request for this workspace overtook its mount in the devserver; run the command again`. It names no particular overtaking action and is pinned by a literal test because mixed versions compare it by equality. The wire envelope and protocol version stay unchanged. An older command beside a newer devserver, and a newer command beside an older devserver, retain their previous fallback. Releasing-root and registration-permit refusals retain the older error and its fallback; broadening them is outside this repair.

Two ordered devserver tests hold the mount before its open and during it, apply a turn-off, then observe the handoff error, no minted window and the stopped record. They were red at the committed pre-fix tip. The command decision tests cover the error from this and another library and the older sentence's fallback. The corrective red at `6818cbff4` failed both the other-library assertion and the literal assertion with exit101; the final gate at `e470900b3` passed fmt, clippy, rustdoc and all targets of chan-server and chan, including 2081 server tests and 291 command library tests. The guard mutation failed its intended test with exit101 and restored the original bytes. Review accepted the corrected range by source and artifact reading; it did not run a real command against an overtaken devserver.

Evidence is recorded in `dev/v0103-team/reports/handback-Runtime103-item11.md`, `dev/v0103-team/reviews/review-Review103-Runtime103-item11-1.md`, and `dev/v0103-team/evidence/Runtime103/jobs/i11c-{red,gate,mutate}-01.*`. This is component evidence, not a completed combined gate or Windows/macOS execution. The item stays here until the release process closes it.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: raised for a decision on 2026-10-05, before the v0.102.0 GA, and listed under v0.103.0 from the start: the owner asked that day that what leaves v0.102.0 be put in the next version's list to be checked, and this is the lead's proposal for that list. `raised | decide`: not accepted and not built; the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Raised by the lead from a cost of the superseded start that v0.102.0 writes and does not repair, and that its repair of 2026-10-05 widened: it is recorded on [a-removal-does-not-hold-the-row-it-selected](a-removal-does-not-hold-the-row-it-selected.md) and in the unreleased changelog entry on a devserver start that a turn-off or a forget overtakes. It is a reading, as that item's records and the independent review of the repair's range (`e5ede897d..c81af0d96`) have it, with nothing run. The functions named below were read again for this item at `22c1e8fc8`, the commit of the version's second release candidate, and nothing was run for it.

## Owner ruling

Not ruled. The owner ordered the repair of a superseded start on 2026-10-05 and was told in writing that day, with the state of the first release candidate, that two of its costs stay written, this one and [a-workspace-dropped-mid-restore-is-mounted-again](a-workspace-dropped-mid-restore-is-mounted-again.md), and was asked to say if either should be built before the GA. No answer is recorded.

## What was seen

Nothing was seen in a run or in use: no run and no report shows this state, and no test of it was found. What follows was read in the code.

`chan serve` on a folder asks the local devserver to mount it, over the handoff socket. A devserver's start of that folder that a turn-off or a forget overtakes answers its caller the retry error, whether it is overtaken before its open, where it opens nothing, or after it (`execute_mount_attempt`, `crates/chan-server/src/devserver.rs`). The handoff passes that error's own sentence to the command as its answer: `chan-workspace: workspace is already open in this process; drop the existing handle first` (`handle_discovery_request`, same file; the words are those of `crates/chan-library/src/error.rs` and `crates/chan-workspace/src/error.rs`). The command ends on one answer alone, the sentence for a workspace open in another chan process. Any other error it takes as a devserver that could not mount: it prints `chan: the local devserver could not mount this workspace (...); starting a standalone server.`, registers the folder if the registry lacks it, opens it and serves it itself (`devserver_registration_action` and the standalone path after it, `crates/chan/src/serve.rs`).

What that fallback meets. Where the start was overtaken before its open, nothing is mounted, and the command serves on its own a workspace that was just turned off, or registers again and serves one that was just forgotten; that item's record of the start's first build in v0.102.0 already writes it. Where the start was overtaken after its open, that build left the workspace mounted, so the command's open met the devserver's writer lock and the command ended on a second sentence, which advises `chan serve --devserver`, the command that was just run. The repair of 2026-10-05 changes the second case, by the review of its range: the start closes the workspace it opened, in two states, when the workspace still reads off as the start settles and when its folder left the registry while the start ran, and it awaits that close before it answers. So in those two states the fallback now succeeds as in the first case, and for a folder that left the registry the command registers it again. Where the workspace stays mounted, or its teardown has not let go of the lock, the command still ends on the lock's sentence. The changelog entry says the same in a user's words, as the first of the two things it leaves open. In v0.101.0, by the same record, that handoff was answered as registered, with a window minted for a workspace that was then closed.

## Why it matters

Two requests for one folder disagree, and neither person is told. One turned the workspace off in the devserver, or forgot it; the other ran `chan serve` on it at the same moment and is told that the devserver could not mount it, in a sentence that names neither the turn-off nor the forget and wraps an error about a handle in this process that its reader cannot act on. The folder is then served by the command alone, and after a forget it is in the registry again. It is narrow: a `chan serve` of a folder must arrive while a devserver's start of that folder is in flight, and a turn-off or a forget of it must land in between. By the changelog entry the desktop's launcher disables the power control of a workspace that is starting, so such a turn-off comes from a window whose row was stale or from a script.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. The lead proposes the smallest repair that the plan of the superseded start's repair named and did not stage: for a start that was overtaken the handoff answers the retry sentence, `workspace is still releasing; retry`, and the command ends on that answer, printing it once and starting no standalone server, as it ends today on the sentence for a workspace open in another chan process ([chan-serve-falls-back-to-a-standalone-server-the-same-lock-refuses](../done/chan-serve-falls-back-to-a-standalone-server-the-same-lock-refuses.md)). The fallback stays for every other refusal and for a devserver that does not answer. As named, the repair goes by the error and not by the state, so it would cover a start overtaken before its open and after it, and the two sentences the command still prints where the workspace stays mounted; the plan does not say that, and it follows from the two functions as read. What the owner would accept with it, as the plan names it: it goes against a ruling of the lead's from earlier in v0.102.0, which `crates/chan-server/design.md` carries as `the serve handoff's reply keeps the error's own sentence`; it changes two crates and the words between a command and a devserver that can be of two versions; and an older command does not know the new answer and falls back on it as it does today. The other choice is to keep the cost as written: the changelog entry says what the command does.

## Boundaries

`handle_discovery_request` in `crates/chan-server/src/devserver.rs`, `devserver_registration_action` in `crates/chan/src/serve.rs`, `crates/chan-server/src/devserver_handoff.rs` for the answer's words, their tests, the design's sentence on the handoff's reply and the changelog entry. Not the start's close, its two states or the host's close by identity, which are built, and not what the routes answer.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: built, or kept as a written cost.
2. If it is built: a `chan serve` handed to a devserver whose start of that folder a turn-off or a forget overtakes, before its open or after it, prints the retry sentence once, registers nothing, starts no standalone server and exits non-zero; pinned red first, with the start held by a seam and no sleep deciding the order.
3. If it is built: a command of this version against a devserver of v0.102.0, and the reverse, do what v0.102.0 does; pinned or read, and said.

## Not established

That the state occurs outside a reading: nothing was run and there is no report from use. No test of it was found: at `22c1e8fc8` the devserver's tests whose names carry the handoff or the discovery socket are five, and none is of an overtaken start; that is a search of names and not a reading of each test. That the start's close has always returned before the command's own open begins is read from one function and held by no pin. What v0.101.0 did here for a user: the record above has the handoff answered as registered with a window minted, and the review of the repair's range, which read the devserver's side at that tag, says that whether that mint succeeded for a workspace the start had closed was not read; so what a user of v0.101.0 saw in this race is not established. What the command does today for the other causes of the same error, a root that an earlier call has not let go of or a registration's permit not granted in time: the repair as named would end the command on a retry there too, and that was not read. How a command and a devserver of two versions behave with the new answer: named by the plan, not read. The plan was written at `b7373fda2`, before the repair of the superseded start was built; what it says of the two files was checked by name at `22c1e8fc8`, not by its line numbers.
