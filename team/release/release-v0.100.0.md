# Release v0.100.0

Status: Draft; GA pending. Candidate `0.100.0-rc0` dry-run, `0.100.0-rc1` to follow.

The round opened on 2026-09-20 with a roadmap of 40 items: the frontend review's most critical findings, the v0.99.0 fix loop's follow-ups, three items carried from v0.99.0, the owner's two CLI spellings, and two items the round raised itself. At the time of this draft, 38 are landed on `main` at `7b927cf35`, 267 commits after the v0.99.0 tag, and two are open with marked placeholders below. What a user sees is a frontend that stops lying about its own state: a failed load, a rejected settings write, a failed revoke and a stuck file tab each say so where they happened. An edit made during an outage is not dropped, a close acts on the tab it names, and a tab keeps its state when it moves. Letter and punctuation shortcuts follow the active keyboard layout, including through an extension's frame. On the server side, `cs terminal close` means the tab and its child are gone, and a terminal chunk reaches an attaching client exactly once. The desktop reports a replaced workspace root without an operator verb. The CLI gains `chan open`, `chan close --forget` and a manual an agent can read in one call. <!-- GA: name the staging branch and the GA commit here. -->

## What shipped

### Server, desktop and library

- **Every turn-on verb answers 200 with the workspace's row.** The connected-devserver turn-on was the last route still answering 204. It now sends the launcher row the list route sends, not the devserver's entry, which carries the per-workspace bearer. Refusals keep their codes and bodies.

- **The desktop reads a 409 by its body.** A live-terminals refusal is recognized by its `live_terminals` discriminator and any other 409 shows its own message, so turn-on never raises the live-terminals confirm, because turn-on never blocks on terminals.

- **A timed-out devserver mount leaves alone a tenant it did not open.** An attempt whose bound expires compensates only for what it may have created. A root something else already mounted keeps its tenant, its terminal sessions and its `running` row, and the attempt reports that it timed out. The two tests that pin this hung every macOS CI run from the day they landed until the fixture fix in `3a9844d46`; see Validation.

- **An unavailable workspace still gets a window, and a test now says so.** A registration for a mounted but degraded workspace mounts, mints one window and returns success, and the degraded state is reported by the window and the launcher row. The behaviour is unchanged; what is new is a test that fails if it changes.

- **The desktop reports a replaced root without an operator verb.** The root health probe that only the devserver drove is now one function both embedders start, so on the desktop's own library a gone or replaced root reads `unavailable` within one fifteen-second probe period and clears when the original directory returns. The cadence is pinned against a literal; the devserver's call into the probe is unchanged by reading and pinned by no test, which the item records as its residual.

- **A terminal chunk reaches an attaching client exactly once.** Recording output and attaching now take the ring under one lock, so a chunk that races an attach can no longer arrive in both the snapshot and the live stream, and the sequence number a client resumes from is the true end of what it was sent. A reconnect after a raced attach loses no bytes.

- **A dropped indexer releases the recovery pass it claimed.** A coordinator that goes away mid-pass requeues its claim, so the next coordinator over that workspace can make progress, and a recovery action that keeps failing waits a cooldown between attempts instead of retrying back to back.

- **`cs terminal close` means the tab and its child are gone.** A close waits, within a shared five-second deadline, for every closed session's child to end, and fails naming each survivor with its pid instead of acknowledging a close that did not happen. A window reattaching to a closed session is told the tab closed rather than handed a fresh shell under the old name, and the next `cs terminal new` for that seat gets its name back.

- **`chan open` and `chan close --forget` are back as spellings.** `chan open PATH` is `chan serve PATH`, the same arguments and behaviour by construction, and a URL is refused exactly as `serve` refuses it. `chan close --forget` is `chan workspace forget`, including its live-terminal refusal and its `--on TARGET` reach. Both are visible in `--help`, and every existing prefix still resolves. This reverses the v0.94.0 ruling on the owner's word.

