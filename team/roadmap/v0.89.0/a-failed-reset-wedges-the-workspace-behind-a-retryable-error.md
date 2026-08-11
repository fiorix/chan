# A failed reset wedges the workspace behind a retryable error

Status: REGISTERED 2026-08-11, found during the v0.89.0 scope triage while verifying the `wipe-dir-retry-budget-is-untested` draft, which the owner deferred in the same pass. That draft descends from [audit-the-workarounds-nobody-followed-up](../done/audit-the-workarounds-nobody-followed-up.md) and describes one end of a failure chain: a retry budget resting on an unmeasured claim, whose worst outcome it records as "a visible failure and not a data-loss path". It reaches for the other end in one sentence, that a partial wipe has already happened by the time the budget is exhausted, and stops there. This item is that other end, and the outcome is neither visible nor bounded. The owner accepted it as v0.89.0 scope on that difference, and deferring the `wipe_dir` draft is safe precisely because this item covers the severe half of what it points at.

## What

`perform_reset` (`crates/chan-server/src/routes/storage.rs:157`) takes the tenant's `WorkspaceCell` out of its `RwLock` near the top and puts it back on exactly two of the eight ways out. On the other six it returns `Err` with the cell still `None`, and nothing in the process ever puts it back. From then on every request that needs the workspace fails with `StateAccessError::Missing`, which `err_state` maps to `503` with `Retry-After: 1` and the message "workspace state is temporarily unavailable". The tenant is permanently dead and reports that it is briefly busy. Only a process restart clears it.

The function's own doc comment states the invariant this breaks:

> Replace `state.workspace_cell` end-to-end. Holds the write lock the entire time so handlers receive a nonblocking busy result throughout the old-workspace to new-workspace transition; they never observe the `None` middle state.

Holding the write lock is what makes the `None` middle state unobservable *while `perform_reset` is running*. It does nothing once the function has returned and the guard has dropped, which is the only moment that matters here. `StateAccessError::Missing` is even spelled "workspace cell missing outside reset window" at `crates/chan-server/src/state.rs:211`, so the name of the error says the state it describes is not supposed to outlive the window.

Nothing here was observed at runtime. The item is read off the code at `f9c2878c`, and the "Not established" section at the end records what has not been executed and what would settle it.

## The eight exits, counted at `f9c2878c`

The cell is taken by `cell_guard.take()` at `storage.rs:166` to `storage.rs:168`. Every exit after that point:

| line | what happens there                          | error    | cell after |
| ---- | ------------------------------------------- | -------- | ---------- |
| 199  | workspace_strong.watch(bridge)              | Core     | None       |
| 203  | state.server_config.lock()                  | Poisoned | None       |
| 213  | busy restore, then return Err at 218        | Busy     | restored   |
| 227  | Library::reset_workspace                    | Core     | None       |
| 231  | Library::open_workspace                     | Core     | None       |
| 239  | workspace.watch(bridge)                     | Core     | None       |
| 243  | state.server_config.lock()                  | Poisoned | None       |
| 256  | success install, then Ok(report) at 261     | none     | installed  |

Two things in that table are worth naming. The two exits that reinstall are exactly the two the doc comment describes, the Busy restore and the success path, which is why reading the comment does not expose this. And the Busy branch has two exits of its own (`watch` at line 199, the `server_config` lock at line 203) *ahead* of its restore at line 213, so even the path documented as restoring the original workspace can leave the cell gone.

The write-lock acquisition at lines 161 to 164 is the one fallible call that is safe, because it precedes the `take`.

## Two of those six exits are a call the boot path deliberately treats as non-fatal

`Workspace::watch` is the same function at `storage.rs:199`, at `storage.rs:239`, and at boot. The boot path warns and carries on (`crates/chan-server/src/lib.rs:646`):

