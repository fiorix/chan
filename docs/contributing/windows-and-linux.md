# Building and testing chan on Windows (and Linux from a Windows host)

chan supports Windows on two fronts, kept deliberately separate:

1. **Running and building chan-desktop for Windows**: the GUI app, whose terminal runs the user's default shell (PowerShell, or `cmd`, or a `CHAN_SHELL` override). You do not need a Windows machine to compile-check this from macOS or Linux; see "Native Windows build" below. Ordinary CI builds an unsigned NSIS package and boots its desktop binary as a devserver on `windows-latest`; release CI repeats the package with Authenticode signing.
2. **Developing chan on a Windows machine**: running the gates, building the Linux artifacts (AppImage, `.deb`, `.rpm`, the static musl CLI tarball) and the gateway packages, the same way a macOS contributor uses `lima` plus `sdme`. On Windows the Linux environment comes from WSL2 (recommended) or Hyper-V; `sdme` runs inside it. See "Linux dev loop on a Windows host" below.

For the core build and test commands on your host directly (fmt, clippy, tests, web), see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Native Windows build (no Windows host needed)

The fast local proof that the `cfg(windows)` arms compile is a cross-compile from macOS or Linux with [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin), which downloads the MSVC CRT and Windows SDK headers on demand. No Windows host and no Wine: Wine cannot run WebView2, so a Wine-in-a-container GUI run is not viable.

```sh
# from the repo root or desktop/: installs cargo-xwin + the rust target on demand
make -C desktop xwin-check
```

This checks `chan-server`, `chan-shell` and `chan-workspace` for `x86_64-pc-windows-msvc` with warnings denied; it needs the LLVM tools (`llvm-lib`, `clang-cl`) on `PATH`. The chan-desktop crate's full Windows build pulls the whole Tauri plus WebView2 toolchain and is not part of `xwin-check`; the `windows-latest` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) builds the CLI and desktop with native MSVC, emits a secret-free NSIS installer, and boots the desktop binary as a foreground devserver. [`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml) is the signed package rehearsal whose `chan-desktop-windows-x86_64` artifact is suitable for a real Windows smoke.

A clean Windows 11 needs the WebView2 evergreen runtime. It ships with current Windows 10 and 11 and the `windows-latest` runner has it; for an older or stripped image, install Microsoft's Evergreen Bootstrapper (`MicrosoftEdgeWebview2Setup.exe`). The NSIS installer can also bundle the bootstrapper check via Tauri's `webviewInstallMode`.

## Checking the `cfg(target_os = "linux")` code from Windows

The mirror image of `xwin-check`: a Windows host cannot compile the Linux arms, and the gap is real. A field added to a struct constructed in Linux-only test code (the fd-store and control-socket tests behind `cfg(target_os = "linux")`) looks clean on Windows and breaks every Linux construction site. A structural review does not substitute: a sweep only inspects the sites you already know about, and only a real compile on the other platform counts.

**Setup, once, inside WSL:**

```sh
# rustup needs no sudo; it installs under $HOME. Run it with your cwd inside
# the repo and rust-toolchain.toml selects the pinned toolchain automatically.
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path

# without a linker, build scripts (ring, zstd-sys, onig_sys) fail
sudo apt-get install -y build-essential pkg-config libssl-dev
```

**Running it.** Keep the source wherever you work; put `CARGO_TARGET_DIR` on WSL's ext4. Build-artifact writes over 9p are what make `/mnt/c` builds unusable; source reads are tolerable:

```sh
export CARGO_TARGET_DIR=$HOME/.cache/chan-target
cargo check -p chan-library -p chan-server --all-targets
cargo test -p chan-library fdstore          # tests a Windows host cannot build
RUSTFLAGS="-D warnings" cargo clippy -p chan-library -p chan-server -p chan --all-targets
```

The clippy line matters as much as the compile: CI denies warnings on Linux, and a `cfg(linux)` lint finding is invisible from Windows too.

Two invocation traps when calling into WSL from Windows tooling: Git Bash rewrites `/mnt/c/...` arguments into `C:/Program Files/Git/mnt/c/...` (MSYS path translation), so drive WSL from PowerShell or from inside WSL; and PowerShell expands `$(...)` inside double-quoted arguments before `wsl.exe` sees them, so pass a script file rather than an inline command.

