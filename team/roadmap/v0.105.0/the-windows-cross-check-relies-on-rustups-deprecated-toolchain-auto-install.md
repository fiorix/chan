# The Windows cross-check relies on rustup's deprecated toolchain auto-install

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

`scripts/windows-cross-check.sh` installs rustup in its guest with no toolchain (`curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none`, line 159 in the released tree `af2af8ac0`), then runs `rustup target add x86_64-pc-windows-gnu` (line 161) and three cargo commands (lines 163 to 170). No line installs the toolchain that `rust-toolchain.toml` pins (channel `1.95.0`, components `rustfmt` and `clippy`, profile `minimal`).

In the real attempt at the candidate `c7178af66c08a0ca9eeb7ac92cb2f1320a06ac47` (2026-10-08, 21:27:39Z to 21:44:37Z, `make_rc=0`) the guest's log reads `info: skipping toolchain installation` at line 633 and these five lines at 669 to 673 (`dev/v0104-team/evidence/Lead104/windows-cross/c7178af66c08a0ca9eeb7ac92cb2f1320a06ac47/build.log`, 2,703 lines):

```text
warn: the missing active toolchain `1.95.0-x86_64-unknown-linux-gnu` has been auto-installed
warn: auto-installation is deprecated for most `rustup` commands
warn: scripts relying on this behavior in `rustup` may stop working in the future
warn: to install the active toolchain, use `rustup install` instead
warn: see <https://github.com/rust-lang/rustup/issues/4836> for more info
```

The same five lines stand at the same line numbers in the log of the run at the GA commit `af2af8ac0136705a7d2933b9dbc5c51c535d76b0` (2026-10-09, 05:39:11Z to 05:56:07Z, `make_rc=0`; the directory of that name beside the first). Both runs were on Linux, in an Ubuntu sdme guest, compiling for `x86_64-pc-windows-gnu`, and both passed; the candidate's guest ran at 2 CPUs, 6 GiB and 44 GiB. The lead's candidate report records it as "One follow-up, not a finding: rustup warns that auto-installing the toolchain is deprecated and the driver relies on it" (`dev/v0104-team/reports/candidate-report-Lead104.md`, "Windows cross-check result and seat changes"), and the [v0.104.0 report](../../release/release-v0.104.0.md) carries it under Follow-ups ("replace the Windows driver's reliance on rustup toolchain auto-installation").

The same reliance is written down in other places of the released tree. They were read at source and none was run for this item: `.agents/README.md` line 38 ("`cargo` auto-installs through rustup on first use, so contributor and CI clippy lint sets stay locked together"); the comment at lines 111 and 112 of `packaging/sdme/build-chan-desktop.sh`; a comment in each of the three desktop rootfs templates, `packaging/sdme/chan-desktop-ubuntu.sdme` (line 14), `chan-desktop-fedora.sdme` (line 18) and `chan-desktop-arch.sdme` (line 21); and `packaging/gateway/scripts/dev/sdme/gateway-build.sdme` (line 39). CI is a different path: the comment in `rust-toolchain.toml` says CI's `actions-rust-lang/setup-rust-toolchain` reads that file.

Not established: which command drew the warning. The log does not name it; by the driver's order the first rustup command after the installer is `rustup target add`, and that is a reading of the order and not a line of the log. The rustup version in the guest: a search of the log for `rustup` finds only the warning lines. When the behaviour ends and for which commands: the warning says "most `rustup` commands" and "may stop working in the future", and the issue it links was not read. Whether a bare `cargo` call draws the same warning, which is what the other places rely on. Whether any of those other places has printed it: none was run in the round by the records read here.

## Desired contract

The Windows cross-check installs the toolchain that `rust-toolchain.toml` pins by an explicit command before its first use, so a rustup that no longer auto-installs can neither turn the check red nor leave it compiling with another toolchain. Whether the other places that state the same reliance are repaired with it is a decision this item asks for: the driver alone, which is what the record raised, or every place named above.

## What to do

Read the linked rustup issue and the version of rustup the guest installs, to learn which commands lose auto-installation and when. Reproduce the warning in a guest with a constructed checkout and say which command draws it. Try the candidates for an explicit install there (a toolchain install run inside the checkout, or one given the channel read from the file) and record which of them installs the pinned channel with its components and the Windows target. Put the scope to the lead with that evidence before a second file is changed.

## Boundaries

`scripts/windows-cross-check.sh` and `scripts/test-windows-cross-check.sh`. The pinned channel stays in `rust-toolchain.toml` alone: the driver gains no second copy of the version. The driver's compilation selections, warning policy, limits and status handling are unchanged. The other places named above are outside the boundary unless the decision takes them in.

## Acceptance

1. The driver's guest payload installs the pinned toolchain by an explicit command before `rustup target add`; pinned in the driver's constructed test, red first.
2. A real `make windows-cross-check` at a clean committed tree passes, and its log holds no line saying that a toolchain was auto-installed and no deprecation warning from rustup; the log is kept with its hash.
3. The channel the guest compiled with equals the `channel` of `rust-toolchain.toml`, read from that log.
4. The driver holds no literal copy of the channel, and its constructed test shows the install command taking the channel from the file.
5. The decision on the other places is recorded in this item, with each place repaired or named as left.
6. `make shell-check` and the driver's own test are green at the commit.
