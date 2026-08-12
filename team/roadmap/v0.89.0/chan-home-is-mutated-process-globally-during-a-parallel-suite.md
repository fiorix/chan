# Chan home is mutated process-globally during a parallel suite, and an isolated library writes to the ambient home anyway

Status: REGISTERED 2026-08-11, carried forward from the v0.88.0 timing lane's draft of the same name, which was raised while that lane classified its own baseline sweep and was deliberately kept outside v0.88.0's locked fourteen. The owner's ruling on acceptance is that scope is the three windows named below and nothing wider: a wider contract, no test anywhere mutating process-global environment state another test reads, is explicitly **out of scope** and is argued against in "Boundaries".

## What

`std::env::set_var` mutates state shared by every thread in the process, and has been `unsafe` since Rust 1.63 for that reason. At HEAD there are **eight** `set_var("CHAN_HOME", ...)` sites:

```
crates/chan-server/src/devserver.rs:5594          FdstoreEnvGuard::capture
crates/chan-server/src/devserver.rs:5707          "sentinel-chan-home"  (relative)
crates/chan/src/test_env.rs:97                    ChanTestEnv::under_permit
crates/chan-workspace/src/paths.rs:401, 441       "/tmp/chan-home-test"
crates/chan-workspace/src/paths.rs:414            ""  (empty, treated as unset)
crates/chan-workspace/src/paths.rs:428, 461       restore-to-saved
```

Three exclusion mechanisms already exist, and naming them is what pins this item to a specific hole instead of a general complaint about shared environment:

- `crates/chan-server/src/devserver.rs:2524`, `static CHAN_HOME_ENV: std::sync::RwLock<()>`. The write side is taken only by `FdstoreEnvGuard::set` (`devserver.rs:5577`) and by the round-trip test (`devserver.rs:5695`); the read side is held for a full test body by **17** devserver tests through `chan_home_env_read()` (`devserver.rs:2534`).
- `crates/chan-workspace/src/paths.rs:382`, `static CHAN_HOME_ENV_GUARD: Mutex<()>`, whose own doc comment says it "serializes every `CHAN_HOME`-mutating test".
- `crates/chan/src/test_env.rs:50`, `ChanTestEnv`, which captures the whole `CHAN_*` namespace, points `CHAN_HOME` at a fresh temporary directory, and holds a process-wide permit for its whole lifetime (`test_env.rs:60-65`).

Both statics are declared inside their own module's `mod tests`, so no other module in the same test binary can name them even deliberately. That is the shape of the first two holes.

The eight sites span three crates and therefore three separate test binaries. Only the two `devserver.rs` sites can reach the readers that were observed failing.

## Window 1: a relative chan home is left in the process under no lock

`env_guard_round_trips_every_touched_variable` (`crates/chan-server/src/devserver.rs:5694`, inside `mod fdstore_boot` which is `#[cfg(target_os = "linux")]` at `:5557`) is the only site that ever puts a **relative** value into `CHAN_HOME`. The sequence, read at HEAD:

- `:5695` takes the write side of `CHAN_HOME_ENV`.
- `:5707` seeds `std::env::set_var("CHAN_HOME", "sentinel-chan-home")`, a relative literal.
- `:5711` hands that same lock guard to `FdstoreEnvGuard::capture`, which captures the seeded value into `prev` at `:5590` and overwrites `CHAN_HOME` with the tempdir home at `:5594`. From `:5695` to `:5719` the write lock is held continuously, so no reader can observe the sentinel here.
- `:5719` `drop(guard)` runs `FdstoreEnvGuard::drop` (`:5601-5610`), which restores `prev` and therefore puts `"sentinel-chan-home"` back. The `Drop` body runs before any field drops, and `_lock` is the first-declared field (`:5572`), so the restore genuinely happens under the lock. What the lock is then **released on** is the relative sentinel.
- `:5721` re-acquires the write side to assert that the restore happened.

Between `:5719` and `:5721` the process holds `CHAN_HOME=sentinel-chan-home` with **no lock held**, and every reader parked on `.read()` is released straight into it. On the round's rig, a 1-CPU cgroup cap with `--test-threads=32`, that gap is a scheduler quantum rather than an instruction. The tail restore at `:5739-5744` is correct by contrast: it runs with `_lock` held to the end of the function.