- **The agent manual fits in one read.** `chan dump-skill` prints an index by default (the frontmatter, the lead, and every topic with its purpose and the command that prints it), topic pages split into indexed parts under an 8 KiB budget, and `--full` is the explicit unbounded export. `cs dump-skill` speaks the same topics, so an agent never needs `chan` to read the manual of `cs`.

- **A lock probe that cannot tell says so, instead of reporting another holder.** The foreign-holder probe is three-state (absent, present, and unknown with its reason), so a transient open failure no longer labels a row as held by another process. The workspace status gains an `unknown` value on the wire, pinned both ways, carrying the probe's reason as the row's error; `chan workspace search` and `chan workspace status` refuse on it with a named code rather than query a server nobody observed or open a workspace a holder might own; and the launcher reads it as its own condition, worded as a lock state that could not be read, with every on, off, remove, bulk and deck action withheld. The equality test that sampled the probe twice now compares one recorded snapshot and releases the holder between observations, so a comparison that still read live status fails deterministically. Under a `ulimit -n` sweep the original mismatch reproduced once in 100 baseline runs and never on the candidate. The Rust work came from an owner-spawned agent's isolated branch and the launcher reader from the second worker (`08bc21649`, `13610371d`, `223f78d98`, `cd018169f`).

- **PLACEHOLDER (Lead completes at GA): the Rust review's lows were never triaged.** Done: the defect-shaped read (security, bug, concurrency, panic-risk and resource-leak kinds) is in progress on `v0100/rust-lows`, with dispositions entered in the ledger; the 26 defect-shaped gateway lows were offered to an owner-spawned agent on an isolated lane. Remaining: the dispositions, any small fix commits, the fold-along, and the counts this paragraph should state.

### Packaging, release and gate

- **The COPR publication probe outlasts a real COPR build.** The window is 7,200 seconds, justified by the measured worst normal release rather than a round number, and the trigger and verify steps are separate jobs, so verify can be re-run alone.

- **The frontend gate has no holes a broken bundle can ship through.** Everything that ships or renders a verdict runs under a `make ci-*` target, and a release job that builds a bundle by hand asserts the bundle exists before compiling it in.

- **The `/dl` release pipeline fails closed.** A tag that was asked for and cannot be found is an error, asset names are spelled once and every script derives from that spelling, and every updater payload the collector can publish is one the verifier requires a signature for.

- **The e2e harnesses report only what they measured.** A check that cannot evaluate its core assertion fails, or skips for a named environmental reason; a recorded result carries measured values; and a run always ends with a verdict file. The repair also surfaced a quiet wrong measurement: both Python harnesses were reading a terminal font chain the product never ships.

- **PLACEHOLDER (Lead completes at GA): a prerelease deb is spelled with a dot.** Done: on the owner's ruling, `requiredAssets` names the Debian form cargo-deb writes (`0.100.0~rc0-1`), and the comment beside the transform names GitHub's upload rewrite of `~` to `.`. Candidate `0.100.0-rc0`'s dry run (run `35741383319`) produced the eleven release artifacts, and the inventory against that list read PASS: 25 of 25, with all ten gateway service packages spelled `0.100.0~rc0-1`. Remaining: the same comparison on rc1's dry run, which closes the item.

### Editor

- **Rich copy no longer puts the session token on the clipboard.** Image URLs are written without the `t=` query parameter, which alone is a full bearer, so a URL carrying the session token never leaves the app. On a tokened serve an external paste gets a 401 and a broken image, and the `data:` upgrade stays what makes it render.

- **A checkbox cannot write to a read-only document.** One predicate answers "may this widget write" for every widget, checking both the read-only state and the editable facet. Read-only means read-only until the product question of a toggleable read-mode checkbox is ruled.

- **Editor triggers stay out of syntax that already exists.** Inside an existing image or link only the URL slot may open a bubble, the tag picker stays closed where a `#` could still become a heading marker, and no macro expands inside a fenced code block.