```rust
Ok(Err(e)) => {
    tracing::warn!("filesystem watcher registration failed: {e}");
    eprintln!(
        "NOTE: live file-watching is unavailable ({e}); external edits \
         reconcile on demand. On Linux, raise fs.inotify.max_user_watches \
         to re-enable it."
    );
}
```

The comment above it at `lib.rs:625` names the expected cause: "A registration failure (most often the Linux inotify watch limit, fs.inotify.max_user_watches) leaves the watcher absent and external edits reconcile on demand, rather than failing the boot." That is a decision, written down, that a workspace without a watcher is still a workspace worth serving.

The reset path takes the opposite decision on the identical call and does not say so. It also takes it silently, since the outcome is not "reset without a watcher" but "no workspace at all". This is the single strongest piece of evidence that the six exits are an oversight rather than a policy, and it supplies a concrete trigger that is not hypothetical: a host at its inotify watch ceiling boots fine and wedges on reset.

## Nothing else reinstalls it

`CellHandle`, the route layer's implementation of `chan_library::WorkspaceCellHandle` (`lib.rs:1438`), has three methods and no installer: `workspace`, `cancel_reindex`, and `clear`. `clear` takes the cell out; nothing on that trait puts one in.

Three sites in the whole server write `Some(WorkspaceCell { .. })` outside test fixtures. `lib.rs:614` builds the cell at boot, into a lock nothing else holds yet. `perform_reset` writes the other two, at `storage.rs:213` and `storage.rs:256`. `install_workspace_cell` (`crates/chan-server/src/routes/metadata.rs:254`) is the only reusable one, and it is a bare private `fn` in a sibling route module.

So after a failed reset there is no recovery path in-process. Not a background repair, not the next request, not the control socket.

## The failure conceals itself, which is the expensive half

`err_state` (`crates/chan-server/src/error.rs:41`) folds `Missing` in with `Busy`:

```rust
StateAccessError::Busy | StateAccessError::Missing => {
    let mut response = err(
        StatusCode::SERVICE_UNAVAILABLE,
        "workspace busy: workspace state is temporarily unavailable; retry in a moment"
            .into(),
    );
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from_static("1"));
    response
}
```

`Busy` is genuinely transient: it is what `try_read` returns while a reset holds the write lock, and it clears within the reset's own duration. `Missing` after a failed reset never clears. Both answer `503` with `Retry-After: 1` and a sentence that says the condition is temporary, so a client following the header retries a state that will not change. Raw grep at `f9c2878c` finds 102 `try_workspace()` call sites outside `state.rs` and 65 `err_state(...)` call sites outside `error.rs` (both counts include test modules), which is the blast radius: essentially the whole workspace-facing API answers this way at once.

The reset response itself is a different status and does not carry the lie. `ResetError::Core` goes through `err_from` (`error.rs:60`), so a wipe I/O failure lands on the catch-all at `error.rs:80` as `500` and a foreign flock holder lands on `409`. The operator sees one honest error, then a tenant that says "retry in a moment" indefinitely.

A retried reset does not reach `perform_reset` at all. `api_storage_reset` snapshots the workspace first, at `storage.rs:81`, so it can close doc and scene sessions before the swap:

```rust
let doc_workspace = match state.try_workspace() {
    Ok(workspace) => workspace,
    Err(e) => return err_state(&e),
};
```

That gate returns the same `503` forever. This corrects the shape the finding was first written in: the retried reset is refused at the gate, not at the `expect` below it.

## A second reset that overlaps the first does reach the `expect`, and that is worse

`storage.rs:166` to `storage.rs:168` is:

```rust
let mut cell = cell_guard
    .take()
    .expect("workspace cell missing outside reset window");
```

The gate above is a check, not a hold. Two overlapping reset requests can both pass `try_workspace` while the cell is still present; the first then holds the write lock for its whole run and the second blocks on `write()` at `storage.rs:163`. If the first exits on one of the six `None` arms, the second acquires the lock, takes `None`, and panics.

