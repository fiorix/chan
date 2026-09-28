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