The consequence follows from the resolution chain, all confirmed at HEAD: `chan_home_override()` (`paths.rs:57`) returns the environment value verbatim and `config_dir()` (`paths.rs:35-38`) returns it unchanged, so a relative `CHAN_HOME` resolves against the process working directory, which for `cargo test` is the crate directory. Under the rig that directory sits on a read-only `/src` bind mount, which is where `Read-only file system (os error 30)` comes from.

Note what this is **not**: the other `FdstoreEnvGuard` users go through `set` (`:5577`), whose `prev` is captured before any seeding and therefore restores the harness's own value. The defect is one test and one relative literal, not the guard pattern.

## Window 2: the paths tests exclude each other and nobody else

`CHAN_HOME_ENV_GUARD` (`paths.rs:382`) is taken by exactly two tests, `config_dir_honors_chan_home_override` (`paths.rs:391`, lock at `:394`) and `local_bin_dir_honors_chan_home` (`paths.rs:434`, lock at `:435`). Both write `/tmp/chan-home-test`, then clear the variable (`paths.rs:419` and `:449`, `std::env::remove_var("CHAN_HOME")`), then restore. The mutex serializes those two against each other and against nothing else.

In the same test binary there are **127** `register_workspace` / `open_workspace` call sites inside the crate's own `#[cfg(test)]` modules (42 in `library.rs`, 78 in `workspace.rs`, 2 each in `fs_ops.rs`, `indexer.rs` and `workspace_search.rs`, 1 in `metadata_archive.rs`), and none of them takes any guard. They could not take this one: it is private to `paths::tests`.

What the window costs depends on the run's ambient environment, and the honest split is:

- With no ambient `CHAN_HOME`, the ordinary `cargo test` case, the `remove_var` windows change nothing, and the `/tmp/chan-home-test` windows briefly redirect concurrent readers into a fixed shared absolute path that nothing ever cleans up.
- With an isolated `CHAN_HOME` set for the run, the `remove_var` windows drop concurrent readers into the developer's real `~/.chan`, which is exactly the hazard [`tests-inherit-ambient-chan-env`](../done/tests-inherit-ambient-chan-env.md) shipped in v0.84.0 to close, and which it closed for the `chan` crate only.

**This window has never been observed.** It is derived by reading the two tests and counting the readers in their binary. Every observed failure below is in the chan-server binary.

## Window 3: an isolated library sends its metadata to the ambient chan home, and this is the root cause

This is the reason the first two windows have anything to bite.

`Library::open_at(config_path)` (`library.rs:105-138`) exists so a caller can put the registry wherever it wants; the path is stored as `inner.config_path` (`:131`) and every registry read and write goes through it (`:203`, `:238`, `:437`, `:493`). The per-workspace metadata directories do not. In `register_workspace_with_name`, two consecutive lines resolve two different ways:

```rust
paths::ensure_workspace_metadata_dirs(&entry.metadata_key)?;   // library.rs:237, ambient
reg.save_to(&self.inner.config_path)?;                         // library.rs:238, injected
```

The signature is the whole problem. `pub fn ensure_workspace_metadata_dirs(metadata_key: &str) -> std::io::Result<WorkspacePaths>` (`paths.rs:241`) takes only a key, and resolves through `workspace_paths_for_metadata_key` (`paths.rs:224`) to `workspaces_dir()` (`paths.rs:95`) to `config_dir()` (`paths.rs:35`) to `chan_home_override()` (`paths.rs:57`), which reads the process environment. There is no parameter through which a caller holding an isolated home could pass it.

The second caller is `Workspace::open` (`workspace.rs:817`), at `workspace.rs:885`, whose `map_err` at `:886` formats `ensure workspace metadata dirs: {error}`. That prefix is load-bearing evidence: `library.rs:237` uses `?`, which goes through `From<std::io::Error> for ChanError` (`error.rs:77-81`) and produces the bare `e.to_string()` with no prefix. The recorded panic carried the prefix, so the failing call was `Library::open_workspace` (`library.rs:282`) and not `register_workspace`. Both lines resolve ambiently. `library.rs:401` and `library.rs:506` resolve `workspace_paths_for_metadata_key` the same ambient way.

