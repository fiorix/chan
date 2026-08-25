# `chan serve PATH` does not always open a window

Status: accepted scope for v0.98.0, raised by the owner.

## What was seen

Typing `chan serve ~/src/thing` in a terminal is a request to look at that workspace. Today whether a window appears depends on which of three routes the command takes and on whether that workspace has been served before. Two of the routes can leave the user at the prompt with no window at all.

## The three routes

`decide_open_route` (`crates/chan/src/lib.rs`) picks a target from the shell's parentage and what is live on the box: `Desktop`, `Devserver`, or `Standalone`.

**Desktop.** `maybe_handoff_to_desktop` hands the path to the running app, which runs `open_workspace_from_handoff` (`desktop/src-tauri/src/main.rs`). If the workspace is already serving, it mints another window and the watcher opens it, which is the behavior this item wants. If it is not serving, it registers and calls `serve::start(..., mint_first_window = true)`, and that mints only when the workspace has no persisted window record:

```rust
let has_window = embedded.local_window_records().iter().any(|r| {
    r.kind == WindowKind::Workspace && r.workspace_path.as_deref() == Some(key.as_str())
});
if mint_first_window && !has_window { ... }
```

So a workspace being turned back on restores its saved windows and mints nothing. Windows do appear, but none of them is the one this command asked for, and focus lands on whichever the watcher happened to open last.

**Devserver.** The CLI sends `RegisterWorkspace` over the discovery socket, the devserver mounts the workspace (`register_workspace` in `crates/chan-server/src/devserver.rs` allocates a prefix and mounts, nothing more), and the CLI prints `chan: registered <path> with local devserver on port N` and exits. No window is minted anywhere. This is the route a terminal inside a devserver always takes, and the route a plain terminal takes when a devserver is the only live instance.

**Standalone.** The server binds and opens the system browser unless `--no-browser` is passed. A browser tab is the window here, so this route already satisfies the intent. Re-running against a workspace another process already holds fails on the flock with a pointer at `--devserver`.

## Desired contract

`chan serve PATH` always ends with a window for that workspace, focused, on every route:

1. Workspace already serving: mint a new window. Already true on the desktop route; must become true on the devserver route.
2. Workspace off: turn it on, restore its saved windows, and mint one more. The restored windows come up first and the new one comes up last, so the window the command asked for is the focused one.
3. Workspace never served: turn it on and mint its first window. Already true on the desktop route.

`--no-browser` keeps its meaning on the standalone route. A route that genuinely has nowhere to put a window (no GUI session, `CHAN_NO_DESKTOP_HANDOFF`) keeps printing the URL rather than inventing one.

## The ordering already mostly works, and should be pinned rather than built

`WindowRegistry::snapshot` (`crates/chan-library/src/windows.rs`) sorts by kind, then workspace path, then ordinal, then window id, and `reconcile` (`desktop/src-tauri/src/window_watcher.rs`) opens in snapshot order. A freshly minted window takes the next ordinal for its workspace, so it already sorts last among that workspace's windows and is opened last. What is missing is the mint itself in case 2, and a test that pins the ordering so it cannot regress into "whichever window the watcher reached first".

## Boundaries

The mint decision in `serve::start` and `open_workspace_from_handoff` on the desktop side, and the devserver's `RegisterWorkspace` handler plus the CLI's `Outcome::Registered` arm on the devserver side. The route decision itself does not change: this item is about what happens after a route is chosen, not about choosing differently. No change to the flock model, to `--here`, to the VCS-parent gate, or to the standalone bind path.

The boot re-serve path must stay as it is. It calls `serve::start` with `mint_first_window = false` precisely so a workspace whose windows the user closed does not reopen them on the next boot, and this item must not turn that into a mint.

## Open question: `cs window new --workspace PATH`

The owner raised this as a possible companion and asked for an evaluation rather than an implementation. The finding is that it is a separate feature and should not be bundled here.

`cs window new` (`crates/chan-shell/src/cli.rs`) takes no arguments and means "another window of whatever window I am in": it resolves through `$CHAN_CONTROL_SOCKET` and `$CHAN_WINDOW_ID`, so it only runs inside a chan terminal and only addresses the workspace already serving that terminal. Adding `--workspace PATH` changes it from a window-scoped verb into a second way to serve a workspace, with its own question of what happens when that path is not being served yet: either it refuses, and it is a narrow convenience over `cs window list` plus `cs window open`, or it serves, and there are now two commands that serve a workspace.

`--workspace .` is the weaker half of the idea. `cs` runs in a terminal whose working directory is already inside the workspace, so `.` almost always resolves to the workspace that terminal is already in, which is what the bare `cs window new` does. Its one real use is a terminal sitting in a different workspace's tree, and `chan serve .` covers that case once this item lands.

Recommendation: land the `chan serve` contract, and treat `cs window new --workspace` as a later item if the need survives.

## Acceptance

