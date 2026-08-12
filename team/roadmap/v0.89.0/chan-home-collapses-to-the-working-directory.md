# The chan home collapses to the working directory when `home_dir()` returns None, and the test that names the hazard cannot detect it

Status: REGISTERED 2026-08-11, carried forward from [audit-the-workarounds-nobody-followed-up](../done/audit-the-workarounds-nobody-followed-up.md), which shipped in [v0.88.0](../../release/release-v0.88.0.md) and registered this as its finding F7 rather than repairing it. That item's own header says it is "explicitly not over the fallback-on-failure axis those signatures cannot see, which is registered separately rather than claimed"; this is that separate registration. **The owner has ruled: a defined absolute fallback, not a refusal.** An absent home resolves to a named absolute path, and the repair adds a `config_dir_with_home(Option<PathBuf>)` style test seam. That ruling confines the whole change to `crates/chan-workspace/src/paths.rs`. The reasoning, including the count that decided it, is in "The ruling" below.

## What

`chan_workspace::paths::config_dir()` (`crates/chan-workspace/src/paths.rs:35`) is documented at `paths.rs:33-34` as:

> This is the SINGLE authority for the chan home; nothing else resolves `~/.chan` independently.

Its non-override, non-mobile arm ends at `paths.rs:45-47`:

```rust
dirs::home_dir()
    .map(|p| p.join(".chan"))
    .unwrap_or_else(|| PathBuf::from(".chan"))
```

`PathBuf::from(".chan")` is relative, so when `home_dir()` returns `None` the chan home resolves against whatever directory the process happens to be running in, and with it the workspace registry, the devserver state, the global config and every workspace's metadata.

The "single authority" claim is not taken on trust here, because it is what makes the fallback total rather than local. A repo-wide grep for `.join(".chan")` over `crates` and `desktop` returns three hits and only one resolver: `paths.rs:46`. The other two, `crates/chan-workspace/src/workspace.rs:7613` and `crates/chan-workspace/src/fs_ops.rs:2172`, are `create_dir_all` calls inside tests. So the four delegators inherit the relative path with no second opinion available: `state_dir` (`paths.rs:79-81`), `cache_dir` (`:85-87`), `global_config_path` (`:90-92`) and `workspaces_dir` (`:95-97`) are each a one-line call to `config_dir()`.

There is no absoluteness guard anywhere on this path. `is_absolute` appears ten times across `crates` and `desktop`, exactly one of them in chan-workspace (`crates/chan-workspace/src/fs_ops.rs:314`, an unrelated symlink-target check).

## The test that names the hazard cannot see it

The hazard is written down twice in this file, in prose, and neither sentence has a test behind it.

`chan_home_override`'s docstring (`paths.rs:55-56`) says an empty value is treated as unset "so `CHAN_HOME=` does not collapse the home to the cwd", and `config_dir_honors_chan_home_override` (`paths.rs:391`) repeats it as a comment at `paths.rs:413` above its two assertions at `paths.rs:415-416`:

```rust
// Empty is treated as unset: the home-based default, NOT the cwd.
std::env::set_var("CHAN_HOME", "");
assert_ne!(config_dir(), PathBuf::from(""));
assert!(config_dir().ends_with(".chan"));
```

**The assertions cannot distinguish an absolute path from a relative one.** `PathBuf::from(".chan")` is not `PathBuf::from("")`, and `Path::new(".chan").ends_with(".chan")` is true, so both hold under the cwd collapse as readily as under `~/.chan`.

To be precise about what that does and does not prove: those assertions do fire against the regression the docstring at `paths.rs:55-56` actually guards: delete the `.filter(|v| !v.is_empty())` at `paths.rs:59` and `CHAN_HOME=""` makes `config_dir()` return `PathBuf::from("")`, failing both lines. The test is not vacuous. What it cannot see is the different route into the same collapse, through the `home_dir() == None` arm, which it never exercises and which its assertions would not catch if it did.

So the answer to "what test fails if the sentence is false" is none, for the `home_dir()` arm specifically, and it is none in the strong sense: no test anywhere constructs `home_dir() == None`. There is no in-process `set_var("HOME", ...)` or `remove_var("HOME")` in the tree. The only `HOME` manipulation is `.env("HOME", ...)` on spawned child processes (`crates/chan/tests/open_close.rs:84`, `crates/chan/tests/devserver_resilience.rs:79`, `crates/chan/tests/revtunnel_e2e.rs:95`, `crates/chan-library/src/terminal_sessions.rs:3012`), which sets a home rather than removing one and is out of process anyway.