`Cargo.toml` sets no `panic = "abort"` on any profile, so the panic unwinds: `spawn_blocking` turns it into a `JoinError` and the handler answers `500` from `storage.rs:105`. The process survives. What does not survive is the lock, because the panic happens while the write guard is alive, which poisons the `RwLock`. From that point `try_workspace_cell` returns `Poisoned` (`state.rs:222`) and `err_state` answers `500` (`error.rs:54`). So the sequence upgrades a wedge that lies about being retryable into a wedge that at least reports a server fault, by way of a panic.

This ordering is read off the code, not demonstrated. It needs two reset requests in flight against one tenant, and nothing in the shipped UI issues even one (see the last paragraph of the tests section).

## The sibling import path gets this right, which is the argument that this is a defect

`perform_metadata_import` runs the same take-drain-swap protocol against the same cell and closes it correctly (`metadata.rs:228`):

```rust
let import_result = state
    .library
    .import_metadata_archive(
        &state.workspace_root,
        archive.path(),
        MetadataImportOptions { rescan, force_scm },
    )
    .map_err(MetadataImportError::Core);
let restore_result = state
    .library
    .open_workspace(&state.workspace_root)
    .map_err(MetadataImportError::Core)
    .and_then(|workspace| install_workspace_cell(state, workspace));

restore_result?;
import_result
```

The operation's result and the reinstall are computed separately, the reinstall is always attempted, and only then does anything propagate. Its take is safe too: `take_workspace_cell` (`metadata.rs:246`) returns `Err(MetadataImportError::Busy)` on a `None` cell rather than asserting, so a second import cannot panic the way a second reset can. The two error enums are structurally identical, `Busy` / `Core` / `Poisoned` at `storage.rs:113` and `metadata.rs:171`, so the divergence is in the control flow alone.

The import path is the right shape, not a finished answer, and adopting it should not be described as closing the whole class. `restore_result?` at `metadata.rs:242` discards the import error whenever the restore also failed, and `install_workspace_cell` is itself fallible, because the cell it installs comes from `build_workspace_cell` (`metadata.rs:267`), which it calls at `metadata.rs:258` and which fails on the `watch` registration at `metadata.rs:278` and on the `server_config` lock at `metadata.rs:282`, so a failing reinstall still leaves the cell `None`. What it guarantees is that the reinstall is attempted, which is the property the reset path lacks entirely.

## The wedge lands on a partially wiped workspace

`Library::reset_workspace_with` (`crates/chan-workspace/src/library.rs:362`), which is the whole body of `reset_workspace` at `library.rs:352`, wipes five subsystem directories in a loop at `library.rs:416`, with `removed += wipe_dir(dir)?;` at `library.rs:424`:

```rust
let subsystems: [(&str, &Path); 5] = [
    ("index", &workspace_paths.index),
    ("graph", &workspace_paths.graph_dir),
    ("sessions", &workspace_paths.sessions),
    ("tokens", &workspace_paths.tokens),
    ("report", report_dir),
];
```

A failure at the third entry returns with `index` and `graph` gone, `sessions` partly gone (`remove_dir_all` is not atomic and can delete children before failing), and `tokens` and `report` untouched. The `ResetMode::Everything` registry removal at `library.rs:434` sits after the loop, so a partial wipe also leaves the registry row pointing at a workspace whose state is half deleted.

The doc comment at `library.rs:350` says re-creation of the skeleton happens lazily on the next `open_workspace`, which is the reason a partial wipe is normally self-healing. That repair never runs here: the reset failed at `reset_workspace` (`storage.rs:227`) and never reached `open_workspace` at `storage.rs:230`.

By the time any of this happens the tenant has already been stripped for the swap: `doc_sessions.close_all` and `scene_sessions.close_all` at `storage.rs:85` and `storage.rs:89`, every terminal session closed with `terminal_sessions.close_all(CloseReason::Workspace)` at `storage.rs:165`, `cell.indexer.cancel()` at `storage.rs:171`, `cell.watch_handle.take()` at `storage.rs:174`. All of that is committed before the first fallible call. The wedge is therefore not "the reset did not happen"; it is "the reset happened destructively, then stopped".