Both fixtures behind the observed failures have exactly this shape:

- `crates/chan-server/src/doc_sessions/mod.rs:2403-2408`: `Library::open_at(cfg.path().join("config.toml"))`, then `register_workspace(root)` at `:2407`, then `open_workspace(root)` at `:2408`. That fixture is used 60 times in the module, and `doc_sessions` holds no environment guard anywhere.
- `crates/chan-server/src/devserver.rs:3891-3892`: `test_state` opens `Library::open_at(home.join("config.toml"))` against a tempdir home. Same shape.

The codebase already knows about this gap and works around it locally rather than closing it. `library.rs:1074-1079` documents why the orphan-sweep test drives the inner `sweep_orphans_in` against a TempDir tree instead of the public `Library::sweep_orphans` (`library.rs:529`): the public wrapper supplies `paths::workspace_subsystem_dirs()` and would walk the host's real metadata root. `Library::sweep_orphans` consequently has no caller anywhere in `crates/`.

## The observed failures, and why the burst shape is the discriminator

Five occurrences across two sweeps of 30 runs at `e239c770`, recorded by the v0.88.0 timing lane:

| sweep run   | failures     | population          |
| ----------- | ------------ | ------------------- |
| baseline 9  | 46           | doc_sessions::tests |
| baseline 16 | 26           | doc_sessions::tests |
| baseline 21 | 7            | doc_sessions::tests |
| baseline 24 | not recorded | doc_sessions::tests |
| post-fix 5  | 5            | devserver::tests    |

The failure count for baseline 24 was not recorded and is not recoverable.

The burst shape rules out a deterministic misresolution. If `dirs::home_dir()` returned `None` and `config_dir()` fell through to the relative `.chan` at `paths.rs:47`, every `register_workspace` in every run would fail. Forty-six, then twenty-six, then seven, then nothing for most runs is a window signature. That is also the cleanest discriminator against the sibling item [`chan-home-collapses-to-the-working-directory`](chan-home-collapses-to-the-working-directory.md), which is about precisely that deterministic fallback.

The post-fix five are the sharpest part of the evidence. They are `devserver.rs:4122`, `:4202`, `:4265`, `:4292` and `:4331`, each a `register_workspace` call a few lines below its own `chan_home_env_read()` at `:4114`, `:4183`, `:4260`, `:4280` and `:4325`. That is one call per failing test rather than every guarded call site: the test holding `:4183` registers a second workspace at `:4207` under the same read guard, and the `:4202` call is the one whose statement ends in the `.unwrap()` at `:4203`. **All five hold the read guard.** They therefore cannot be seeing the `:5695` to `:5719` span, which is write-locked throughout. They can see `:5719` to `:5721`. Tests that took the guard and lost anyway are much stronger evidence of a specific hole than tests that never took it, and the module that loses is the one that contains the mutation.

## Severity, stated honestly

This is a production design gap and not only a test defect. `ensure_workspace_metadata_dirs` has no home parameter, so on any host where the suite runs without an isolated `CHAN_HOME`, chan test metadata lands in the developer's real `~/.chan/workspaces/`, keyed by the canonical path of each throwaway workspace root and orphaned there the moment the temporary registry is dropped.

**This was not observed on the owner's host.** `~/.chan/workspaces/` holds seven entries, all genuine: six real checkouts and one `/tmp/chan-overlay-demo-ws2`. There are no tempdir-derived keys, and no `sentinel-chan-home` directory exists anywhere in the checkout. The explanation is that this project builds and tests inside containers, where the ambient home is the container's and is discarded with it. It is not that the code is safe. A bare-host `cargo test -p chan-workspace` gets the writes.

That makes this a recurrence of the shipped [`tests-inherit-ambient-chan-env`](../done/tests-inherit-ambient-chan-env.md), whose answer, `ChanTestEnv`, reached the `chan` crate and never reached chan-server or chan-workspace.

## Contract