1. Desktop route, workspace already serving: `chan serve PATH` adds a window and that window is focused.
2. Desktop route, workspace off with saved window records: `chan serve PATH` restores the saved windows and adds one more, the added one opens last, and it is the focused one.
3. Desktop route, workspace never served: unchanged, one window.
4. Devserver route: `chan serve PATH` mounts the workspace and a window for it appears, both from a terminal inside the devserver and from a plain terminal that routes to a devserver. The printed line says a window was opened, not only that the workspace was registered.
5. Standalone route: unchanged, including `--no-browser`.
6. Boot re-serve still mints nothing: a workspace whose windows were all closed comes back with no window.
7. The snapshot ordering that puts a newly minted window last for its workspace is pinned by a test, so case 2's focus outcome does not depend on watcher timing.

## Implementation and evidence

Desktop user opens and boot restore now use an explicit `WorkspaceOpenMode`. Every user open mints one window after mounting and restoring persisted rows, while boot restore mounts without minting. The already-running desktop handoff retains its direct mint because no mount cycle is needed.

The ordering review found a gap in the original premise: workspace ordinals reused the lowest free number, so restored ordinals 1 and 3 gave a fresh window ordinal 2 and sorted it before the old window 3. Terminal windows retain lowest-free numbering, while workspace windows allocate above their family's current maximum. The regression fixture persists ordinals 1 and 3, reopens the registry, and requires the requested row to snapshot last as ordinal 4. Reverting that allocation made the test fail with actual ordinals `[1, 2, 3]`; restoring it made the same test pass with `[1, 3, 4]`.

The user-visible tradeoff is that workspace window titles can have gaps: three open windows may be numbered Window 1, Window 3, and Window 4 because a fresh window no longer reuses the closed Window 2 slot. Once every window in that workspace family is closed, the next mint starts at Window 1 again.

The devserver contract is conjunctive: `Registered` means the workspace is mounted and exactly one workspace window record was minted. Repeated registration reuses the mount prefix and mints another window. A missing registry is rejected before taking the workspace flock, and a mint failure returns `Error` rather than reporting a successful open. This keeps the existing wire schema while making the success text truthful: `chan: opened a window for PATH with local devserver on port N ...`.

### Proved on the headless build host

- `cargo test -p chan-library workspace_minted_after_restore_sorts_last_even_with_an_ordinal_gap`: pass after the deliberate red proof.
- `cargo test -p chan-server discovery_registration`: 2 passed, proving one mint per accepted request, stable prefix reuse, distinct IDs, and refusal before mount when no registry exists.
- `cargo test -p chan devserver_serve_note_says_a_window_opened`: pass, pinning the success text.
- `cargo test -p chan-desktop --bin chan-desktop`: 378 passed, including the explicit-open mint mode, both desktop handoff branches, and the boot restore no-mint guard.
- An isolated copied binary and throwaway devserver proved both devserver discovery contexts without touching the owner's live instance. A command carrying that test server's explicit terminal control socket and a plain-shell command with no `CHAN_*` context each exited 0, printed `opened a window`, mounted the requested workspace, and produced a distinct persisted/API window row. Repeating the first command kept its prefix and produced ordinals 1 and 2 with unique window IDs. The isolated server logged no warnings or errors and was stopped and removed after the check.
- The standalone route and `--no-browser` code paths are unchanged.

### Owner smoke: desktop serve windows

This host has no GUI session, so the visible window and OS-focus portions of acceptance checks 1 through 3 require one display-host smoke. Use the freshly built candidate desktop and its matching `chan` CLI, verify the About window's build id names the candidate commit, and keep the launcher open. `--desktop` below forces the route under test instead of depending on shell parentage.

Prepare three isolated paths in a normal terminal:

```sh
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chan-serve-window-smoke.XXXXXX")"
LIVE="$SMOKE_ROOT/live"
SAVED="$SMOKE_ROOT/saved"
FRESH="$SMOKE_ROOT/fresh"
mkdir -p "$LIVE" "$SAVED"
test ! -e "$FRESH"
```

Prepare the live and saved-record cases before judging results. Run `chan serve --desktop "$LIVE"` once and leave its Window 1 open. Run `chan serve --desktop "$SAVED"` twice, verify that its Window 1 and Window 2 exist, then use the launcher's On toggle to turn that workspace off and wait for both native windows to close. Do not create or register `$FRESH`.

1. Already serving: run `chan serve --desktop "$LIVE"`. Pass only if the live workspace gains exactly one window, the newly created Window 2 is frontmost, and keyboard input goes to it without another click.
2. Off with saved records: run `chan serve --desktop "$SAVED"`. Pass only if the saved Window 1 and Window 2 return, one previously absent Window 3 is added, and Window 3 is frontmost and accepts keyboard input immediately. Merely seeing three windows is not a pass: a frontmost Window 1 or Window 2 means restore ordering took focus instead of the requested window.
3. Never served: run `chan serve --desktop "$FRESH"`. Pass only if the path is registered and exactly one Window 1 appears frontmost and accepts keyboard input immediately.

Acceptance check 7 needs no manual step. `workspace_minted_after_restore_sorts_last_even_with_an_ordinal_gap` persists Window 1 and Window 3, reopens the registry, mints the requested Window 4, and asserts both the `[1, 3, 4]` ordinal sequence and the corresponding window-id order.
