# Release v0.91.0

71 commits, 189 files, +14317/-1901 since v0.90.0. Four candidates. Two accepted features, and a third body of work that came entirely from the owner testing the candidates.

## What shipped

**A standalone window browses and edits the machine's files.** A window opened without a workspace now carries the file browser and the editor over the server machine's filesystem, with no registry row, lock, index or graph behind it. `chan-workspace` grew a crate-private `RootedFs` capability core carved out of `Workspace`, and `MiniWorkspace` is the metadata-free facade over it: rooted at a capability root with the canonical `$HOME` protected, symlinks inert everywhere, deletes limited to regular files and empty directories, no-clobber moves and copies. A scoped watcher attaches one non-recursive OS watch per subscribed directory rather than a recursive watch of `/`. `cs window new` opens another window like the calling one, `cs terminal new --path` starts a terminal where the files are, and a `cs open` that escapes its workspace is routed to a standalone window instead of refused.

**Terminals open on a shell you pick, on Windows.** The server discovers the shells the machine actually has -- PowerShell 7, Windows PowerShell, cmd, Git BASH, every installed WSL distribution -- each with its own argument convention, and the pane's New terminal menu offers them. `[[terminal.profiles]]` in `server.toml` renames, re-arguments, hides or adds one, and `terminal.default_profile` chooses the default. macOS and Linux discover nothing: the login shell is already the system-wide answer there, and enumerating `/etc/shells` offered a picker listing shells the user had never chosen. The feature is unseeded off Windows, not removed.

**A tab dragged to another window arrives as itself.** `crossWindowPayload` ended in a catch-all that returned `{ kind: "terminal" }` for every kind it did not list, so a dragged graph, file browser or dashboard tab declared itself a terminal: the target opened a fresh one and the accepted drop closed the original. It is now exhaustive over the `Tab` union, ending in a `never` binding, and the three view-state kinds cross through the session serializer -- rebuilt by exactly the code a reload runs.

**AUR publication restored.** Suspended since 2026-08-06 while Arch restricted pushes during the malicious-packages incident. The restriction lifted on 2026-08-11 and the item's own re-check protocol could not see it: it watched the news index, and the announcement went to aur-general.

## Team and process

Solo round with host agents. The candidate cycle ran to four:

- **rc1** integrated the two feature branches. Seven defects were fixed at intake, three of them found by the gate rather than by review: a stolen `#[cfg(target_os = "linux")]` that broke the macOS and Windows CI arms, an unbounded recursion copying a directory into itself, a leaked debounce timer that failed the web suite with all 3755 tests passing, a malformed profile stanza that discarded the whole `server.toml`, a picker reading live config while the spawn read a boot snapshot, `chan config get` erroring on both new keys, and shell classification that only worked on Windows.
- **rc2** carried the cross-window drag fix and the capability gating.
- **rc3** carried the file browser opening at its directory.
- **rc4** carried Windows-only shell discovery, four fixes from the owner's rc3 session, and routed-window minting.

Everything from rc2 onward came from the owner testing candidates on real hardware. No review pass found any of it.

## Validation

Full `make pre-push` green on every candidate. The gate earned its place: across the rc4 cycle alone it caught a source-text assertion pinned to an old spelling, a real discard bug in a PTY test helper, a `node:path` import that passed vitest and failed `svelte-check`, and an `is_routed_mint` accessor added to the wrong type -- the last two because a narrower `cargo check` or a single vitest file is not a substitute for building the workspace.

New coverage: `scripts/e2e/browser-smoke/checks/124-tab-cross-window-drag.mjs` drives two real windows through the real drag handlers, and was **proven to fail before it was trusted** -- with the catch-all restored it reports `dashboard: crossed the window boundary as "terminal"`. `scripts/e2e/scenarios/tab-drag-and-drop.md` carries what no harness can reach.

## Retrospective

**Highlight.** The defect that started the drag work was found by another agent and reported with a fix already written. Reading it against the live tree established that the fix was not in this repo at all, that dragging a draft could delete the file, that both drop handlers accepted before knowing whether the rebuild worked, and that the reported "unrecoverable" loss was recoverable through the closed-tab stack. The report was right about the symptom and wrong about three of its four conclusions.

**Lowlight.** Four candidates and roughly a dozen gate runs, most of them lost to the box rather than the code: a disk that hit 100% three times because every pin bump layers a fresh debug build into `target/debug/deps` without evicting the last; a container that lost FUSE, so the AppImage could not mount itself; and a `.git` bind dropped by a container restart that was itself done to chase the FUSE theory.

**Honest feedback.** Two capability bugs shipped in rc1 and rc2 that a single question would have caught: does this surface exist in a window with no workspace? The graph affordances and the inspector's report loads were both written as though every window has a workspace, and both were found by the owner rather than by the reviews that read the same diffs.

## Follow-ups

- `cs download` / `cs upload` reach and the `/api/fs` namespace migration -- accepted for v0.92.0 with one open decision.
- "Graph from here" on a directory opens without the directory's files.
- The Linux desktop still refuses WebGL after its dma-buf blocker became driver-scoped in v0.89.0.
- `desktop_liveness_probe_bounds_missing_and_stale_sockets` remains load-sensitive at 3 red in 15 on `main`.
- An external edit intermittently never reaches a dirty editor, carried from v0.88.0 with its reproducer preserved.

## Known gaps

- **WSL profile terminals lose every `CHAN_*` variable**: nothing sets `WSLENV`, so `cs` does not work inside one. Needs a Windows host.
- **Cross-window drag is unverified on the three desktop WebViews.** No automation protocol can drag between two top-level windows, and the shells expose no automation endpoint. TD-08 in the scenario pack carries the manual procedure; this matters because WKWebView mangles a MIME type carrying `:` or `|`, which is why the drag scope is hex-encoded.
- A moved file-browser tab does not carry multi-selection, inherited from the reload path it rides.