The neighbouring test makes the gap explicit rather than accidental. `local_bin_dir_honors_chan_home` (`paths.rs:434`) writes `local_bin_dir().expect("home resolves on the test host")` at `paths.rs:450`. The suite has decided, in a string, that the absent-home case does not occur.

## What the evidence supports, and what it does not

`git log v0.87.0..HEAD -- crates/chan-workspace/src/paths.rs` returns zero commits, so nothing in v0.88.0 touched this.

The severity claim is bounded deliberately. This arm is **latent, not observed**. chan-workspace resolves `dirs` 5.0.1 (workspace dependency `dirs = "5"` at `Cargo.toml:78`, pinned in `Cargo.lock`), whose Unix home resolution consults `$HOME` and then the passwd database before giving up; that crate's source is not vendored on this host and was not re-read, so treat it as the reason no production occurrence has been demonstrated rather than as proof the arm is unreachable.

In particular, the loud read-only-bind-mount failures that made a relative chan home visible in the v0.88.0 round belong to the sibling item, not to this one. Those traced to a test setting a **relative `CHAN_HOME`** process-wide, which is a different route to the identical symptom. This item does not borrow that evidence.

What survives without it: the fallback exists, it is relative, it is the single authority for the chan home, it is unguarded, and it is untested. On a writable checkout its firing is silent by construction, so nothing in the suite would report it in either world.

## The ruling, and why refusal was declined

The question is refusal or a defined absolute fallback, and the size of the item swings entirely on it. The ruling: **a defined absolute fallback**. `config_dir()` keeps its `-> PathBuf` signature; the `home_dir() == None` arm resolves to a named absolute path instead of `.chan`, and that path is written into the docstring so the next reader does not have to derive it.

Refusal was the alternative, meaning `config_dir() -> Result<PathBuf, _>`. It was declined on cost, and the cost was counted rather than estimated. `grep -rn "config_dir()" --include=*.rs crates desktop` returns 31 lines, 10 of them in `paths.rs` itself. Dropping the definition at `paths.rs:35`, three comment and docstring lines that merely mention the function (`crates/chan-server/src/devserver.rs:2521`, `crates/chan-server/src/devserver.rs:5569`, `crates/chan-server/src/lib.rs:1013`), the five calls inside this file's own test module (`paths.rs:402`, `:415`, `:416`, `:421`, `:423`) and the four in-file delegators leaves **18 direct call sites outside `paths.rs`**: 10 in chan-server, 5 in chan, 3 in `desktop/src-tauri`, 0 elsewhere in chan-workspace. Repeating the count for each delegator, since a fallible `config_dir` makes all four fallible too, adds `global_config_path`'s four external callers (`crates/chan-workspace/src/library.rs:100`, `crates/chan-workspace/src/registry.rs:248`, `crates/chan-workspace/src/registry.rs:272`, `desktop/src-tauri/src/registry.rs:33`); `state_dir`, `cache_dir` and `workspaces_dir` have no callers outside `paths.rs` at all.

So refusal is **22 external call sites across three crates and the desktop shell**, plus the 4 in-file delegators, for 26 sites that change shape. The fallback ruling touches none of them.

The trade being accepted with that: a defined absolute fallback still relocates state silently, it just relocates it somewhere fixed and findable instead of somewhere that follows the working directory. That is a smaller correctness win than refusal and it is the one being bought, at one file instead of four.

## The seam is the point

The seam is not scaffolding for the fallback; it is the larger half of the item's value, and three things depend on it that the fallback alone does not deliver.

First, it makes the `home_dir() == None` arm **reachable from a test at all**. That the arm is unconstructible today is this item's entire evidence section. Without the seam the acceptance below cannot be written, in any form, and the item would ship with the same "no test fails if this is false" property it was registered to remove.

Second, it removes the reason tests reach for a process-global env var. At HEAD there are eight `std::env::set_var("CHAN_HOME", ...)` lines in the tree and **five of them are in this file's own test module** (`paths.rs:401`, `:414`, `:428`, `:441`, `:461`); the other three are `crates/chan-server/src/devserver.rs:5594`, `crates/chan-server/src/devserver.rs:5707` and `crates/chan/src/test_env.rs:97`. A seam that takes the resolved inputs rather than reading them lets those five become direct calls with no env mutation, which is the majority of the sites the sibling item has to settle. The exact reduction depends on whether the seam carries the `CHAN_HOME` override as well as the home, since `chan_home_override` (`paths.rs:57-61`) is the actual env read; a seam that takes only the home retires fewer.

Third, it is the shape the deferred descriptor-probe work will need: an environment probe returning `Option`, every consumer taking the absent arm, and no test able to construct it. Same problem, same repair.