- **Image actions keep working after an edit above the image.** An action resolves its source range from the live syntax tree when it runs, and document-level listeners belong to one view and leave with it.

- **Document PDF export waits for its images.** The export measures only after every image has loaded or failed, inlines images once per export before the pages are cloned, and exports an embed as a printable link rather than a blank.

- **A page break is one thing on every surface.** On the owner's ruling the narrow reading holds: `<hr class="chan-page-break">` is the page break, a near miss is normalized to it on write, and `@pagebreak` stays an authoring macro that expands to it. The source editor's divider, deck splitting, both PDF exports, present mode and the CSS consult one definition. The inputs where a line scan and the renderer still disagree are measured and recorded as residuals.

### App shell, state and terminal

- **A close acts on the tab it was asked to close.** A close identifies its tab by id after the last await, is a no-op if the tab is gone, and does its bookkeeping against the tab's current pane and side, so a prompt can no longer make it remove a neighbour.

- **A tab reorder keeps every piece of live tab state.** Cloning a tab keeps every field unless the code names it as a deliberate drop, and a field added later is carried by default, with a test failing if nobody decides.

- **A restored transfer's id never collides with a new one.** Transfer ids are unique among every record the window holds, restored or new.

- **A canvas edit made during an outage is not lost.** A local change counts as sent only when it was sent, every session kind registers all five members or does not compile, and a degraded session has exactly one writer.

- **Terminal chords run exactly once.** Each chord the terminal claims produces one action through one rule that all four dispatch points consult, whether the renderer has focus or not.

- **Full-window covers block the app, not just hide it.** Every full-window cover blocks keyboard chords, the Ctrl+D capture and host commands through one registration a new cover cannot forget; the Backquote escape hatch still works. On the owner's ruling the screensaver lock is a real boundary for its window: host-bridge commands and native menu items are gated and focus is trapped in the PIN field.

- **An open menu owns Escape.** The first Escape closes the menu and nothing else, and focus returns to the control that opened it.

- **A terminal moved to another window keeps its tab state.** It arrives with the state a reload of the same tab would restore, a field is dropped only by a decision written where the payload is built, and a payload from an older build still reattaches the shell.

- **A file tab moved mid-load never shows loading for good.** A load that stops leaves no tab claiming to be loading, and a tab that moved while loading finishes or restarts its load where it now is.

- **Shortcuts follow the keyboard layout, not key positions.** Laurie Clark-Michalek's contribution is the foundation and keeps its authorship (`1a309f67c`, `97132b165`): letter shortcuts resolve through the typed key with Caps Lock and the Option glyph and dead-key fallback, so on Colemak Cmd+T opens a terminal instead of Find. On top of it, punctuation and Shift resolve through the active layout (Dvorak's comma opens Settings, its period enters Hybrid Nav, its slash splits, and the old physical positions do nothing), top-row digits and numpad zoom stay positional, and one matching rule serves the workspace, the launcher, both desktop bridges, terminal escape, shortcut capture and overrides. The extension keyboard relay moves to v2 across three repositories at once: Chan advertises key tokens, a consumer relays the raw keydown fields, and Chan resolves and validates the event itself. The v1 messages are gone, and the echo example, mobile-chat (`b8f0001e5`) and Doom's nested game frame (`053121201`) all speak v2. The echo extension round trip passes on the branch and on a main baseline. Doom's repository gate needed one test-fixture fix there (acknowledging the LAUNCH each client actually received), unrelated to the relay. The macOS Colemak, Dvorak and Option checks are pending for the contributor after release.

### Feature surfaces, launcher and identity

- **A move onto an occupied name is refused and names the path.** On the owner's ruling every gesture (rename, single drag, multi-row drag, cut and paste) refuses a collision and names the occupied path, which is what the server already did. The "Overwrite existing file?" confirm is gone because it offered an action the server refuses. Every moved file gets the drafts refusal, the conflict report and open tabs that follow it.

