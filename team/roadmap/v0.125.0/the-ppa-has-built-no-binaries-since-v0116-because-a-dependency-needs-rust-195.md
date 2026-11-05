# The PPA has built no binaries since v0.116.0 because a dependency needs Rust 1.95

Status: accepted by the owner on 2026-11-05 at the v0.124.0 close; not started.

## What was found

The v0.124.0 read-back found every Launchpad build of `chan` and `chan-desktop` `0.124.0-1` failed: noble and resolute, amd64 and arm64, eight of eight. Each stops compiling `sysinfo` 0.40.0 with `error[E0658]: use of unstable library feature cfg_select`. The builds of v0.120.1 to v0.124.0 all failed, and the PPA's newest published binaries are 0.116.0's. `sysinfo` arrived in v0.117.0 (`00b4679e6`), so Ubuntu users of the PPA have had no update since v0.116.0.

## What is there now

- Launchpad builds offline from the vendored source package with the archive's Rust: `rustc-1.91` (1.91.1) on noble and `rustc-1.93` (1.93.1) on resolute. `debian/control` accepts `rustc-1.95 | rustc-1.93 | rustc-1.91 | rustc (>= 1.91)`, and `debian/rules` picks the newest installed `rustc-1.*` and builds with `--ignore-rust-version`, so the workspace's rust-version of 1.95 is not what decides the build; each dependency's own Rust needs are.
- `sysinfo` 0.39.0 and later declare rust-version 1.95; 0.38.4 declares 1.88. The workspace takes `sysinfo = { version = "0.40", ... }`, and its one use is `process_foreground_from_table` in `crates/chan-library/src/terminal_sessions/tmux_gate.rs`, compiled on macOS, FreeBSD and Linux tests.
- A host check after the tag, on v0.124.0 with `sysinfo` 0.38.4 (only that lock entry changed) and `let mut system = System::new();` in place of the `let Ok(..) else` (0.38 returns `System`, not `Result`): `cargo check -p chan` and `-p chan-desktop` passed with rustc 1.91.1 and 1.93.1, `cargo build --release` of both passed with 1.91.1, and `cargo check -p chan-library --tests` passed with no warnings on both. Nothing else in either Linux graph declares a Rust above 1.91; smoltcp 0.14.0 declares exactly 1.91. Not run: the vendored `--frozen` build, a noble or resolute chroot, release builds with 1.93.1, and the macOS and FreeBSD compiles of the edited function.
- `cargo update -p sysinfo --precise 0.38.4` also moved `cssparser-macros` from syn 2 to syn 3; the check above kept the lockfile otherwise unchanged.
- `publish-downstream`'s `launchpad` job passes once Launchpad accepts the source upload. Nothing in the release reads the binary builds, which finish 30 to 60 minutes later, and the records of v0.117.0 to v0.123.0 counted the PPA from accepted uploads or published sources.

## Desired contract

- The PPA builds both packages for every series it targets, from the tagged source, with the Rust those series ship.
- A dependency that needs a newer Rust than the PPA's builders fails a check before a tag, not on Launchpad after it.
- The release reads Launchpad's binary builds before its record calls the PPA published.

## Acceptance

1. With the change, `chan` and `chan-desktop` build from the vendored source package in a noble chroot with `rustc-1.91` and in a resolute chroot with `rustc-1.93`, both arches or the arch the chroot gives, and the tmux foreground test passes on Linux.
2. A check run by the gate or CI fails when a dependency's rust-version exceeds the oldest builder Rust, shown red by reverting the pin and green with it.
3. The next release's Launchpad builds succeed, and its record reads them from Launchpad's API.
