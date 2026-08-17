# Building and testing chan on Windows (and Linux from a Windows host)

> **Status: validated on real hardware 2026-08-14; native CI remains authoritative.** The WSL2 + `sdme` loop below is no longer proposed -- it was run end to end on a Windows 11 workstation (WSL2 Ubuntu 24.04, kernel 6.18 microsoft-standard-WSL2, host systemd 259, guest systemd 255, sdme 0.18.0), and `scripts/e2e/devserver-fdstore.sh` passed all 8 cases inside an nspawn guest. Ordinary CI builds an unsigned NSIS package and boots its desktop binary as a devserver on `windows-latest`; release CI repeats the package with Authenticode signing. Corrections from that first real run are folded in below; keep flagging more.

chan supports Windows on two fronts, kept deliberately separate:

1. **Running / building chan-desktop *for* Windows** -- the GUI app, whose terminal runs the user's default shell (PowerShell, or `cmd` / a `CHAN_SHELL` override). You do **not** need a Windows machine to *compile-check* this from macOS/Linux; see "Native Windows build" below.
2. **Developing chan *on* a Windows machine** -- running the gates, building the Linux artifacts (AppImage / `.deb` / `.rpm`, the static musl CLI tarball) and the chan-gateway, the same way a macOS contributor uses `lima` + `sdme`. On Windows the Linux environment comes from **WSL2** (recommended) or **Hyper-V**; `sdme` runs inside it. See "Linux dev loop on a Windows host" below.

For the core build/test commands on your host directly (fmt, clippy, tests, web), see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Native Windows build (no Windows host needed)

The fast local proof that the `cfg(windows)` arms compile is a cross-compile from macOS/Linux with [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin), which downloads the MSVC CRT + Windows SDK headers on demand (no Windows host, and **no Wine** -- Wine cannot run WebView2, so a Wine-in-a-container GUI run is not viable):

```sh
# from the repo root or desktop/: installs cargo-xwin + the rust target on demand
make -C desktop xwin-check
```

This checks the core crates (`chan-server`, `chan-shell`, `chan-workspace`) for `x86_64-pc-windows-msvc`. The chan-desktop crate's full Windows build pulls the whole Tauri + WebView2 toolchain and is **not** part of `xwin-check`; the `windows-latest` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) builds the CLI and desktop with native MSVC, emits a secret-free NSIS installer, and boots the desktop binary as a foreground devserver. [`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml) remains the signed package rehearsal whose `chan-desktop-windows-x86_64` artifact is suitable for a real Windows smoke.

A clean Win11 needs the **WebView2 evergreen runtime**. It ships with current Windows 10/11 and the `windows-latest` runner has it; for an older or stripped image, install Microsoft's Evergreen Bootstrapper (`MicrosoftEdgeWebview2Setup.exe`) -- the NSIS installer can also bundle the bootstrapper check via Tauri's `webviewInstallMode`.

## Checking the `cfg(target_os = "linux")` code from Windows

The mirror image of `xwin-check`: a Windows host cannot compile the Linux arms, and that gap is not theoretical. Adding one field to `CreateOptions` looked clean on Windows and broke **15** Linux-only construction sites -- all in fd-store and control-socket test code behind `cfg(target_os = "linux")` -- which a single WSL run found and CI would otherwise have reported.

Reviewing structurally instead does not substitute. Verifying that every `FdStoreSessionMeta` literal carried the new field was true and useless: a structural sweep only inspects the sites you already know about. For a field added to a struct used across `cfg` boundaries, only a real compile on the other platform counts.

**Setup, once, inside WSL:**

```sh
# rustup needs no sudo; it installs under $HOME. Run it with your cwd inside
# the repo and rust-toolchain.toml selects the pinned toolchain automatically.
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path

# without a linker, build scripts (ring, zstd-sys, onig_sys) fail
sudo apt-get install -y build-essential pkg-config libssl-dev
```

**Running it.** Keep the source wherever you work; put `CARGO_TARGET_DIR` on WSL's ext4. Build-artifact writes over 9p are what make `/mnt/c` builds unusable -- source reads are tolerable:

```sh
export CARGO_TARGET_DIR=$HOME/.cache/chan-target
cargo check -p chan-library -p chan-server --all-targets
cargo test -p chan-library fdstore          # 18 tests a Windows host cannot build
RUSTFLAGS="-D warnings" cargo clippy -p chan-library -p chan-server -p chan --all-targets
```

The clippy line matters as much as the compile: CI denies warnings on Linux, and a `cfg(linux)` lint finding is invisible from Windows too.

Two invocation traps when calling into WSL from Windows tooling: **Git Bash** rewrites `/mnt/c/...` arguments into `C:/Program Files/Git/mnt/c/...` (MSYS path translation), so drive WSL from PowerShell or from inside WSL; and PowerShell expands `$(...)` inside double-quoted arguments before `wsl.exe` sees them, so pass a script file rather than an inline command.