The precedent is one file away and it is real, but it stops short of the `None` arm. `crates/chan-workspace/src/vcs.rs:66` has `detect_parent_vcs(path)` delegating to `detect_parent_vcs_with_home(path, dirs::home_dir())`, and the pair's signature at `vcs.rs:94` is `(path: &Path, home: Option<PathBuf>)`. Its own docstring at `vcs.rs:91-93` states the purpose as an explicit override "so tests can workspace the `$HOME` stop without touching the developer's real home directory", which is a **substitutable** home, not an absent one. All twelve test call sites (`vcs.rs:221`, `:230`, `:243`, `:253`, `:296`, `:307`, `:322`, `:336`, `:349`, `:369`, `:385`, `:407`) pass `temp_parent_home(&tmp)` or `Some(fake_home)`; none passes `None`. So the injection pattern has a working precedent in the same crate and the `None`-coverage it enables does not. That is still the right precedent to copy, and copying it here is the first time the `None` arm gets used.

## Two defects, one symptom, one lane

This item and `chan-home-is-mutated-process-globally-during-a-parallel-suite` meet at the symptom (a relative chan home resolving against the cwd) and are different defects with different fixes. This one is a **production** fallback that is relative where it must be absolute. That one is **test** code mutating a process-global that production reads.

Their own separation test holds when checked independently: make the fallback absolute and a concurrent test still hands 31 sibling threads another test's `CHAN_HOME`; delete every `set_var` and a production process whose `home_dir()` returns `None` still writes `.chan` into its working directory.

They are nonetheless **one lane**, because both edit `crates/chan-workspace/src/paths.rs` and five of the eight `set_var` sites are in that file's test module. Scheduling them to separate owners buys nothing and costs a merge. Sequence the seam first: it is what lets the sibling delete most of its sites rather than rewrite them.

## Contract

- The chan home is an absolute path on every target this repository builds. It never resolves against the process working directory.
- When `home_dir()` returns `None`, `config_dir()` returns a **named** absolute path, and that path is recorded in the function's own documentation rather than inferred from the code.
- The absent-home case is constructible from a test without mutating process-global state.

The contract is scoped to the `home_dir()` arm on purpose. A relative `CHAN_HOME` is a second, live route to the identical collapse, `chan_home_override` (`paths.rs:57-61`) performs no absoluteness check, and one relative value is set in-tree today at `crates/chan-server/src/devserver.rs:5707` (`"sentinel-chan-home"`, in a test, process-wide). That route is named here so it is not lost, and it belongs to the sibling item. It is the same file and the same seam, so a repair that closes both is welcome; a repair that closes only this one is complete against this contract.

## Implementation boundaries

- **May touch:** `crates/chan-workspace/src/paths.rs` only. The fallback expression at `paths.rs:45-47`, the new `config_dir_with_home(Option<PathBuf>)` seam with `config_dir()` reduced to `config_dir_with_home(dirs::home_dir())`, `config_dir`'s docstring at `paths.rs:23-34`, and the test module from `paths.rs:375` down.
- **Must not touch:** any of the 22 external call sites counted above. The public signature `config_dir() -> PathBuf` is unchanged under this ruling, and a diff that reaches another crate means the refusal branch was taken by accident.
- **Out of scope:** making `config_dir` or any delegator fallible; adding an absoluteness check to `chan_home_override`; deleting the three `set_var("CHAN_HOME", ...)` sites outside this file, which are the sibling item's.
- **Leave alone, and do not assume correct:** the iOS/Android arm at `paths.rs:39-42`, which returns `state_dir()`, which at `paths.rs:79-81` returns `config_dir()`. No target in this repository builds those platforms and this item did not examine that arm; it is noted only because the repair edits the function containing it.

## Acceptance

- A test calls the seam with `None` and asserts the result is absolute and equals the named path. This test cannot be written at HEAD in any form, which is the item's evidence; that it now compiles is half the acceptance.
- `config_dir_honors_chan_home_override`'s empty-value assertions at `paths.rs:415-416` are replaced by ones that distinguish an absolute home-based default from a relative path, so the test can fail in the direction its own comment at `paths.rs:413` describes.
- Both new assertions are demonstrated able to go red: restore `PathBuf::from(".chan")` as the fallback and they fail. A green run against unchanged production code proves nothing here, since that is the state at HEAD.
- The named fallback path appears in `config_dir`'s docstring.
- `git diff --stat` for the repair lists one production file.

## Rough size

Small, and the ruling is what makes it small: one file, one new function, one changed expression, and two strengthened assertions. The refusal branch would have been 22 external call sites across chan-workspace, chan-server, chan and `desktop/src-tauri` plus 4 in-file delegators.

The seam is the larger half of the work and the part worth reviewing, both because it is what the acceptance rests on and because the sibling item in this lane consumes it.
