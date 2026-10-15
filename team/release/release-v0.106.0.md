# Release v0.106.0

Shipped 2026-10-15 as the one GA commit on `0.106.0-ga` over the tip of `v0106/int` (`ccf2297ad`; `671e49126` before the identity rewrite of 2026-10-14), which holds the two test-only repairs of the release candidates' dry runs, a straight GA by the owner's answer of 2026-10-14 ("straight GA if macOS is green whole") after `0.106.0-rc0` (`e7dbeeb57`) and `0.106.0-rc1` (`1121267c8`); `main` moves to the GA commit and the tag `v0.106.0` names it. The candidate is `f3014d84b`, 334 commits over `main` at `4507fe5a0`; above it sit documents, a README sentence and four test-only repairs, the product sources the candidate's. The version held seventy-three items: thirty-six carried into it (thirty-two from v0.105.0, four from that round's findings), six drafts the owner raised at the launch on 2026-10-12, his wrapped-bullet item of 2026-10-13 and thirty rows the round raised. Fifty-one closed in `done/`, thirty-nine built and landed and twelve closed on a measurement, an observation, the owner's word or a withdrawal; twenty-two are carried to v0.107.0.

## What shipped

### Library, server and devserver

- A standalone `chan serve` stop waits at most two seconds for a running transfer's call, then exits with a warning that the cut transfer can leave a partial destination or a staged file. The two other limits on the host's release at a stop (a panicked or dropped serve future, a full blocking pool) stay as stated costs, written as maxima in the design documents.
- Adding a workspace by an alias of a relinked root opens the row's stored root instead of meeting the row's own writer lock and refusing as "locked by another process".
- A file that vanishes between the indexer's metadata check and its read is treated as gone, so a window opened at that moment no longer stays behind the preparing cover.
- A session write the server stores is announced to the window's other pages even when its client has gone: the workspace and terminal PUT and DELETE announce inside the storage worker after the store returns.
- A control socket that cannot bind is logged with its path, the error, the path's byte count against the platform's maximum when too long (107 bytes on Linux, 103 on macOS) and the consequence for the tenant's terminals; the server keeps serving.

### Shell and cs

- `cs terminal status <state> --sleep <seconds>` stays in the foreground after its report for up to a day, so a reported state can be watched from a prompt; the help states each state's lifetime.
- `cs` in a chan terminal with no control socket says so and points to the start-up log, quoting the bind failure the terminal's spawn environment carries in `CHAN_CONTROL_SOCKET_ERROR`, such as a fallback directory another local user created first. That directory stays where it is, by the owner's decision.

### Workspace app and launcher

- A terminal moved to another window no longer comes back into the window it left: the page's read after its own layout write waits for that write.
- A CLI-opened terminal restored by a reload before its socket opened shows a persistent notice that it opened a plain shell; its command is not persisted, by design.
- Under xterm.js, focus reports go to the terminal's own PTY alone, not to its broadcast group.
- A click on a terminal tab sends one focus report instead of in, out, in; terminal tabs are selected on the button's release.
- A terminal view that is not shown no longer sends its grid to the shared PTY, which made full-screen programs redraw or draw small after pane splits and tab moves.
- Every loaded directory of the file tree relists from its own watch events, so a file created outside chan appears whatever is selected; the relists are coalesced per directory (100 ms pause, at most one per 250 ms, one in flight), so a burst of writes does not flood the server.
- A draft's stale answer is decided only by a list that began after it, so an older list no longer marks a live draft gone.
- A click at the end of bold, italic, code, strikethrough or link text puts the caret after the hidden marks, which stay as drawn while the button is held.
- Wrapped lines of a list item align with the first line in every editor theme: the marker's box is sized in the line's font (the Google Docs and Word themes move, GitHub is unchanged), and a non-breaking space after the marker is hidden with the gap.

### Desktop

- A gateway connect waiting on its browser sign-in can be cancelled in the launcher by a click, Enter or Space; one multi-click sequence activates the control once, so a deliberate second click inside the system's multi-click time is ignored.
- The sign-in callback listener is set nonblocking before the async runtime takes it, so a debug desktop no longer panics and drops both listeners.

### Gateway

- No change to the gateway's sources beyond the version pin.

### Marketing site

- The manual's Devserver page opens at its top: the embedded demo's dialog takes no focus until the reader's first interaction. The site's deploy is the owner's step.

### Gate and browser suite