- The env-guard round-trip test never leaves a relative `CHAN_HOME` in the process, and never releases the write side of `CHAN_HOME_ENV` on a value it seeded. Its restore and its verification happen under one continuous lock hold.
- Every reader in the chan-server lib test binary that resolves `config_dir()` can exclude every writer of it, which means `CHAN_HOME_ENV` is reachable from `doc_sessions` and not only from `devserver::tests`.
- A `Library` opened at an injected config path resolves its per-workspace metadata under that same home, reading no process environment to do it. Whichever form that takes, a home carried on `LibraryInner` beside `config_path` or a home threaded into `ensure_workspace_metadata_dirs` and `workspace_paths_for_metadata_key`, it is a parameter and not an environment read.
- The replacement is demonstrated deterministically, not by a clean parallel sweep. A save/restore pattern passes a sequential test and says nothing about any of this.

Note the ordering effect: once the third bullet lands, most readers in both binaries stop consulting `CHAN_HOME` at all, and Window 2 largely retires itself.

## Boundaries, and what is deliberately out of scope

In scope: `crates/chan-server/src/devserver.rs` (the `fdstore_boot` test module and the `CHAN_HOME_ENV` static), `crates/chan-workspace/src/paths.rs`, `crates/chan-workspace/src/library.rs`, `crates/chan-workspace/src/workspace.rs`. `crates/chan/src/test_env.rs` is not touched: it is the shipped answer for its crate and is the model here, not the defect.

Out of scope, explicitly: a wider contract that no test anywhere mutates process-global environment state another test reads. The evidence names three windows and one missing parameter. Generalizing to every environment variable across three crates implies threading injected configuration through `config_dir()` and all of its delegators, which is a release-sized project that nothing observed requires. A fourth window, if one turns up, gets its own item.

Also out of scope: any `~/.chan` orphans an earlier bare-host run may already have left. Removing those is a user action, not a code change.

Shared lane: [`chan-home-collapses-to-the-working-directory`](chan-home-collapses-to-the-working-directory.md) also edits `crates/chan-workspace/src/paths.rs`, so the two want sequencing rather than parallel editing. They are two defects, by the test of whether fixing either leaves the other live: make the production fallback absolute and a concurrent reader is still handed another test's `CHAN_HOME`; close every window here and a production process whose `dirs::home_dir()` returns `None` still writes `.chan` into its working directory. They should be judged together, because a reader who fixes one and watches the symptom disappear under light load will reasonably believe both are closed.

## Acceptance

A statistical bound, a run count large enough to have caught the observed rate, is not an acceptance check here: the observed rate was five events in sixty runs, and a clean sweep at that rate is weak evidence.

1. **Deterministic, and it is the primary check.** Run the chan-server lib suite with `CHAN_HOME` set process-wide to a relative value, from a working directory that is itself read-only, which is what the rig's `/src` bind mount gives. That read-only working directory is a precondition of the check, not incidental: on an ordinary writable checkout the relative home is simply created under the crate directory, the writes succeed, and the check proves nothing. On the current tree this is **predicted** to reproduce the mass failure at `workspace.rs:886` with no scheduling luck required; it has not been run, because the host that registered this item has no Rust toolchain. Showing it red before the repair is therefore part of the check. With the repair in, every fixture that registers or opens a workspace passes, because the metadata resolves from the injected home.
2. A chan-workspace unit test asserting that a `Library::open_at(tmp/config.toml)` which registers a workspace creates the metadata skeleton under `tmp/workspaces/<key>` and creates nothing under `config_dir()`. It must be shown red on the current tree before the repair.
3. A structural check that every remaining `set_var("CHAN_HOME", ...)` site in `crates/` either holds an exclusive lock across its entire window, including its restore, or belongs to `ChanTestEnv`.
4. Corroboration only, not proof: the chan-server lib suite under a 1-CPU cgroup cap with `--test-threads=32`, with zero EROFS-class failures at chan-path resolution.

## Not established

- Whether Window 2 has ever fired. It is read off the code and the reader count in its binary; no failure has been attributed to it.
- Whether any chan-workspace test has ever written into a real `~/.chan` on a bare host. Not seen here, and the container build path is why this project would not have seen it.
- Whether the five `devserver::tests` failures are the `:5719` to `:5721` gap specifically rather than some other unguarded moment. That gap is the only unlocked window any of these tests opens on a relative value, and the guarded population narrows it to that, but nobody has instrumented a run to catch a reader inside it. The originating lane recorded the mechanism as an unproven hypothesis at the time, and this item does not upgrade it.