## Linux dev loop on a Windows host

chan's gates and Linux artifacts are built in `sdme` (the project's systemd-nspawn container manager), exactly as on macOS -- the only difference is how you reach a Linux kernel. On macOS that's `lima`; on Windows it's **WSL2**.

The Makefiles parameterize this with the **`SDME`** variable (how `sdme` is invoked) and **`DISTRO`** (which rootfs to build). On a native Linux host `SDME='sudo sdme'`; on macOS `SDME='limactl shell default sudo sdme'`. On Windows you have two equivalent options:

- **Recommended -- work *inside* WSL2.** Treat the WSL2 distro as a native Linux host: clone the repo into the WSL2 ext4 filesystem (your Linux `~`, **not** `/mnt/c`) and follow [`linux-and-macos.md`](linux-and-macos.md) verbatim. Nothing needs setting: inside WSL `uname -s` is `Linux`, so the Makefile's own default already resolves `SDME='sudo sdme'`. WSL is to Windows what the lima VM is to macOS, except macOS needs the `limactl shell` prefix because `make` runs on the *host* -- on Windows `make` cannot run on the host at all, so it runs in WSL and the Linux branch applies verbatim.
- **Driving WSL2 from the Windows shell is not recommended.** `SDME='wsl sudo sdme'` makes each `sdme` call a separate `wsl.exe` invocation, and **WSL tears the distro down when idle, halting any running container with it** -- observed repeatedly on real hardware, including a distro boot that lasted 19 seconds. A container created by one call can be gone before the next, which looks like nspawn instability and is not. If you must drive from PowerShell, keep the whole flow inside a single `wsl.exe` invocation (one script), or disable the teardown with `[wsl2] vmIdleTimeout=-1` in `.wslconfig`.

### Prerequisites

- **WSL2 with systemd enabled.** `sdme` is systemd-nspawn, so the WSL distro must run systemd. On WSL 0.67.6+ enable it once in `/etc/wsl.conf`:

  ```ini
  [boot]
  systemd=true
  ```

  then `wsl --shutdown` and reopen. Install a distro (`wsl --install -d Ubuntu`) and the systemd/nspawn host tooling `sdme` needs inside it, same as a Linux host.