## Linux dev loop on a Windows host

chan's gates and Linux artifacts are built in `sdme` (the project's systemd-nspawn container manager), exactly as on macOS; the only difference is how you reach a Linux kernel. On macOS that is `lima`; on Windows it is WSL2.

The Makefiles parameterize this with the `SDME` variable (how `sdme` is invoked) and `DISTRO` (which rootfs to build). On a native Linux host `SDME='sudo sdme'`; on macOS `SDME='limactl shell default sudo sdme'`. On Windows you have two options:

- **Recommended: work inside WSL2.** Treat the WSL2 distro as a native Linux host: clone the repo into the WSL2 ext4 filesystem (your Linux `~`, not `/mnt/c`) and follow [`linux-and-macos.md`](linux-and-macos.md) verbatim. Nothing needs setting: inside WSL `uname -s` is `Linux`, so the Makefile's default already resolves `SDME='sudo sdme'`. WSL is to Windows what the lima VM is to macOS, except that macOS needs the `limactl shell` prefix because `make` runs on the host; on Windows `make` cannot run on the host at all, so it runs in WSL and the Linux branch applies verbatim.
- **Driving WSL2 from the Windows shell is not recommended.** `SDME='wsl sudo sdme'` makes each `sdme` call a separate `wsl.exe` invocation, and WSL tears the distro down when idle, halting any running container with it. A container created by one call can be gone before the next, which looks like nspawn instability and is not. If you must drive from PowerShell, keep the whole flow inside a single `wsl.exe` invocation (one script), or disable the teardown with `[wsl2] vmIdleTimeout=-1` in `.wslconfig`.

### Prerequisites

- **WSL2 with systemd enabled.** `sdme` is systemd-nspawn, so the WSL distro must run systemd. On WSL 0.67.6+ enable it once in `/etc/wsl.conf`:

  ```ini
  [boot]
  systemd=true
  ```

  then `wsl --shutdown` and reopen. Install a distro (`wsl --install -d Ubuntu`) and the systemd/nspawn host tooling `sdme` needs inside it, the same as on a Linux host.
- **nspawn inside WSL2 works.** A current WSL2 kernel exposes a unified `cgroup2` hierarchy, `/dev/kmsg` and user namespaces, `systemd-machined` is D-Bus activated, and a guest boots systemd as PID 1. `sudo apt install systemd-containers` provides nspawn; then install sdme itself.
- **Hyper-V alternative.** A full Linux guest under Hyper-V behaves as a plain Linux host. It is heavier than WSL2 and not the expected path.
- **Git line endings.** The repo's `.gitattributes` checks every file out as LF on every platform (the `include_str!` pins depend on it); set `git config --global core.autocrlf input` as well so a file you add keeps LF across the Windows/WSL boundary.

### Running the gate and building artifacts

With a working WSL2 (or Hyper-V) Linux environment, the same targets the macOS page uses apply; only `SDME` changes. From inside WSL2:

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

Run these from inside WSL. Driving them from the Windows shell with `SDME='wsl sudo sdme'` is the discouraged path above.