- **A duplicate list key no longer kills its panel.** Keys are unique for every shape of data the server may send, and a render throw inside a pane, an inspector section or the launcher's deck is contained: that surface shows it failed and offers a retry while the rest of the window keeps working.

- **A failed load is a state, not a retry loop.** A load that failed is not retried until something that could make it succeed changes (a retry, a directory change on disk, a scope change or a reload), and the failure shows where the content would have been.

- **A rejected settings write shows on its field.** A failed write is visible on the field that failed, the field shows the server's value again, a control commits once per decision, and every settings write reports through one `SaveStatus` vocabulary.

- **Rich Prompt submits over plain http.** Ids are minted through one helper that works in every context chan is served in, so a devserver reached over plain http no longer throws on `crypto.randomUUID`.

- **A failed revoke says it failed.** It says so next to what was not revoked, the token and grant lists stay visible and current, and revocation is confirmed through the app's own modal.

- **The connecting window offers Retry only after it tried.** The actions appear when the connection has failed or timed out, and the live region announces state changes, not the clock.

## Team and process

The round ran from 2026-09-20 in two shapes, and the difference between them is most of this release's story.

It opened as a team: a Fable coordinator, four Opus lanes on file-disjoint worktrees (Editor, Shell, Surfaces, Rust), and ProductLead and IntegrationLead sub-leads for review and assembly, each writing its own journal. The owner accepted all 36 evaluated items the same day and added two, and the round raised two more. That team landed 30 items by `f17184a4f` at 2026-09-21 00:46Z, 239 commits after the v0.99.0 tag. Then main took no commit for about 42 hours. Coordinator, sub-lead and lane seats were recycled through 122 handoff files, and the four in-flight items (the rc0 deb comparison, the replaced-root packet, the keyboard layout and the lock samples) were assembled and reviewed but not landed.

At 2026-09-21 22:12Z the host authorized a fixed serial plan: one worker, recycled between the four items in a fixed order, a journal checkpoint at every boundary, and no second item before the first had a verified result. Candidate `0.100.0-rc0` was cut under it (pin commit `f4f8dbd1e`, three local qualifications, a `publish=false` dry run). A coordinator taking over at 17:29Z on 2026-09-22 found the dry run's macOS job nearly three hours into a stall that three main CI runs had already shown to be a regression, not a slow runner.

At 18:37Z the host chose "Unblock now", and from there the round ran as a pipeline. Lead reviewed, gated and landed. The serial worker diagnosed and fixed the macOS hang, then took the replaced-root packet and the keyboard-layout crossing through scoped checks. From 20:27Z, at the host's request, a second worker ran the items that touch no file the first worker's lanes edit: the terminal chunk, the dropped indexer, cs-terminal-close, the launcher's unknown state, and the Rust lows read. At 20:24Z the owner ruled that the six unstarted items ship in this release. On the owner's offer, two isolated branches came from an owner-spawned agent with its own target: the CLI verbs (`chan open` aliases and the `dump-skill` index) and the lock-samples Rust work. Lead reviewed, gated and landed them like any lane's.

Every landing followed one cycle: the lane's scoped checks with mutation proofs, Lead's read of the diff, a rebase onto main with patch-id and range-diff equality, the full `make pre-push` gate against a committed sha with the porcelain read at both ends, an audit of the gate log by name, a fast-forward of `main`, a foreground push, and a `git ls-remote` check. Cargo work on the shared target serialized on one round lock. Six items landed this way between 20:35Z on 2026-09-22 and 00:12Z on 2026-09-23, after the macOS fix landed at 19:32Z, and lock samples and the keyboard-layout crossing landed together at 01:54Z.

## Validation

