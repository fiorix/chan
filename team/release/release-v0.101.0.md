# Release v0.101.0

Status: GA 2026-10-02. Two candidates: `0.101.0-rc0` (`7fb2ad82a`; its dry run and the CI run on `main` were red on two diagnosed failures, and Apple's notary service refused the macOS desktop package over an expired developer agreement; superseded) and `0.101.0-rc1` (`0c0dfa6e5`; both failures fixed, dry run green in every job once the agreement was signed, tested and accepted by the owner). `main` was fast-forwarded along the candidate line to rc1 plus one workflow commit (`ceb04127d`), and the GA commit is staged on `v0101/int60` on top of it; the GA commit is the one carrying this report.

The round opened on 2026-09-20 with what v0.100.0 had phased out and grew to 142 roadmap items as reviews of the work in hand raised more. 133 shipped, three were withdrawn by the owner, and six moved to v0.102.0: four whose remaining work carries over and two still raised for a decision. `main` stood at `ceb04127d` at the cut, 2,378 commits after the v0.100.0 tag, with 1,062 files changed outside the process trees. What a user sees is a server and a desktop that keep answering beside a workspace folder that has stopped answering and beside a devserver that is stopping or restarting, refusals that read the same on every surface, a live drawing that keeps what was drawn, and control sockets that only their owner can reach. The user-facing list is the changelog's v0.101.0 section; this report is the round's shape and its limits.

## What shipped

### Server, library and devserver

- A root that stops answering no longer holds the rest. An open of it gives the root back at a bound of sixty seconds, a close and a removal of it answer, a retried registration keeps one blocked call, and a quit's wait on each workspace's teardown and on a standalone Files window's watch is bounded.
- A starting devserver restores up to four workspaces at once. A stopping devserver says that it is stopping, refuses new open and on requests, and the launcher's add and on refuse it.
- One devserver record per workspace: a workspace whose registered path was pointed elsewhere, or whose folder moved behind a symlink, is listed once, served at one prefix across restarts, and forgotten by its own row.
- Every HTTP refusal answers in one JSON envelope with a display sentence and a machine code, in a workspace, a standalone terminal window, the launcher and the devserver's own routes, including malformed requests and unrouted methods. The desktop, the CLI and the web clients show the sentence.
- Control sockets live in a directory that is a real directory, owned by the effective uid, mode 0700: a valid `XDG_RUNTIME_DIR`, or `/tmp/chan-control-<uid>` where there is none. `cs`, `chan` discovery and the MCP proxy read only validated directories, and `cs` run as another user than the directory's owner is refused with the directory and the reason named.
- A workspace releases its search index before its writer lock, lock probes release their temporary locks, a terminal restored across a Linux devserver restart is closed through a verified process handle and not a reused process id, and a file whose name holds a backslash reads as itself on Unix.
- MCP: a read of a file over its cap no longer reads the whole file, a cancelled tool call stops a running listing, report scan or search, and the extension catalog reports process state.
- `chan serve --no-settings` is refused where it would not be enforced, and the `chan` CLI crate's one 14,624-line file is split into modules with the tests, the help and the lines kept.

### Desktop and windows

- `cs window new` and `chan serve` open their window in the desktop, nested under its workspace's row; a desktop window waits for a devserver that is restarting; a close on the connecting page keeps the window's terminals.
- In a browser, a new window or terminal waits for its page before it navigates, Open, Focus and Show decide by the window's record, and closing one browser window keeps another window's terminal sessions.
- The desktop leaves Ctrl+[, Ctrl+] and Ctrl+/ to a focused terminal, and Ctrl+Q to the page on macOS.

### Editor, drawings and the app shell

- A live drawing keeps its last stroke across a scripted close, a move, a window's close, a replaced file and a reload from disk; its `appState` is written only when someone changes it; a window that only opens a drawing writes nothing; a failed drawing library leaves the file alone.
- A failed save keeps the editor and says what happened, a draft closed before its content arrives is kept, a `.json` file is saved as typed, and a CSV cell opened and left unchanged writes nothing.
- Destructive confirmations open with Cancel focused, error pills can be dismissed, dialogs keep the keyboard, and the command deck says when a command fails after it closed.
- The frontend review's remainder: the editor's pickers, widgets, date pill, image replace and preview, rich paste, the outline, slide decks, the graph's scope, filters and link chips, the style toolbar's tooltips, settings, search and the status bar.
- Terminals: a reload after a devserver stop starts terminals with their saved profiles, a reattached terminal recovers a cut replay and gives the keyboard back, and a resize defers the full masking scan.

### Packaging, release and gate

- Both AUR recipes install the binary that `build()` set aside before `check()` runs, and the AUR CI jobs skip a prerelease version instead of failing on it.
- `make ci-linux` runs the library and server suites under a symlinked temp directory and checks the Windows arm's test crates for the Windows target; the documented gate container runs the gate as a user who is not root.
- Web dependencies are refreshed within their ranges (Mermaid 11.17.2, DOMPurify 3.4.16), and the editor's Markdown parser is pinned exactly.

### Withdrawn

Three items closed with no build, each by the owner's ruling recorded in its file: the grant-claim email fold that merges distinct characters (the documented residual is kept), the page-break scan and renderer differing on nine measured inputs (accepted residuals, since closing them means parsing HTML in the scan), and a kept browser terminal row keeping its sessions alive (the cost of the ruling that the launcher keeps such a row, stated in the launcher's design document).

