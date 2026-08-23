# `chan devserver` has no default service backend on FreeBSD

Status: accepted scope for v0.97.0, raised by the owner at the v0.96.0 close. Implemented at `f12501f6`, with acceptance 4 run on a real FreeBSD box.

## Problem

v0.96.0 publishes FreeBSD, and on FreeBSD `chan devserver start` does not start anything. It errors.

`--service` defaults to `auto`, and `resolve_auto` in `crates/chan/src/lib.rs` maps the runtime OS string to a backend:

```rust
match os {
    "windows" => Ok(ServiceKind::Chan),
    "linux"   => Ok(ServiceKind::Systemd),
    "macos"   => Ok(ServiceKind::Launchd),
    other => Err(format!(
        "could not auto-detect a service backend for this OS (\"{other}\"); \
         use --service=chan for the portable background daemon"
    )),
}
```

FreeBSD is `other`. So every management verb, `start`, `stop`, `join` and `status`, fails on a freshly installed chan until the user discovers `--service=chan` from the error text. A bare `chan devserver` with no verb still works, because with no action the resolver returns `None` and runs in the foreground on every host.

The refusal is honest and it points at the right flag, which is why this is a papercut rather than a defect. But chan now ships a FreeBSD binary through `install.sh`, and the first thing a user does with a devserver is start it.

## Desired contract

On FreeBSD, `--service=auto` under a management verb resolves to `ServiceKind::Chan`, chan's own cross-OS self-managed daemon (pidfile plus flock), exactly as it already does on Windows. `start`, `stop`, `join` and `status` then work with no flag.

Nothing else changes: `--service=chan` stays valid and explicit everywhere, the foreground `run` path is untouched, and Linux and macOS keep their OS supervisors.

## Why this is the right backend rather than an rc.d integration

`ServiceKind::Chan` is the portable backend that exists precisely for hosts with no supported OS supervisor, and it is already the Windows default, so FreeBSD inherits a path that ships and is exercised. Writing an `rc.d` script would be the native-feeling answer and is a much larger change: a new supervisor backend, its own generator, its own uninstall story, and root privileges chan does not otherwise require. If FreeBSD should eventually get a first-class `rc.d` backend that is its own item; this one makes the published binary work out of the box.

## Boundaries

One arm in `resolve_auto`, its test matrix, and the prose that describes it. No new backend, no new file, no change to `plan_devserver`'s `(backend, action)` validation matrix, and no privileged operation.

## Acceptance

1. `resolve_auto("freebsd", true)` returns `ServiceKind::Chan`; `resolve_auto("freebsd", false)` still returns `ServiceKind::None`. Both pinned in `resolve_auto_matrix`.
2. An unrecognized OS still errors with the message pointing at `--service=chan`; adding FreeBSD must not turn the fallback into a silent default for every unknown platform.
3. `crates/chan/src/help.rs` stops saying the per-OS resolution is "systemd on Linux, launchd on macOS, and chan's own daemon on Windows" and names FreeBSD. `docs/**` likewise wherever the backend table appears.
4. On a real FreeBSD box, `chan devserver start` then `status` then `stop` with no `--service` flag.

## The property that makes this unusually cheap to verify

`resolve_auto` takes the OS as a `&str` parameter rather than reading `std::env::consts::OS` internally, and its doc comment says why: "Pure + total so the whole matrix is unit-tested without a real OS." `resolve_auto_matrix` already asserts `linux`, `macos` and `plan9` cases.

So unlike every other FreeBSD change in v0.96.0, which lived in `#[cfg(target_os = "freebsd")]` blocks that no machine in that round could compile or execute, **this one is fully testable on the round's own Linux box.** Acceptance 1 and 2 are ordinary unit tests. Only acceptance 4 needs a FreeBSD host, and it is a confirmation rather than the proof.

That difference is worth stating in the round's report: the v0.96.0 FreeBSD work was expensive to trust because it was unreachable, and this change is cheap to trust because someone made the resolver pure.

## Evidence

- Implemented at `f12501f6`: `crates/chan/src/lib.rs`, `crates/chan/src/help.rs`, `design.md`.
- The refusal was reproduced first, on FreeBSD 15.0-RELEASE arm64: `status`, `start`, `stop` and `join` each failed with `could not auto-detect a service backend for this OS ("freebsd"); use --service=chan for the portable background daemon`. All four verbs, not the one the item quoted.
- The backend was confirmed to work under an explicit `--service=chan` on that box before it was made the default, so the arm points at a path that runs there rather than one assumed to: `start` emitted the `CHAN_DEVSERVER_TOKEN=` marker and a pid, `status` reported the pid, bind and log path, `stop` stopped it, and no `__devserver-daemon` process survived.
- Acceptance 4, on the same box with no `--service` flag: `status` reports not running, `start` emits the token marker and a pid, `status` reports it running with `command: chan devserver start --service=chan`, `stop` stops it, and `status` reports not running again.
- Acceptances 1 and 2 are pinned in `resolve_auto_matrix`, green under `RUSTFLAGS="-D warnings"` on macOS under the pinned 1.95.0 and natively on FreeBSD. Acceptance 2 is asserted rather than assumed: `openbsd`, `netbsd`, `dragonfly`, `illumos` and `android` are each checked to still error, so naming FreeBSD cannot widen into a default for every unrecognized OS.
- Acceptance 3: `crates/chan/src/help.rs` and `design.md` name FreeBSD. A sweep for the backend prose found no other copy of the per-OS table under `docs/`.