- **The rc0 artifact comparison.** Candidate `0.100.0-rc0` (`f4f8dbd1e`) passed three local qualifications: the full gate (4,204 Rust tests, 482 web test files with 4,560 tests), the Windows cross-check, and the gateway packaging isolation test. Its `publish=false` dry run (run `35741383319`) finished 13 of 14 jobs green and was cancelled by the host's decision at 18:41Z on 2026-09-22 with the macOS job still hung. The release context resolved `v0.100.0-rc0` and `publish: false`, no publishing job ran, and no tag or GitHub Release exists. The eleven `release-*` artifacts (25 regular files, 426,194,534 bytes) were downloaded into separate directories. The approved inventory helper read them against a manifest regenerated at the exact candidate from `requiredAssets`: PASS, 25 expected and 25 observed, with no missing, unexpected, duplicate, empty, blank-signature or non-regular path, and all ten gateway service packages spelled `0.100.0~rc0-1`. This proves the file inventory, sizes and hashes; it proves nothing about package contents, signatures, notarization or publication.

- **The macOS fixture defect and the 90-minute caps.** Three consecutive main CI runs (`35533948202`, `35537952951`, `35551953573`) were killed at GitHub's 360-minute default with `make ci-macos` alone unfinished. The cause was two tests added under the timed-out-mount item. Their fixtures compared a raw temp path with the registry's canonical root, which agree on Linux and differ on macOS under the `/var` symlink, so the park never fired and an unbounded rendezvous waited forever. It was reproduced on Linux with `TMPDIR` on a symlink, fixed by canonicalizing the fixture paths and bounding both rendezvous at ten seconds (`3a9844d46`), and proven red without the canonicalization (a named panic in 12 seconds). Both macOS jobs now carry `timeout-minutes: 90` (`551a59fff`). The first main run on the fix passed `make ci-macos` in 33 minutes.

- **Five green main heads.** Main CI was green on every platform on five consecutive landed heads: `551a59fff` (run `35774295414`, with one Windows re-run for a five-second wall-clock bound expiring on a slow runner), `6b752cf30` (`35781132258`), `7d2c80a41` (`35787642380`), `70e4366d5` (`35793010198`) and `e32eeb37b` (`35796122571`). The macOS job took 31 to 37 minutes on each, inside the cap. <!-- GA: add c768721b0 and later heads. -->

- **The per-landing gate totals.** Each full gate's Rust count is the previous gate's plus exactly the landed item's new tests, named in the log:

| landing   | item                          | blocks | passed | new |
|-----------|-------------------------------|--------|--------|-----|
| 551a59fff | macOS fixture fix             | 53     | 4,204  | 0   |
| 6b752cf30 | replaced root on the desktop  | 53     | 4,206  | 2   |
| 7d2c80a41 | terminal chunk on attach      | 53     | 4,211  | 5   |
| 70e4366d5 | CLI verbs and dump-skill      | 54     | 4,220  | 9   |
| e32eeb37b | dropped indexer               | 54     | 4,223  | 3   |
| c768721b0 | cs terminal close             | 54     | 4,228  | 5   |
| 7b927cf35 | lock samples, keyboard layout | 54     | 4,235  | 8-1 |

The last row is one gate over two stacked items: lock samples' eight new tests, less the source-pin test the keyboard branch deletes on its review's word. Every gate read 0 failed and 6 ignored. All four Svelte checks were clean, the host and AppImage devserver smokes passed, and the anchored failure scan was empty. The gate-log audit tool used on each was first shown to go red on four doctored logs. <!-- GA: add the lock-samples, keyboard-layout and final-head gates. -->

- **The echo extension round trip.** The browser smoke's extension check drives two shell chords from focus inside an extension's input and asserts they dispatch without reloading the iframe. It passes on main (`7d2c80a41`, the v1 relay) and on the keyboard-layout candidate (the v2 relay end to end), each with its own binaries and a `results.json`.

## Retrospective