## Team and process

The round ran as a lead seat and four lanes (Runtime, Services, Frontend, Clients), each lane in its own worktree, with Codex and Claude seats mixed. Lanes handed back ranges with a report and a scoped gate; the lead read each range, picked it onto an integration branch, and gated the committed tip of each integration with the full `make pre-push`, the symlinked-temp suites and the Windows-target check. Builds, tests and gates ran inside one sdme guest on the development box under a shared lock and a memory and CPU cap. The box had run out of memory on the night of 2026-09-27 and was rebooted with no commit lost. Seats were recycled at a context line with a written handoff, the lead's among them.

The roadmap did not hold still. Reviews of landed work raised items faster than they closed, and on 2026-09-29 the owner ruled on fifty-five raised items at once and closed the version's intake under one rule: a raised item enters only when it loses a user's data or weakens security and its fix is small and local, a test or infrastructure item only when it makes the release gate or a release job unreliable, and everything else goes to v0.102.0. On 2026-09-27 the owner ruled that every accepted item lands before the first candidate, and that a version's first candidate is rc0. From 2026-09-26 commit messages and code comments carry no round, lane or order names.

## Validation

- The combined gate was green on Linux at rc0, at rc1 and at `main`'s tip `ceb04127d`; at the last two 5,231 Rust tests passed, none failed, six ignored; the four web suites passed (153, 539, 5,533 and 20 tests); the Nix cargo hash check passed. `make gateway-packaging-isolation-test` was green at rc1.
- CI on rc1: `make ci-linux`, `make ci-macos` (4,524 Rust tests on macOS) and `make ci-windows` green, the Nix package built at rc1's pins. CI on `main` at `ceb04127d`: green in all nine jobs, the first green run on `main` since `e07f3862f`.
- rc1's `publish=false` dry run was green in every job, the macOS sign and notarize path included, and the Docker and Cachix dry runs were green.
- Both Nix fixed-output hashes were harvested with a real fetch at each pin bump and proved by a second run at the pinned commit.
- The owner ran rc1 on two devservers and took the macOS DMG and both Linux CLI tarballs from the dry run, tested the candidate, and accepted it on 2026-10-02.

## Retrospective