- **nspawn inside WSL2 works.** The historical worry (cgroup/namespace support lagging) did not materialise on a current WSL2: the kernel exposes a unified `cgroup2` hierarchy, `/dev/kmsg`, and ~62k user namespaces, `systemd-machined` is D-Bus activated, and a guest boots systemd as PID 1 in a couple of seconds. `sudo apt install systemd-containers` provides nspawn; then install sdme itself.
- **Hyper-V alternative.** Still available if WSL2 misbehaves on your machine: a full Linux guest under Hyper-V behaves as a plain Linux host. Heavier than WSL2, and no longer the expected path.
- **Git line endings.** Set `git config --global core.autocrlf input` (or rely on the repo's `.gitattributes`) so shell scripts and the `.cmd` shims keep their intended endings across the Windows/WSL boundary.

### Running the gate + building artifacts

With a working WSL2 (or Hyper-V) Linux environment, the same targets the macOS doc uses apply -- only `SDME` changes. From inside WSL2 (recommended):

```sh
# one-time: import the base image (inside WSL, sdme runs natively).
# --install-packages=yes runs sdme's debian import_prehook, which installs
# systemd + dbus + login. Without it the rootfs cannot boot as an nspawn guest.
sudo sdme fs import docker.io/library/ubuntu:24.04 \
  --name ubuntu --install-packages=yes

# the Linux chan-desktop bundles (AppImage / .deb / .rpm)
make linux-chan-desktop DISTRO=ubuntu SDME='sudo sdme'

# the gateway .deb packages (separate Cargo workspace)
make linux-gateway SDME='sudo sdme'

# the static musl CLI tarball (host cross-compile, no container)
make linux-chan-tarball LINUX_TARGET=x86_64-unknown-linux-musl
```

Run these from inside WSL. Driving them from the Windows shell with `SDME='wsl sudo sdme'` is the discouraged path above: each `sdme` call becomes its own `wsl.exe` invocation, and the distro can be torn down between them.

The core gate itself (`make ci-linux`) runs inside an sdme container exactly as in [`linux-and-macos.md`](linux-and-macos.md#core-run-the-ci-gate-in-a-linux-container) -- seed the tree with `git archive HEAD`, install the deps, run the gate. Reuse those instructions; they are not duplicated here.

### The systemd fd-store suite

`scripts/e2e/devserver-fdstore.sh` drives a real `systemctl --user` unit and so must run in a container, never on a host serving live terminals -- the same rule as on Linux and macOS. On Windows the container is an sdme guest inside WSL, and the whole nested stack works: WSL systemd -> nspawn guest systemd -> a lingering per-user manager whose units accept `FileDescriptorStoreMax`.

Provision the guest per the recipe in [`linux-and-macos.md`](linux-and-macos.md), plus the packages the suite itself needs:

```sh
sudo sdme create --name chan-fdstore -r ubuntu \
  --bind "$HOME/chan:/repo" \
  --bind "$HOME/.cargo:/home/dev/.cargo" \
  --bind "$HOME/.rustup:/home/dev/.rustup"
sudo sdme start chan-fdstore
```

Then inside the guest: install `dbus-user-session sudo bash git curl procps python3 build-essential pkg-config libssl-dev`, create the `dev` user at **uid 1000**, `loginctl enable-linger dev`, and run the suite as `dev` with `CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1` -- correct here and only here, because nothing else in a throwaway container owns `chan-devserver.service`.

Six things bite in practice, all found on the first real run:

| symptom | cause and fix |
|---|---|
| `useradd: UID 1000 is not unique` | Ubuntu 24.04's base image ships a user at uid 1000. Evict it: the bound `~/.cargo` and repo are owned by uid 1000 on the WSL side, so `dev` must claim it. |
| `SKIP: node required` / `python3 required`, **exit 0** | The suite skips on missing deps and exits 0, so a skip is indistinguishable from a pass. Read the log for a `SKIP:` line before believing a green run. |
| `node: bad option: --experimental-websocket` | apt's Node on noble is v18; the flag needs 21+. Install Node 22 from the official tarball. **This is not Windows-specific** -- any guest built from a noble base hits it. |
| `could not compile <crate> (build script)`, `os error 2` | No linker in the guest. A toolchain bound in from WSL is not enough; the guest needs `build-essential` of its own. |
| `/repo/target/debug/chan: No such file or directory` | The suite resolves the binary through `CARGO_TARGET_DIR` when it is set. Point it at a writable guest-local path such as `/var/tmp/chan-target` when the source is read-only; otherwise leave it unset to use `$REPO/target`. |
| `fatal: not a git repository: /repo/C:/...` | The Windows linked-worktree `.git` pointer; see the filesystem notes below. Use a WSL clone. |

A passing run prints `PASS: all 8 cases at <sha>` and asserts the fd-store count after every phase -- restart, CLI restart, watchdog `SIGSTOP`, `kill -9` crash restore, session close, stop, `--restart --force`, and bare stop.

### Filesystem + performance notes

- **Stay on ext4.** WSL2 reaches Windows drives over a 9p mount at `/mnt/c`, which is slow for the many small files cargo and node touch. Keep the repo, `target/`, and `node_modules` on the WSL2 ext4 filesystem. This is the Windows analogue of the macOS caveat that `lima` mounts `/Users` read-only -- different cause (perf vs read-only), same conclusion: do the build inside the Linux fs.
- **A Windows *linked worktree* is not a git repository from Linux, at all.** This is a correctness limit, not a performance one. A linked worktree's `.git` is a file containing an absolute `gitdir:` path, and one written by Windows git reads `gitdir: C:/...`. Linux git treats that as *relative* and fails with a spliced nonsense path. Anything that shells out to git therefore breaks -- including `scripts/e2e/devserver-fdstore.sh`, which records `git rev-parse HEAD` as the commit under test. Clone into WSL instead; cloning from the local Windows checkout needs no network or credentials:

  ```sh
  git config --global --add safe.directory /mnt/c/path/to/chan
  git clone --branch <branch> --single-branch /mnt/c/path/to/chan ~/chan
  ```

  A plain (non-worktree) Windows checkout has a real `.git` directory and does not hit this, but the 9p performance caveat still applies.
- **x86_64 by default.** A Windows dev host is x86_64, so the WSL2 containers are x86_64 Linux -- matching CI's `ubuntu-latest` lane. There is no aarch64 fp16 build wrinkle to work around (that one only affects the Apple-Silicon lima/sdme flow); a plus of the Windows loop over the macOS one.

## How this maps to CI

CI does not use WSL2 or `sdme`. As on the other platforms, GitHub Actions runs natively:

- `.github/workflows/ci.yml` runs Linux, macOS, and Windows on native runners. Its `windows-latest` job builds the release CLI, builds an unsigned NSIS package from the same Tauri configuration shape as release, and runs the headless devserver `/api/health` smoke through `chan-desktop.exe`.
- The `windows-latest` arm of [`release-desktop.yml`](../../.github/workflows/release-desktop.yml) repeats the NSIS build with Authenticode signing and uploads the package for a real-hardware smoke.

The WSL2 + `sdme` flow above is the *local* way to reproduce the Linux environment on a Windows machine; `cargo-xwin` is the *local* way to compile-check the native Windows build. Both are the fast loop -- CI is the canonical lane (and owns the authoritative Windows artifact).