The core gate itself (`make ci-linux`) runs inside an sdme container exactly as in [`linux-and-macos.md`](linux-and-macos.md#core-run-the-ci-gate-in-a-linux-container): seed the tree, install the dependencies, run the gate. Reuse those instructions; they are not duplicated here.

### The systemd fd-store suite

`scripts/e2e/devserver-fdstore.sh` drives a real `systemctl --user` unit and so must run in a container, never on a host serving live terminals, the same rule as on Linux and macOS. On Windows the container is an sdme guest inside WSL, and the nested stack works: WSL systemd, then the nspawn guest's systemd, then a lingering per-user manager whose units accept `FileDescriptorStoreMax`.

Provision the guest per the recipe in [`linux-and-macos.md`](linux-and-macos.md), plus the packages the suite itself needs:

```sh
sudo sdme create --name chan-fdstore -r ubuntu \
  --bind "$HOME/chan:/repo" \
  --bind "$HOME/.cargo:/home/dev/.cargo" \
  --bind "$HOME/.rustup:/home/dev/.rustup"
sudo sdme start chan-fdstore
```

Then inside the guest: install `dbus-user-session sudo bash git curl procps python3 build-essential pkg-config libssl-dev`, create the `dev` user at uid 1000, `loginctl enable-linger dev`, and run the suite as `dev` with `CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1`, correct here and only here, because nothing else in a throwaway container owns `chan-devserver.service`.

The traps, and what each one means:

| symptom | cause and fix |
|---|---|
| `useradd: UID 1000 is not unique` | Ubuntu 24.04's base image ships a user at uid 1000. Evict it: the bound `~/.cargo` and repo are owned by uid 1000 on the WSL side, so `dev` must claim it. |
| `SKIP: node required` / `python3 required`, exit 0 | The suite skips on missing dependencies and exits 0, so a skip is indistinguishable from a pass. Read the log for a `SKIP:` line before believing a green run. |
| `node: bad option: --experimental-websocket` | apt's Node on noble is too old for the flag. Install Node 22 from the official tarball. This is not Windows-specific: any guest built from a noble base hits it. |
| `could not compile <crate> (build script)`, `os error 2` | No linker in the guest. A toolchain bound in from WSL is not enough; the guest needs `build-essential` of its own. |
| `/repo/target/debug/chan: No such file or directory` | The suite resolves the binary through `CARGO_TARGET_DIR` when it is set. Point it at a writable guest-local path such as `/var/tmp/chan-target` when the source is read-only; otherwise leave it unset to use `$REPO/target`. |
| `fatal: not a git repository: /repo/C:/...` | The Windows linked-worktree `.git` pointer; see the filesystem notes below. Use a WSL clone. |

A passing run prints `PASS: all <n> cases at <sha>`, the sha being the `git rev-parse HEAD` of the checkout under test.

### Filesystem and performance notes

- **Stay on ext4.** WSL2 reaches Windows drives over a 9p mount at `/mnt/c`, which is slow for the many small files cargo and node touch. Keep the repo, `target/`, and `node_modules` on the WSL2 ext4 filesystem. This is the Windows analogue of the macOS caveat that `lima` mounts `/Users` read-only: different cause, same conclusion, do the build inside the Linux filesystem.
- **A Windows linked worktree is not a git repository from Linux.** This is a correctness limit, not a performance one. A linked worktree's `.git` is a file containing an absolute `gitdir:` path, and one written by Windows git reads `gitdir: C:/...`. Linux git treats that as relative and fails with a spliced path. Anything that shells out to git therefore breaks, `scripts/e2e/devserver-fdstore.sh` included, since it records `git rev-parse HEAD` as the commit under test. Clone into WSL instead; cloning from the local Windows checkout needs no network or credentials:

  ```sh
  git config --global --add safe.directory /mnt/c/path/to/chan
  git clone --branch <branch> --single-branch /mnt/c/path/to/chan ~/chan
  ```

  A plain (non-worktree) Windows checkout has a real `.git` directory and does not hit this, but the 9p performance caveat still applies.
- **x86_64 by default.** A Windows dev host is x86_64, so the WSL2 containers are x86_64 Linux, matching CI's `ubuntu-latest` lane.

## How this maps to CI

CI does not use WSL2 or `sdme`. As on the other platforms, GitHub Actions runs natively:

- `.github/workflows/ci.yml` runs Linux, macOS, and Windows on native runners. Its `windows-latest` job (`make ci-windows`) builds the release CLI and smokes it, runs the Windows-meaningful test subset, builds an unsigned NSIS package from the same Tauri configuration shape as release, boots `chan-desktop.exe` as a headless devserver against `/api/health`, and smokes the installer.
- The `windows-latest` arm of [`release-desktop.yml`](../../.github/workflows/release-desktop.yml) repeats the NSIS build with Authenticode signing and uploads the package for a real-hardware smoke.

The WSL2 plus `sdme` flow above is the local way to reproduce the Linux environment on a Windows machine; `cargo-xwin` is the local way to compile-check the native Windows build. Both are the fast loop; CI is the canonical lane and owns the authoritative Windows artifact.
