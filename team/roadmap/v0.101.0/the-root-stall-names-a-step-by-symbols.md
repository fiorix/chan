# The root stall holds a named step only in a build that keeps its symbols

Status: raised for a decision on 2026-09-28 by the lead, from main CI's run for the landing that brought an open's bound (run 36456494479, on `ebe9f7f62`), whose `AUR build + smoke (chan-desktop)` job failed on two tests of chan-desktop that the landing added (`dev/v0101-team/evidence/int/ci-36456494479/README.md` in the development tree, with the log's excerpt beside it). Read in the job's log and in code at `ada0ecc4c`, where the files named here are as they were at that commit; not reproduced on the development box, where a release build of chan-desktop's tests takes the box alone. An order on it is written in the development tree and not built. Recommendation, the lead's: accept for v0.101.0, since every run of main CI is red at this job until it is repaired.

## What was seen

**The run.** Job 109044050858 ended with exit code 4 from the recipe's `check()`, and its log is whole: chan-desktop's test binary passed 503 tests and failed 2, `embedded::tests::open_bound::an_open_whose_root_hangs_answers_at_the_mount_bound` and `embedded::tests::open_bound::an_open_beside_an_abandoned_open_answers_the_rows_words`, each at its fixture's assertion that the open reached its root, and each after the first-run notice of a workspace that opened. It is no kill of the kind that [the-aur-check-is-killed-with-its-hosted-runner](the-aur-check-is-killed-with-its-hosted-runner.md) describes. The other eight jobs of the run were green, the AUR build of `chan` among them.

**The seam.** Both tests hold the open at one step with `root_stall::stall_matching(&stored, &["Library::open_workspace"])` (`desktop/src-tauri/src/embedded.rs:1169-1174`, `:1224-1227`). `stall_matching` holds only the calls whose chain of chan functions names one of the functions it was given and lets every other call through (`crates/chan-workspace/src/paths.rs:511-517`; `stall_point`, `:665-699`). The chain is read from the symbol names of a captured backtrace: `call_chain` keeps the frames whose symbol starts with `chan_` (`:703-722`).

**The build.** The recipe tests with `cargo test --frozen --release -p chan-desktop` (`packaging/distros/arch/aur/chan-desktop/PKGBUILD.in:61-66`). The release profile strips symbols and optimizes across crates (`Cargo.toml:144-151`: `lto = "thin"`, `codegen-units = 1`, `strip = "symbols"`, and `strip = true` for chan-desktop).

**So, inferred from the three readings:** in that build a backtrace names no function, the chain is empty, the seam holds nothing, the open runs through, and the fixture fails after its ten seconds. The run's own output fits it.

**Why no other check showed it.** The gate and `make ci-linux` run the suites in the dev profile. The seam's other users are tests of chan-server (`crates/chan-server/src/devserver.rs` and `crates/chan-server/src/routes/library.rs`), which no recipe tests in the release profile: the recipe of `chan` tests the `chan` package alone (`packaging/distros/arch/aur/chan/PKGBUILD.in:49-54`). chan-desktop's other tests of a root that stops answering use `stall`, which holds every call and reads no name. The two tests are the first users of `stall_matching` in a package whose tests a recipe runs in the release profile.

## Desired contract

A test that holds one step of an operation holds it in every build in which the test runs, and a seam that is asked to hold a named step and cannot name any refuses loudly, so that no test passes or fails because the seam held nothing without a word.

## What to do

The lead's two ways, each with its cost, for the order's plan to settle by the code:

- **The step is named by the code and not by the symbols:** a named function opens a scope at its entry, behind the seam's feature, and the stall point reads the scopes of its own thread. A build's profile, its inlining and its platform's symbol names then change nothing. It costs one line in each function that a test names, and a name that means a function outside chan-workspace needs the scope reachable from that crate.
- **The tests that hold a named step are compiled only where the dev profile's symbols are,** and the seam refuses when its backtrace names nothing. It repairs the job and leaves the seam reading symbols.

Red first in the release profile, in chan-workspace alone, which is the cheapest run that shows the fault.

## Boundaries

`crates/chan-workspace/src/paths.rs` (the `root_stall` module) and the functions that the first way names, the tests that call `stall_matching` in chan-desktop and chan-server, and the design document that names the seam. No production behaviour changes and no changelog entry is owed.

## Acceptance

1. The two tests of chan-desktop pass under the recipe's own command, `cargo test --release -p chan-desktop`, shown by a run recorded with its status.
2. A test of the seam in the release profile holds a named step, or is refused with a sentence that says why; pinned red first.
3. Main CI's `AUR build + smoke (chan-desktop)` job is green on the landing that brings the repair.

## What shipped

Landed on 2026-09-29: main CI's AUR build of chan-desktop at `e07f3862f` ran the recipe's release-profile `check()` and passed both open-bound tests, meeting the first and third points (`dev/v0101-team/evidence/int/ci-36509621251/aur-chan-desktop-109218650121.log` in the development tree, lines 2700, 2875 and 3010). The owner has not ruled on it; the lead ordered it before the lane's next work, since `main` was red at that job. Lines at `e07f3862f`. It came as one range with no independent review (`dev/v0101-team/reports/report-Runtime-36.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Runtime-34.md` and the ruling on its plan, `dev/v0101-team/followups/followup-Lead-Runtime-42.md`, the lead's, the owner's to overrule), verified by the lead, who read the seam's diff whole and showed by `cargo tree` that no build that ships enables the seam's features (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-29 01:09Z; `dev/v0101-team/evidence/int/features-e07f386.log`). No product behaviour changes, and the changelog has no entry.

- **A step is named by the code that runs it.** A step is a typed constant, opened on the thread that makes its calls by a guard that is not `Send` and closes it when it drops, also when its function unwinds (`Step`, `Step::open`, `OpenStep`, `crates/chan-workspace/src/paths.rs:462-522`). `stall_matching` takes steps and holds a call only while one of them is open on the calling thread (`:587-597`; `stall_point`, `:746-779`), where it read function names from a backtrace, which a release build strips; a held call records the steps open on it and the path it asked (`:781-789`).
- **Six steps are opened, each under the `cfg` of its constant,** so a test cannot name a step that no code of its build opens (`paths.rs:462-466`): the library's registration, unregister and open and a workspace's revalidation of its root, under `test-hooks` or the crate's own tests (`crates/chan-workspace/src/library.rs:240-241`, `:281-282`, `:308-309`; `crates/chan-workspace/src/workspace.rs:1607-1608`; the constants, `paths.rs:524-532`); the mount's root check, under chan-library's `test-util` (`crates/chan-library/src/host.rs:1707-1708`; `ROOT_CHECK_STEP`, `crates/chan-library/src/lib.rs:50-56`), which now enables the seam (`crates/chan-library/Cargo.toml:23-26`); and a Files watch's attach, in chan-server's own tests (`crates/chan-server/src/standalone_watch.rs:42`, `:228`). The root check's step opens after the root's availability check and before its key, so it holds the key's lookup (`host.rs:1706-1709`). A stall asked to hold no step refuses (`paths.rs:591-595`).
- **No build that ships compiles a step:** with normal and build edges, `chan`, `chan-desktop` and `chan-server` resolve chan-workspace without `test-hooks` and chan-library without `test-util`, and only the dev edges turn them on (the lead's run, `features-e07f386.log`).

Pinned: an open held at its named step in any profile (`a_named_step_is_held_in_any_profile`, `crates/chan-workspace/src/library.rs:1463`), red in the release profile at its own commit and green there at the fix, in the report; a step that marks the calls of its own thread alone, a held call's record, a step closed by an unwind, a guard that is not `Send`, and a stall that refuses no step (`paths.rs:805`, `:844`, `:869`, `:893`, `:906`). In the report every mutation that removes one step's line reds the tests that hold through it but for the open's step in two admission tests of chan-server, where that step is a net and not the hold; the four stall pins passed 200 runs as they are and 200 on one CPU; the own gate was green.

**The acceptance at the tip.** The first and third points are met by main CI run 36509621251 at `e07f3862f`: its AUR build of chan-desktop ran the recipe's release-profile `check()`, both `embedded::tests::open_bound` tests passed, and the job was green (`dev/v0101-team/evidence/int/ci-36509621251/README.md` and its AUR job log). The second is met by the named-step seam's release-profile pin, red first (`crates/chan-workspace/src/library.rs:1463`; `dev/v0101-team/reports/report-Runtime-36.md`).

**The costs, none hidden:**

- **A step holds every call made while it is open,** where the backtrace kept at most eight frames; in one admission test the open is held three times before its root check, and every suite passed (the report).
- **The absence of steps in shipped builds rests on resolved features:** the lead checked normal and build edges on clean `5c3c6206c` after finding no manifest diff against `e07f3862f` (`dev/v0101-team/evidence/int/features-e07f386.log`); main CI also passed the AUR build of `chan` at this SHA (run 36509621251).

**What is left:** nothing of this item's three acceptance points.