- Five browser checks join the suite, now 87: mark clicks (134), one focus report per tab click (137), the file tree's watch refresh (163), the CLI terminal's reload notice (164) and wrapped list lines (165).
- Six test-only repairs of five checks: check 90 opens the install page that holds its demo since the manual's reorganization; check 163 restores the left dock and settles two frames before its created arm; check 150 selects a tab by press and release; check 107 accepts either winner of two same-name renames; check 105 records every configuration write in its window.
- Load reds: four `chan-server` fixtures, a Rich Prompt test and a desktop gateway test own their timing, with the named reds kept beside their greens.
- Two test defects found by the dry runs, repaired test-only: the `cs_alias` tests' child drops the backtrace variables GitHub's toolchain action sets, and two control-socket diagnostics fixtures no longer assume Linux (`/tmp` is a symbolic link on macOS, whose filesystem refuses a non-UTF-8 name).
- A standalone-mode test of a draft's attachment-folder prompt, and the launcher test setup's Node 26 storage repair, each with its pin.
- The browser suite is documented for a four-CPU guest.

### Packaging and tooling

- The Windows cross-check installs the pinned toolchain explicitly before adding its target, ahead of rustup 1.30 ending the implicit install.
- The sdme build drivers source one policy of overridable CPU, memory, disk, job and time limits; no driver has a CPU, memory, job or time default yet (the disk limit keeps its earlier 44G), the measured runs that would set them not reached.
- The one-CPU test series helper measures a guest outside the default sdme state directory (`--sdme-config`).
- Both Nix fixed-output hashes can be harvested in a capped guest by a user who is not root; the release procedure records the route, which harvested rc0's, rc1's and the GA's hashes.
- The fdstore and terminal replay checks own their unit's start limit, and the fdstore check names a start-limit refusal instead of blaming its `ExecStartPre`.
- The connecting-page hide driver refuses an unusable output path before it creates anything.
- The release procedure dispatches `ci.yml` and Gateway CI on every candidate's branch, and a seat stops before the push of `main` and the tag; rc or straight GA is the owner's call.

### Observed without a repair