**Highlights.** Once it ran as a pipeline, the round landed the macOS fix and six items in under five hours. Every landing was gated on a committed sha and audited test by test, and the gate totals in the table above account for every new test by name. The macOS defect was diagnosed from two preserved CI logs, reproduced on Linux, fixed and proven red and green, and landed within about two hours of being named; main CI proved it on macOS forty minutes later. The owner-spawned agent's branches came back with mutation proofs and needed no rework beyond the launcher reader the lock-samples item required.

**Lowlights.** For about 42 hours, from 2026-09-21 00:46Z to 2026-09-22 18:52Z, main took no commit. The work in that window was coordination: seats recycled through handoffs, sub-leads assembling and re-verifying packets, a strict serial order that let one blocked item hold the other three. Most of it produced no landing. The same window held the macOS signal. Main's `make ci-macos` had been killed at six hours three runs in a row since 2026-09-20, and the rc0 dry run's macOS job was read at the 16:57Z handoff as "unusual" but "still active", a slow runner rather than the regression the earlier runs already showed.

**Honest feedback.** Three things are worth carrying forward. First, a job that is still running is not evidence of health when the same job has been killed at its limit on the commits before it; read the history before the clock. Second, a shared cargo target served one lane's `chan_server` test binary to another lane, because the runner touched only the files its branch changed. That turned two foreign tests red on a tree that does not contain them. The remedy (touch every tracked file under `crates/`, `desktop/src-tauri` and `gateway/` inside the lock, and check every executed test name against the lane's own source) is now the rule for every worker cargo run, and full gates were never exposed because `gate.sh` already touches everything. Third, a worker fanned out four helper agents without the coordinator's approval against the round's two-worker rule. Their output was kept only as unverified input, and the read continued serially.

## Follow-ups

- **Carried to v0.101.0 by the roadmap.** The frontend review's remainder (source-text tests, duplicated answers, history-narrating comments, hand-mirrored contracts, the unowned remainder), nine v0.99.0 follow-ups, four items raised during this round (refusal shapes, the team poke's unanchored path, the write queue's idle signal, an undismissable expired survey), and eight items from the development archive's backlog are in `team/roadmap/README.md` under v0.101.0.

- **Residuals the items record.** The timed-out-mount item leaves the launcher showing "Off" beside a running status pill, a vocabulary question for the whole surface. The replaced-root item's devserver wiring is verified by reading and pinned by no test. Page breaks keep a measured set of inputs where a line scan and the renderer disagree. The duplicate-list-key item's per-tab boundaries do not catch a duplicate key in their enclosing tab list, and the graph still lacks mounted coverage.

- **Noticed during landings.** Two `Cargo.toml` `test-util` comments do not name the attach seam. The fd-store handoff reads the sequence and the ring tail under separate locks on the restart path. A chan-library test wraps a real-filesystem sequence in a five-second wall-clock bound that a slow Windows runner can expire. `desktop/design.md` does not mention the root health probe the embedded host now drives. A requeued recovery pass can wake a dropped indexer's leftover driver. The launcher's bulk-skip note calls an `unknown` row "locked". The ledger names where each should go.

- **Other repositories.** mobile-chat and Doom state the Chan version the v2 relay needs only in their READMEs, and their next releases should follow this one.

## Platform and pipeline

The keyboard-layout crossing reached all three repositories at 01:54Z on 2026-09-23, each as a fast-forward pushed in the foreground and verified with `git ls-remote`: chan `main` to `7b927cf35`, then, guarded on that result, `chan-ext-mobile-chat` `main` from `50341df` to `b8f0001e5` and `chan-ext-doom` `main` from `a7884f9b4` to `053121201`. Neither extension repository publishes on a push to `main`; their releases are tag-triggered and follow this one, because both state that the v2 relay needs Chan v0.100.0 or newer.

<!-- GA: Lead adds the Platform and pipeline paragraph (the GA commit, its ci.yml run, the release and downstream runs) and a Known gaps section. -->