## Where the deferred draft joins this

`wipe_dir` (`library.rs:613`) retries `remove_dir_all` on a non-empty directory on a bounded budget, at `library.rs:634`:

```rust
Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty && attempt < 20 => {
    attempt += 1;
    std::thread::sleep(std::time::Duration::from_millis(10));
}
```

Twenty attempts at ten milliseconds, so 200ms, after which `library.rs:638` returns the error. That return is one of the errors that produces the wedge described here, arriving through `storage.rs:227`. It is not the only one, and it is probably not the most likely one: any I/O failure in the wipe, a foreign flock holder, an `open_workspace` failure, a `watch` registration failure of the kind the boot path expects and tolerates, or a poisoned `server_config` mutex reaches the same six exits.

That is why the two split cleanly. Whether 200ms is the right budget is a question about how often the wedge is entered. Whether entering it destroys the tenant is a question about what happens once. This item is the second question, and it is answerable without settling the first.

## What the tests cover today

`storage.rs` carries three tests, all in the `mod tests` at `storage.rs:265`:

- `err_from_reset_maps_poisoned_locks_to_500` (`storage.rs:356`), a pure mapping check on `err_from_reset`.
- `handler_reset_completes_without_an_external_workspace_holder` (`storage.rs:364`), which drives the handler down the success path and asserts `200`.
- `handler_reset_restores_busy_cell_and_succeeds_after_holder_drops` (`storage.rs:379`), which drives the Busy path, asserts `409` with `Retry-After: 1`, asserts by `Arc::ptr_eq` that the restored cell is the original workspace, then makes up to eleven further attempts before requiring a `200`.

So the two exits that reinstall the cell are both covered, and the third test asserts cell presence after the Busy exit specifically. None of the six exits that do not reinstall is exercised by any test, in this crate or elsewhere. The gap is exactly the complement of what is covered, which is the shape that makes it easy to miss on review: the reset path looks well tested because its two happy exits are.

One severity qualifier, stated because it cuts against the item. The route is mounted at `crates/chan-server/src/lib.rs:1616` and the SPA wrapper `storageReset` exists at `web/packages/workspace-app/src/api/client.ts:1107`, but a grep across `web/` at `f9c2878c` finds no caller for that wrapper. Nothing in the shipped UI issues a reset today, so the reachable driver is an HTTP client against the tenant API rather than a button. The module doc at `storage.rs:6` still describes a frontend that reloads the window after a successful reset, which no longer has a caller behind it.

## Contract

- A reset that fails leaves the tenant serving, or fails in a way a client can distinguish from a transient condition. Never both broken and quiet.
- The cell is reinstalled on every path out of the reset window, following the import path's shape: compute the operation's result and the reinstall separately, always attempt the reinstall, then propagate.
- `StateAccessError::Missing` observed outside a live reset window is a server fault, not a retryable condition, and does not carry `Retry-After`.
- Entering `perform_reset` with the cell already `None` is answered, not asserted. `take_workspace_cell`'s `Err(Busy)` is the existing precedent.

## Acceptance