- With program status on, escape-dense output runs at 0.872 of the feature-off throughput and plain at 1.015; the default stays off (the lead, with the owner's standing proposal).
- Four windows over 240 drafts spend about 70 ms of blocking-pool time per save, at most once per 800 ms of typing (the lead).
- Cosmic Bell and Segmented Torus hold 60.0 to 60.1 fps against a 60.3 fps baseline on a Radeon 780M; without a GPU six of the twenty-two WebGL welcome animations take the whole two-CPU quota, and the owner made the guard a next-version design.
- Drafts have no live co-editing, and a crash costs about the last 0.8 seconds of draft-tab edits in a healthy idle run (the owner).
- A client's behaviour at a real devserver stop stays as measured with no contract (the owner); a gateway connection's windows across a restart closed on his observation: "it parks the window and reloads the same window, it's good".
- A workspace whose startup mount fails still loses its native windows, which return on a later mount, as the owner's accepted proposal decided.
- The owner closed his ten display readings ("take it all as ok; if bugs appear i will file a fix"); none was taken.
- Check 62's slow mode needs a guest-only preload the shipped fallback does not mount; the bound stays (the lead).
- A terminal from before the v0.101.0 socket directory move cannot reach its server, a one-time upgrade cost; withdrawn by the owner.
- Typing beside a bullet marker running backwards was not reproduced in two bounded searches (886 keys).

## Team and process

Six seats from the launch on 2026-10-12: the lead and five workers (Runtime, Desktop, Frontend, Hygiene, Review), each worker in its own worktree and capped sdme guest; every build and test ran in a guest, the one host run being the frame-rate read the owner allowed. The lead landed accepted ranges on `v0106/int` by a rehearsed cherry-pick with patch-id equality, each with a green scoped gate in the integration guest (one hundred landings to the first candidate; six first runs red and one red again, each kept with its cause). The review seat read designs before code and every landed range with its evidence, and the lead's documents and the candidate report; five of its reads were not reached before the freeze. The first candidate `e0e21f400` (2026-10-13T21:38Z) was reopened at 22:44Z when its browser suite had check 62 red; the second froze at 2026-10-14T00:43Z. Seats recycled from written handoffs: the lead sixteen (nineteen handoffs), review twenty-eight, runtime thirty-six, desktop twenty-six, frontend two; the hygiene seat kept its continuity in its journal. `v0106/int` was backed up to `backup/v0.106/wip` eighty-one times, the last carrying the csmac records; `main` was not touched.

The owner answered by survey or in the lead's terminal: on 2026-10-12 the open questions and proposals 13 to 19 and the publishing rule ("it's ok to stop for my permission there"); on 2026-10-13 the wrapped-bullet item, the WebGL guard as a next-version row, the screenshot's theme (GitHub) and the list typed by hand; on 2026-10-14 the four handover questions (the drafts' cut kept, the second candidate as it is, the stalls' README sentence, checks 90 and 163 repaired), rc0, rc1 at 16:29Z, and at 20:31Z one `ci.yml` dispatch on the backup branch with a straight GA if macOS is green whole. A survey that ended at its bound unanswered was not read as an answer (the drafts', the reopened candidate's and the rc1 macOS questions each twice, and the GA identity's once); each of those questions was answered later. The GA commit's Fedora changelog entries carry the owner's identity, with the two 0.105.0 entries corrected in the same commit by his answer of 20:41Z on 2026-10-14. On 2026-10-14 the owner had the five v0.105.0 commits that carried another email rewritten to his identity before the GA, so `main` from `78f787b4d` and the 350 integration commits were re-created with their trees unchanged; every commit id cited in this report, the roadmap and the records was read before that rewrite; `release-v0.106.0-commit-map.txt` beside this report maps each of the 358 rewritten ids of `main` and the integration line to its new one, and the seat and candidate commits the records also cite (the seats' originals of landed ranges, the unlanded commits, the two rc pin commits) are not kept after the teardown, the carried ones as patches in the round's archive. The push of `main`, the tag and the backup branch, with the deletion of the two rc branches, was the owner's, on 2026-10-15, read back with no remote ref containing the old identity.

## Validation

- The candidate `f3014d84b`: `make ci-linux` rc 0 in 1,717 s (90 result lines, 10,508 passed, 0 failed, 13 ignored); `make windows-cross-check` status 0; `make gateway-packaging-isolation-test` rc 0; `devserver_resilience` ten of ten; the fdstore check twice green; the four terminal size arms green, one unjudged hidden-dial width ruled a measured I/O stall of the shared pool, not a product fault. The host frame-rate read was taken at the first candidate; no welcome file changed after it.
- Its browser suite at four CPUs: 86 of 87 whole and 85 of 87 alone, check 90 red both ways (the manual's reorganization) and check 163's scroll guard once alone (the check's own race); check 62 at 281 and 282 root listings in its 256-file probe window against 3,816 in the frontend guest's run at two CPUs at the first candidate, whose suite read 84 of 87 whole.
- The tip `8b052cc6a`, checks 90 and 163 repaired: `make ci-linux` rc 0 (10,508 passed); the suite 87 of 87 whole and every check alone, no skip, no retry.
- rc0 `e7dbeeb57` on `0.106.0-rc0`, pushed and read back at 10:15Z: `make ci-linux` rc 0 (10,508 passed), the cross-check and the isolation test green; Gateway CI 38548299242 and the docker 38548302607 and cachix 38548306948 dry runs green; `release.yml` 38548292109 (every package job green) and `ci.yml` 38548294534 (`make ci-windows` green) red on their Linux and macOS test steps on ten `cs_alias` tests under GitHub's `RUST_BACKTRACE=short` (10 failed with the variable in the guest at the rc0 commit, 21 passed without), repaired as `bbe17ffe1` (the `chan` crate under the variable, 423 passed).
- rc1 `1121267c8` on `0.106.0-rc1`, pushed at 17:36Z and read back: the first `make ci-linux` red on the environment (the guest's 64 GB disk quota full at the desktop link), kept; the second rc 0 (10,508 passed); the cross-check and the isolation test green; Gateway CI 38608196694, docker 38608200425 and cachix 38608204361 green; `ci.yml` 38608192090 and `release.yml` 38608188635 red on macOS alone (every other job green, the Linux validation whole), the step stopping at its 22nd test binary, `chan-server`'s unit tests (`2197 passed; 2 failed`), repaired as `c2796534e` (`chan-server`, 2,256 passed).
- The macOS dmg and the aarch64 Linux static tarball of each rc were downloaded for the owner from the release dry runs' green build jobs, their SHA-256 in the round's record.
- `ci.yml` run 38632918671 on `backup/v0.106/wip` at `671e49126` (dispatched 20:32Z, green at 21:24Z on 2026-10-14): all nine jobs green; `make ci-macos` ran its whole test step for the first time in this version, 44 test binaries, 44 result lines, 5,310 passed, 0 failed, 8 ignored, so the two test-only repairs hold on macOS and the fail-fast remainder is closed.

## Retrospective

- **Highlight.** The whole browser suite found what a scoped gate did not: the file tree's relist landing flooded the server under file churn (9,753 listings over check 62 against 259 before it), and the candidate was reopened for one coalescing repair, proved before the second freeze.
- **Highlight.** The dry runs met two test defects the guest gates did not: one of GitHub's environment, one of macOS's filesystem; each was read at source, proved, repaired test-only and read, with the product unchanged.
- **Highlight.** At the landed tip all 87 checks passed whole and alone with no skip.
- **Lowlight.** The v0.105.0 retrospective asked for a `ci.yml` run at the first integrated tip and at the freeze; this round's first was rc0's, so one defect cost an rc1 and the other a further dispatch.
- **Lowlight.** Check 90 was broken on `main` before the round and stayed red at both candidates; five review reads were not reached (the built commits of four carried items, idxlock's design, onecpu's test follow-up and rustup's last guard-case comment); separately, three landed items keep an open acceptance their measurements did not reach.
- **Lowlight.** One survey body overstated the WebGL cost it asked about, so the owner accepted a lower cost than he was told.
- **Feedback.** Measure a watch reaction at its heaviest producer's rate before it lands. Dispatch `ci.yml` on the backup branch at the first integrated tip even when the round stops at a local candidate. Read a fail-fast red with the list of what did not run. A test that pins a child's output pins its environment; a fixture that names a system path pins its platform.

## Follow-ups

Carried to v0.107.0, each with its record in the roadmap:

- `wglgrd`: the welcome's WebGL animations burn the CPU on a machine without a GPU; a guard to design.
- `atjoin`: a superseded mount attempt holds its lock across an unbounded join; its test commit awaits review.
- `rowdrp`: an automatic row drop keeps unsaved sidecar state with no end; its unit cases await review.
- `srchfm`: the drafts browser search reads no form value, alt text or placeholder; the widened search awaits review.
- `dmtabs`: the manual's embedded demo puts covered launcher controls in the tab order.
- `tablos`: a second page's load drops a just-added tab in 3 of 10 attempts.
- `idxlock`: an unreadable file locks booting windows behind the preflight; the design awaits its read.
- `dbroke`: a draft being created is listed as broken until it finishes.
- `tbcast`: keys typed into a broadcast group while a write is in flight reach the source terminal alone (58 to 72 percent lost to the peers under steady output).
- `tblclk`: a press on a rendered table cell shows its source.
- `chk64o`: check 64 fails directly after check 59; the repair awaits review.
- `sesser`: session saves are not serialized against each other or a peer's frame.
- `dirgon`: a removed or renamed loaded directory keeps showing in the file tree.
- `exitfl`: the exit flush skips a change whose save was sent and not answered.
- `annaft`: fourteen route handlers announce a stored mutation after a cancellable await.
- `xwmove`: a terminal with no session moved to another window arrives bare.
- `rbstale`: a full rebuild keeps an unreadable file's old search rows.
- `nonutf`: a control socket under a non-UTF-8 path leaves nothing to find.
- `reexec`: nine older re-executing tests may pass on a child that ran nothing.
- `uplist`: an upload lists its directory once per file.
- `c62err`: check 62 logs three unexplained server 500 lines.
- `grfref`: the graph is refetched on every watch frame.

Opened at the cut as rows of v0.107.0 by the lead's ruling, for the open parts of three landed items: `c105ct`, check 105's red in ten counted twenty times; `sibmsr`, the sdme build drivers' measured runs and defaults; `tsznat`, the terminal size repair's native reading. Remainders recorded only in closed items' last sections (check 90's skip page, check 163's R1, the wrapped-bullet repair's three test gaps, lstore's storage-global read, ldred's store order dependence, relstq's four remainders, the gateway cancel's R1 test-only line) stay there for the next round to find. Defects the owner finds in this release are filed as roadmap items.

## Platform and pipeline

- Windows and macOS ran the Rust suites on GitHub's runners at rc0 and rc1: `make ci-windows` green both times; `make ci-macos` red at the `cs_alias` tests, then at `chan-server`'s unit tests with the 22 binaries after them unrun; the backup-branch run 38632918671 at the repaired tip then ran the whole macOS step green (44 binaries, 5,310 passed). The browser scenarios ran on Linux in Chrome; native observations on Linux WebKitGTK only.
- `make windows-cross-check` ran green at both candidates and both rcs: a cross-compile, no Windows binary executed.
- The rc dry runs built every package with publishing skipped.
- The GA commit gets its own `make ci-linux`, whole browser suite and five dispatches on `0.106.0-ga`, its own `release.yml` dry run among them, each green before the owner's tag; its hash and those runs' figures are the publication record added to this report after the tag.

## Known gaps

- The owner's own wrapped-bullet case was seen under the GitHub theme, where the shipped repair changes nothing by source; only a hidden non-breaking space would explain it there and his account (typed by hand in chan) does not give one, so a case still there under GitHub is a third cause.
- The gateway cancel is unobserved on macOS and Windows; the tab focus order under a cancellation by Escape, on Firefox, Wayland, macOS and Windows; the terminal size fix is proved on Chrome alone; the control socket notice is read at source only on macOS and Windows.
- Three landed items keep an open acceptance; five review reads were not reached.
- The fallback control socket directory stays where another local user can create it first.
- A save from a second page that arrives while a moved terminal's write is in flight can still bring it back; a removed or renamed loaded directory still shows in the file tree.
- The owner's own checks on the rc builds (wrapped bullets under three editor themes, mark clicks, `--sleep`, the Devserver page after its deploy) are his; none is recorded here.