## Tail: three comments this item's contract made false, 2026-08-11

Folded in as a small fix rather than registered as its own item. It is three comment lines with no behaviour change, and it is the natural tail of the sidecar work `6ddd34cc` did here: those comments describe where per-workspace state lives, and this item is what settled that.

The owner asked whether chan still creates a `.chan` directory at the **workspace root**. It does not, and nothing does. `workspace_paths_for_metadata_key_in` builds `chan_home.join("workspaces").join(metadata_key)` and every subdirectory hangs off that root, `sessions` included. The only production `join(".chan")` in the tree is `home.map(|p| p.join(".chan"))` in `paths.rs`, which is the chan home itself. The two places that create `<workspace>/.chan` are **test fixtures asserting the opposite**: they build one so that `list()` and `list_tree()` can be shown to hide it. The production exclusion is worth keeping, since an older version or a user could leave one behind.

Three comments in `crates/chan-library/src/host.rs` state that the durable workspace session blob lives at `<workspace>/.chan/sessions/<id>`, a path that does not exist and never did in this shape. Two of them sit on `reap_discarded_window_state`, which is exactly where a reader goes to understand the discard cleanup path, so the wrong location is in the place most likely to be trusted; the third states it as the thing a test is proving.

The correct resolution is `<chan_home>/workspaces/<metadata_key>/sessions/<id>`.

**The trap in writing the replacement**, which is why this is recorded here rather than left as an obvious edit: do not write it as `~/.chan/workspaces/...`. That would substitute a subtler inaccuracy for a plain one. This item's own work made the home injectable, `6ddd34cc` placed library sidecars under `config_path.parent()`, and `CHAN_HOME` overrides the default besides. The comment must name the library's chan home as a resolved thing rather than pin one instance of it.

A **fourth mention, of lesser severity and deliberately not bundled**: `host.rs` also describes chan-desktop's config as `~/.chan/desktop`. That resolves through `chan_workspace::paths::config_dir().join("desktop")`, so it is the same injectable path, and the comment names its default instance rather than a location that does not exist. That is imprecision rather than falsehood, and the desktop crate's own doc block states the relationship correctly. Recorded so the next reader does not treat the two as the same defect, and left to the implementer's judgement.

Nothing here is a live defect and no user is affected. The cost is a reader's time and their confidence in the surrounding doc block: someone debugging an orphaned session blob would search the workspace root, find nothing, and have no reason to suspect the comment rather than their own understanding.

## Rough size

Small to medium. Two of the three windows need no design round: absolutize the sentinel at `devserver.rs:5707` and make the restore and the verification one continuous lock hold, then hoist `CHAN_HOME_ENV` (`devserver.rs:2524`) somewhere `doc_sessions` can reach it. The real work is Window 3, which is one home added to two functions in `paths.rs` and threaded through four call sites in `library.rs` and `workspace.rs`.

The one design choice that matters is where that home lives. Carrying it on `LibraryInner` beside `config_path` leaves all 127 `register_workspace` / `open_workspace` call sites in the chan-workspace test binary untouched; making it a parameter on the public workspace API does not. The cheaper shape exists, so this is not a design round. What keeps it out of "small" is re-running the 1-CPU rig and writing acceptance check 2 against four ambient resolution sites rather than one.

## Provenance

Registered by the v0.88.0 timing lane while classifying failures in its own baseline sweep, where 48 failures in a single run resolved to one shared condition rather than 48 races. Kept out of that lane's repairs deliberately, since `devserver.rs` and `chan-workspace/src/paths.rs` belonged to other lanes and v0.88.0's scope was locked.

The same lane's repair of `crates/chan-server/src/control_socket.rs` needed a test seam and used a thread-local hook (`control_socket.rs:749`, with the reasoning at `:759-762` citing the shared-mutable-state hazard that makes `std::env::set_var` unsafe) specifically to avoid adding a ninth instance of this defect while registering it. The closed item [`control-socket-takeover-test-races-a-fixed-sleep`](../done/control-socket-takeover-test-races-a-fixed-sleep.md) records the same reasoning.