- A test drives `perform_reset` into each fallible arm after the take and asserts `state.try_workspace()` is `Ok` afterwards. Arms differ in how hard they are to reach and the test should say so rather than skipping the awkward ones: the two `server_config` arms are reachable by poisoning that mutex from another thread, for which there is precedent at `crates/chan-server/src/state.rs:361`, and the adjacent technique of holding a lock from another thread rather than poisoning it has precedent at `crates/chan-server/src/routes/mentions.rs:133`, where the spawned thread holds the write guard to force a `Busy` response; the `reset_workspace` arm needs a wipe that fails, which on Linux means making a state directory undeletable and which does not work when the suite runs as root, so whatever seam is chosen has to be checked against the container the gate runs in.
- One test pins the status distinction, so a permanent failure cannot present as retryable. Asserting the status alone is not enough; assert the absence of `Retry-After` on the permanent arm, since both conditions are `503` today and the header is the part a client acts on.
- A test that a second reset arriving while the cell is `None` returns a status rather than panicking, which also pins that the `expect` at `storage.rs:168` is gone or unreachable.
- The two existing passing tests still pass unchanged. They cover the two exits that already behave, and a fix that rewrites the reinstall must not move them.

## Boundaries

Files in scope:

- `crates/chan-server/src/routes/storage.rs`, the six exits and the `expect`.
- `crates/chan-server/src/routes/metadata.rs`, if the installer is shared rather than duplicated.
- `crates/chan-server/src/routes/mod.rs`, for the visibility change that sharing requires.

The installer should be extracted rather than copied. Two implementations of "build a `WorkspaceCell` and put it in the lock" is how the paths diverged in the first place, and `build_workspace_cell` (`metadata.rs:267`) is already the whole of what `storage.rs:192` to `storage.rs:217` and `storage.rs:232` to `storage.rs:260` each open-code.

It is not reachable from `storage.rs` as declared, and this needs doing deliberately. `install_workspace_cell` and `build_workspace_cell` are bare `fn` items in `routes::metadata`, and both `mod metadata;` (`crates/chan-server/src/routes/mod.rs:30`) and `mod storage;` (`routes/mod.rs:45`) are private modules of `routes`, so a private item in one is not nameable from the other. Sharing needs `pub(super)` on the helpers, or a move into a module both can see. `routes/mod.rs:47` already carries the precedent and the reason, in the comment above `pub(crate) mod team_config;`.

One design decision the extraction forces: `ResetError` (`storage.rs:113`) and `MetadataImportError` (`metadata.rs:171`) are distinct types with identical variants, so a shared helper needs one error type, a `From` between them, or a generic over the constructor. Pick one deliberately; collapsing them may be right, but it changes two response mappings (`err_from_reset` at `storage.rs:119` and `err_from_metadata_import` at `metadata.rs:177`) that differ today, notably that the reset Busy carries `Retry-After` and the import Busy does not.

Out of scope: whether `wipe_dir`'s 200ms budget is the right number, which is the deferred draft; and the drain protocol and its 5s deadline, which is a separate mechanism this item does not touch.

## Not established

This was found by reading, not by reproducing. Nobody has driven a real reset into an error arm and watched the tenant answer `503` afterwards. Every claim above is a claim about what the code says it does.

What would settle it: a test or a manual run that forces one fallible arm, in decreasing order of what each proves.

- Force one `Core` arm and observe the tenant. Any subsequent workspace request returning `503` with `Retry-After: 1`, and continuing to, is the whole item.
- Confirm that no restart-free recovery exists by leaving it wedged and exercising the control socket and the reset endpoint against it.
- The concurrent-reset panic and the lock poisoning that follows are the least verified part, since the race also has to be won. If it proves hard to stage, say so rather than asserting it, and treat the six leaking exits as the finding on their own; they do not depend on it.

Also not established: whether any real deployment has hit this. There is no telemetry for it, and because the symptom is indistinguishable from ordinary contention, a report of "the workspace said it was busy and never came back" would not have been filed against the reset path.

## Rough size

Small as a change. The reinstall is a handful of lines once the helper is shared, and the shape to copy already exists, working, in a sibling route module.

Medium as a piece of work, and the cost is entirely in the acceptance. Fault-injecting `Library::reset_workspace` and `Workspace::watch` from a route test needs a seam that does not exist yet, and the choice of seam has to survive running as root in the gate's container. The status distinction is cheap. The concurrency test may be the part that gets dropped, and dropping it is acceptable if the item says it was dropped.
