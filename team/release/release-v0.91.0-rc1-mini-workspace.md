# RC report: 0.91.0-rc1 / mini-workspace

## Scope

A standalone terminal window becomes a full file surface over the server machine's disk, with no workspace behind it. Item: [a-standalone-window-cannot-reach-the-files-it-is-about](../roadmap/v0.91.0/a-standalone-window-cannot-reach-the-files-it-is-about.md).

1. **`RootedFs` core, extracted.** `chan-workspace` grows a crate-private capability core carved out of `Workspace`, which now delegates to it rather than keeping a second copy of the guards.
2. **`MiniWorkspace`.** A public, metadata-free facade over that core, rooted at `/` with canonical `$HOME` as a protected start directory: no registry row, no lock, no index, no graph. Symlinks inert, deletes limited to regular files and empty directories, no-clobber moves and copies with a whole-tree preflight and a temp-sibling commit.
3. **The standalone Files backend.** Mounted on the shared workspace-less terminal tenant only: context, listing, streamed reads, CAS writes, create/delete/move/transfer, uploads and attachments, behind the same bearer and the same `auth_middleware` as every other route.
4. **A scoped watcher.** One non-recursive OS watch per subscribed directory, never a recursive watch of `/`, plus a begin/commit/cancel mutation bus so a window does not see its own writes as external changes, and does not see its own atomic-write temporaries as files.
5. **One capability model in the SPA.** `windowCaps` from the window kind plus a tenant-injected marker, a Files layout-blob namespace, and an `?app=files` request marker. The launcher's own files affordances are retired in favour of it.
6. **Routing.** `cs window new` opens another window like the calling one; `cs open` and `cs terminal new --path` work where the files are; a `cs open` that escapes its workspace is routed to a standalone window, reused or minted with the frame parked for its first attach, and a burst of routed opens fills one window rather than one per file.

## Commit range

`0.91.0-rc1..mini-workspace`: 26 commits, `aee1c967` through `b479a39e`. Merged as `ecd72335`.

## Validation

- Scoped own-gate on the branch before intake: `cargo fmt --check`, `cargo clippy -p chan-workspace -p chan-server -p chan-library --all-targets -- -D warnings`, and `cargo test` over the same three crates. Green on the committed state, re-run after the last edit.
- `cargo check -p chan-library --all-targets --target x86_64-pc-windows-gnu` in a disposable sdme container, the non-Linux arm the push gate cannot see. **Run against the unrepaired tree first and confirmed red** on the three Linux-only items the blocker exposed, then green after the repair.
- Integrated gate on the merged candidate: fmt, `clippy --all-targets -D warnings`, `cargo test --all-targets` (33 test binaries), `cargo build --no-default-features`, `make web-lock-check`, `make web-check` (419 web test files, 3755 workspace-app tests), `make shortcuts-check`, `make gateway-fmt`, `make gateway-lint`, `make gateway-build`. All green.
- Roughly 200 new Rust test functions and 36 changed web test files, including wire-dialect refusals, five alternate spellings of the protected start directory, symlink inertness across every operation, FIFO refusal, non-UTF-8 names skipped rather than lossily aliased, the cross-device fallback driven directly, and about 18 async route tests over a real temp-rooted `AppState`.
- Adversarial review of the diff by two independent passes, the second tasked with refuting the first. The `RootedFs` extraction was diffed against `main`'s `Workspace` function by function; no guard was found dropped or reordered.

## Intake findings, all fixed on the branch

1. **Blocker, two of three CI arms.** A new test was inserted between an existing `#[cfg(target_os = "linux")]` and the test it belonged to, so `fdstore_skip_cleanup_reaps_only_terminal_windows` compiled everywhere and referenced three Linux-only items. `chan-library`'s test target could not build on macOS or Windows, and the Linux-only push gate is blind to it by construction.
2. **Major, unbounded recursion.** `copy_tree_plain` created the destination before reading the source, so a destination inside the source was enumerated as one of the source's own entries. Reachable from the File Browser in three keystrokes. The cross-device move lane carried the same recursion through the same function.
3. **Web suite red with every test passing.** A test that imports a fresh `store.svelte` left that module's debounced session save scheduled; it fired after the file finished and touched a torn-down `window`. vitest reported an unhandled error and failed the run while all 377 files and 3755 tests passed, so the summary did not name the cause.

## Hand-smoke (pending)

- A standalone Files window driven by hand: browse, edit, save, delete, move, copy, upload, and a copy-into-itself refusal surfacing as a message rather than a hang.
- `cs open` on a path outside every workspace, twice in a row, landing in one window; and `for f in *; do cs open "$f"; done`.
- macOS and Windows behaviour beyond the cross-compile: the cross-check compiles and lints, it does not link or run.

## Known risks

- **The largest new attack surface in the release.** A window can read and write the machine's filesystem. The gate is capability-based and server-side, but over a tunnel origin authorization lives in the gateway layer rather than in `auth_middleware`, which exempts tunnel-origin requests from the token check. That is pre-existing and unchanged here (`auth.rs` has a zero-line diff), but it is load-bearing for a surface that now reaches beyond a workspace root, and it deserves the owner's explicit sign-off.
- **Layering.** The scoped watcher and the mutation bus landed in `chan-server` while `.agents/principles.md` assigns watch to the `chan-workspace` core; and "Workspace is the boundary" now has a second public facade the principle does not mention. `design.md` and `crates/chan-workspace/design.md` are updated thoroughly; `.agents/` is not. Worth a ruling before it becomes precedent.
- **No ceiling on watch scopes**, so no ceiling on OS watches: one non-recursive watch per subscribed directory, with no per-socket or global cap.
- The protected-path guard is an exact match against the root and the start directory, so an *ancestor* of the start directory can still be moved away, after which the start directory resolves to nothing and the window falls back to `/`.

## Changelog-worthy user impact

- Added: a standalone terminal window browses and edits the machine's files, with no workspace, lock or index behind it.
- Added: `cs window new` opens another window like the calling one.
- Changed: `cs open` on a path outside your workspace opens it in a standalone window instead of refusing, and a burst of opens fills one window.
- Added: `cs terminal new --path` works where the files are.