- **The gate was green on a defect CI caught.** rc0's CI was red on a product defect, the MCP proxy's search for a live socket skipping the private fallback directory wherever `XDG_RUNTIME_DIR` was valid, because the gate's guest ran with that variable unset. The fix round ran the test under both environments first. A gate environment that differs from CI's in one variable hides whatever that variable decides.
- **Four fixtures passed a limit only macOS has.** Control socket test paths fit Linux's 108-byte `sun_path` and not macOS's 104 under its long temp directory. A 52-byte `TMPDIR` on Linux reproduces it; the fixtures now root at `/tmp`.
- **The dry run found what no test could.** Apple's notary refused the package over an agreement that had expired on the account. Nothing in the tree was wrong, and only a dispatch on the candidate could show it before the tag.
- **A candidate's CI could not be green as a whole.** The AUR jobs refused a prerelease version by design, so every candidate's run read as failed. They now skip it; the GA commit's run is the first to build through the changed step.
- **The roadmap close was done by script.** With 142 items, each closed item carries a status line and its record before the release, and the Completed list names it by its title; the per-item sentence of what is now true, which v0.100.0 wrote for forty items, was not written. The changelog is the statement of what changed.
- **Intake outran the build.** The version grew from the phased-out remainder of v0.100.0 to 142 items in nine days, and the rule of 2026-09-29 is what let it close.

## Follow-ups

- v0.102.0 holds 68 items. Six came from this version at GA: the dedup seams, the frontend comment pass, the frontend review remainder's low-severity rows, the thread a hung root's registration still takes for a caller that gives up, and, still raised for a decision, a raw devserver's restart that may close desktop windows and a desktop hide that commits no waiting stroke.
- Defects the owner finds in this release are filed as roadmap items.
- GitHub retires the macOS 14 runner image by 2026-11-02. This repository's workflows use `macos-latest` and already run on macOS 26; the two extension repositories pin `macos-14` in their release workflows and need the one-line change before their next release.

## Platform and pipeline

The candidates' `publish=false` dry runs, each dispatched on its `0.101.0-rcN` branch: rc0 release `37028093747` (red in both validation jobs and at notarization), with Docker `37028108928` and Cachix `37028124616` green. rc1 release `37033213645`, green in every job after the re-run of the macOS desktop package, with Docker `37033217442` and Cachix `37033237338` green, and CI `37033209489`, red only in the two AUR jobs as then designed. CI `37045362814` and Gateway CI `37045362763` on `main` at `ceb04127d` were green. No tag or GitHub Release exists for any candidate.

The GA commit `13cf4e175` was staged on `v0101/int60` on top of `main`. It moves the twenty-four version pins from `0.101.0-rc1` to `0.101.0`, regenerates the three lockfiles, re-pins both Nix hashes, cuts the changelog, and closes the roadmap. Before the tag it was gated green with the full `make pre-push`, the symlinked-temp suites, the Windows-target check and the gateway packaging isolation test, and CI `37059235079` and Gateway CI `37059235029` on `main` at that commit were green in every job, including `Nix chan-desktop`, the only check of the hashes harvested for its lockfiles, and both AUR builds, the first at a GA version since they skip a candidate's pins.

The owner pushed the annotated tag `v0.101.0` on the GA commit. Its Release run `37063579288` was green in all seventeen jobs, the three publish jobs included: the GitHub Release carries 25 assets, and both `/dl` manifests name `0.101.0`. The `publish-downstream` run it triggered, `37067672797`, was green in all twenty-seven jobs: the five Docker images at `0.101.0` and `latest` on amd64 and arm64; the four Cachix pins, with both substitution smokes; COPR `chan` on ten chroots and `chan-desktop` on eight; the PPA on noble and resolute, both architectures; the AUR `chan` and `chan-desktop` at `0.101.0-1`; and the Homebrew tap at `0.101.0`.

## Known gaps

- `make windows-cross-check` was not run for this release: on the development box sdme refuses the container's disk cap, because btrfs quotas on the filesystem under its state directory were enabled by something else. Windows is covered by `make ci-windows` on the candidate and on `main`, by the gate's Windows-target check, and by the signed Windows packages of the dry run.
- The team made no browser smoke, no reading on a display, no run as a second local user and no run under a hosted user unit. Thirty items stood built and waiting on the owner's checks at the candidate; the owner's acceptance of rc1 as a whole closes them, and the checks were not recorded one by one.
- A `publish=false` dry run does not exercise the publish-gated steps, the release asset verifier and the download metadata generators, and no candidate can exercise self-upgrade; the tag is their first run.
- Open by design, each stated in its item: the server's bind still creates the private socket directory where there is no runtime directory; another local user who creates `/tmp/chan-control-<uid>` first denies that user a control socket on such a box; and where the sockets moved, a server restart and a new terminal are needed.
