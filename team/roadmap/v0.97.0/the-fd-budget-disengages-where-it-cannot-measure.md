# The descriptor budget disengages exactly where it cannot measure

Status: accepted scope for v0.97.0, raised by the owner at the v0.96.0 close after hitting the failure on FreeBSD. Implemented on `fix/freebsd-fd-budget-no-probe` (`41718877`) and verified before the item was written.

## Problem

The owner ran a devserver on FreeBSD 15 against chan's own source graph and the workspace failed to prepare:

```
Build search index failed
search error: Failed to open file for read: 'IoError { io_error:
Os { code: 24, kind: Uncategorized, message: "Too many open files" },
filepath: "meta.json" }'
```

`EMFILE` while tantivy builds the index, on the platform v0.96.0 had just started publishing.

The descriptor budget exists to prevent exactly this. It did not engage, and the reason is that it cannot engage when it cannot measure. `fd_snapshot()` on FreeBSD began with

```rust
if !dev_fd_lists_open_descriptors() { return None; }
```

and `fdescfs` is not mounted on a stock FreeBSD box, so the snapshot was always `None`. Every consumer reads `None` as no constraint: `tantivy_writer_budget` takes `worker_threads: default` and `merge_threads: 4`, the maximum; `cap_index_read_workers` and `graph_reader_pool_size` take the full request; `acquire_workspace_permit` takes `MAX_ACTIVE_WORKSPACES`; pacing falls through to `pace_no_probe`. On Linux the same code paces itself, because there the snapshot is `Some` and the `TIGHT_HEADROOM` and `MODEST_HEADROOM` branches engage as descriptors are consumed.

v0.96.0's own `f59152a6` fixed the reading and not the outcome. Its commit body says the previous state left consumers "disengaged while believing they had checked". Afterwards they were disengaged while KNOWING they had not checked. **The fix corrected the diagnosis and not the treatment**, and the early `return None` also discarded the descriptor LIMIT, which the same commit had just taught FreeBSD to read correctly.

## The trap in the obvious repair

"Make `None` conservative" is wrong as stated. `#[cfg(not(unix))] fn fd_snapshot()` also returns `None`, so `None` is the permanent state on Windows, where handles are plentiful and there is no pressure to pace against. A blanket conservative `None` would slow Windows indexing to fix a FreeBSD problem, which is a performance regression on a platform that has none.

Two states have to be distinguished: a platform with no descriptor pressure worth pacing, and a platform with a real limit that cannot currently be measured. FreeBSD without `fdescfs` was the second and was treated as the first.

## Direction, and why it is a third option

Neither "make `None` conservative" nor `KERN_PROC_FILEDESC` is the right instrument. **`KERN_PROC_NFDS` returns the current process's open descriptor count as a single `int`**, with no allocation and, decisively, without opening a descriptor.

That last property is a correctness argument rather than an efficiency one: the `/dev/fd` probe it replaces has to OPEN a directory in order to count descriptors, so it consumes one and perturbs the measurement it is taking. The sysctl does not.

Because the snapshot becomes real rather than absent, every existing consumer and every threshold stays untouched, Windows is unaffected, and the whole `dev_fd_lists_open_descriptors` probe with its `STUB_DEV_FD_ENTRIES` scaffolding is deleted. The change is 59 insertions against 42 deletions: the module gets smaller while becoming correct.

`libc` enters as a FreeBSD-only dependency (`[target.'cfg(target_os = "freebsd")'.dependencies]`) because rustix exposes `getrlimit` but no sysctl surface, and copying the ABI and constants locally would be worse than depending on the crate that maintains them.

## Boundaries

No consumer, threshold or policy changes. No non-FreeBSD dependency graph moves. Windows keeps `None` and keeps its current behaviour.

## Acceptance

1. On a stock FreeBSD box with no `fdescfs` mounted, `fd_snapshot()` returns `Some`, and indexing chan's own source graph completes rather than failing with `EMFILE`.
2. The decode path is unit-tested: a non-zero sysctl status, a short returned length, and a negative count each yield `None`.
3. `cargo check -p chan-workspace --tests --target x86_64-unknown-freebsd` is green under `-D warnings`, which is the only thing that compiles the sysctl path off FreeBSD.
4. Non-FreeBSD behaviour is unchanged, including Windows continuing to return `None`.

## Evidence

- Implemented at `41718877`: `Cargo.lock`, `crates/chan-workspace/Cargo.toml`, `crates/chan-workspace/src/fd_budget.rs`, 59 insertions and 42 deletions.
- `RUSTFLAGS="-D warnings" cargo test -p chan-workspace fd_budget`: 13 passed, 0 failed, 0 ignored.
- `RUSTFLAGS="-D warnings" cargo check -p chan-workspace --tests --target x86_64-unknown-freebsd`: rc0 in 11.17s, no warnings.
- `KERN_PROC_NFDS = 43` confirmed present in the vendored libc 0.2.178, 0.2.186 and 0.2.189 for FreeBSD before the approach was approved, rather than assumed from documentation.
- Acceptance 1 is the owner's, on the FreeBSD box that produced the original failure. Nothing in this round executes FreeBSD code.

## What made this one cheap to trust

`decode_sysctl_fd_count` is factored out of the unsafe call and gated `#[cfg(any(test, target_os = "freebsd"))]`, so the status check, the length check and the conversion are all testable on an ordinary Linux box. Only the raw `sysctl` invocation is unreachable off FreeBSD.

That is the same move as `resolve_auto` taking the OS as a `&str` parameter, and it is worth naming as a pattern: where a platform boundary is unavoidable, push the decisions out of the unreachable side until what remains there is one call with no branches. v0.96.0's FreeBSD work was expensive to trust precisely because it did the opposite.
