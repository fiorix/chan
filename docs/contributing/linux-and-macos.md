# Building and testing chan on Linux and macOS

chan's gates run on Linux (the canonical CI target) and macOS. The reproducible way to get a Linux environment **locally** on either host is `sdme`, the project's systemd-nspawn container manager. This is the same flow for everyone: on a Linux host you run `sdme` directly; on macOS you run it inside a lightweight Linux VM via `lima`.

`sdme` is a local-development tool only. CI does not use it: GitHub Actions runs on its own ubuntu runners (native, with apt-installed deps and service containers). The dev setup and the CI setup are intentionally different, the same as the rest of chan; see "How this maps to CI" at the end.

This doc covers the local Linux flow. For the core build/test commands themselves (fmt, clippy, tests, web) on your host directly, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md). For the gateway's Postgres-backed tests, see [`gateway/docs/dev-setup.md`](../../gateway/docs/dev-setup.md).

## Prerequisites

- **Linux**: install the systemd/nspawn host tooling sdme needs, then sdme itself. On Debian/Ubuntu:

  ```sh
  sudo apt install systemd-containers          # provides systemd-nspawn (systemd-container on older releases)
  curl -fsSL https://sdme.io/install.sh | sudo sh
  ```

  Run every `sdme ...` command below directly (no `limactl` prefix, no alias).
- **macOS**: sdme needs systemd, so it runs inside a Lima Ubuntu VM. Install Lima, start the VM, then install the same tooling + sdme **inside it**:

  ```sh
  brew install lima
  limactl start default                                   # Ubuntu, systemd, host networking
  limactl shell default -- sudo apt install -y systemd-containers
  limactl shell default -- sh -c 'curl -fsSL https://sdme.io/install.sh | sudo sh'
  alias sdme='limactl shell default sudo sdme'            # then the examples read verbatim
  ```

  Every command below uses the explicit `limactl shell default sudo sdme ...` form (substitute your VM name for `default`); the alias above collapses it to `sdme ...` interactively. The explicit form is what scripts and agents should use, where the interactive alias does not resolve.

Two macOS specifics worth knowing:

- `lima` exposes your home directory to the VM **read-only** via virtiofs, so the VM can read the repo at the same path. `sdme` containers, however, have their own rootfs and do not inherit that mount: move files in with `sdme cp` (see below).
- `sdme` containers use host networking, so a service listening on `:PORT` inside a container is reachable at `localhost:PORT` from macOS.

On Apple Silicon the containers are aarch64 Linux. That is sufficient for distro portability, dependency availability, clippy, and tests; x86_64-specific issues still ride CI's `ubuntu-latest`.

## One-time: import a base image

```sh
limactl shell default sudo sdme fs import docker.io/ubuntu --name ubuntu
```

## Core: run the CI gate in a Linux container

CI runs `make ci-linux` on `ubuntu-latest` after installing the Tauri build dependencies. Mirror that locally:

```sh
# create + start a build container from the ubuntu base
limactl shell default sudo sdme create --name chan-build -r ubuntu --storage btrfs
limactl shell default sudo sdme start  chan-build

# seed the repo (tracked files only) into the container
git archive HEAD -o ~/chan-src.tar
limactl shell default sudo sdme cp ~/chan-src.tar chan-build:/root/chan.tar
limactl shell default sudo sdme exec chan-build /bin/sh -c \
  'mkdir -p /root/chan && tar -xf /root/chan.tar -C /root/chan'

# install deps (same set CI installs) + the pinned Rust toolchain
limactl shell default sudo sdme exec chan-build /bin/sh -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y build-essential pkg-config curl ca-certificates \
    nodejs npm libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libsoup-3.0-dev patchelf xdg-utils \
    desktop-file-utils file
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'

# run the gate (reads rust-toolchain.toml -> 1.95.0)
limactl shell default sudo sdme exec chan-build /bin/sh -c '
  export HOME=/root; . /root/.cargo/env; cd /root/chan && make ci-linux'
```

`git archive HEAD` ships committed files only; re-run it (and re-`cp`) after each commit you want reflected in the container. To iterate without rebuilding the container, `sdme cp` individual files or `sdme join chan-build` for an interactive shell. A cold `make ci-linux` also installs Tauri CLI under `target/tauri-cli`, then builds and boots the release devserver and produces an AppImage after the compile/test gates.

## Desktop: build the chan-desktop AppImage and .deb

`make chan-desktop` runs `cargo tauri build` natively, so on macOS it produces a macOS `.app`, not Linux bundles. To build the Linux chan-desktop bundles (the AppImage that `release.yml`'s `linux-desktop-artifacts` job ships, plus the `.deb`/`.rpm` Tauri's `targets:"all"` emits for free, which stay local/QA outputs -- COPR/PPA/AUR own the packaged channel) from a macOS workstation, run `cargo tauri build` inside an sdme container:

```sh
# one-time: import the ubuntu base (shared with the core gate above)
limactl shell default sudo sdme fs import docker.io/ubuntu --name ubuntu

# build the bundles for one distro (default ubuntu)
make linux-chan-desktop DISTRO=ubuntu
```

`make linux-chan-desktop` drives `packaging/sdme/build-chan-desktop.sh`, which:

1. builds the `chan-desktop-<distro>` rootfs from `packaging/sdme/chan-desktop-<distro>.sdme` on first use (it bakes the Tauri build deps and the Rust toolchain, so this cost is paid once),
2. creates or reuses a `chan-desktop-build-<distro>` container,
3. seeds the committed tree (`git archive HEAD`),
4. runs `make chan-desktop` inside it, and
5. copies the bundles out to `target/linux-desktop/<distro>/`.

The container is reused between runs so the cargo target cache survives (a cold compile is around 20 minutes; an incremental rebuild is a minute or two). Force a clean container with `REBUILD_CONTAINER=1 make linux-chan-desktop`.

How sdme is reached is the `SDME` variable (a lima VM on macOS by default, `sudo sdme` directly on a Linux host):

```sh
# native Linux host
make linux-chan-desktop SDME='sudo sdme'
```

Two container facts the driver accommodates, both worth knowing if you script `cargo tauri build` in sdme yourself:

- sdme mounts a small (~800M) tmpfs over `/tmp`; the cold Rust + tauri-cli compile overflows it. The in-container build sets `TMPDIR=/var/tmp` (the disk-backed overlay).
- the chan-desktop rootfs needs `xdg-utils` on top of the core gate's Tauri deps: the AppImage plugin shells out to `xdg-mime`, and without it the bundle fails at the very end with `xdg-mime binary not found`.

On Apple Silicon the bundles are aarch64 Linux; CI's `ubuntu-latest` owns the canonical x86_64 desktop build. The AppImage is built with `linuxdeploy` in extract-and-run mode, so no FUSE or display is needed in the container.

### Verifying the cs alias on the AppImage

chan-desktop runs as both `chan` and `cs` -- the same binary re-execing itself with `argv[0]` set to the name (the `chan_shell::invoked_as_chan` / `invoked_as_cs` argv0 detection), so the CLI / control client runs instead of the GUI. On boot it owns the `~/.local/bin/{chan,cs}` shims (`desktop/src-tauri/src/cs_install.rs`): real symlinks to the installed binary for a `.app` or deb/rpm install, `exec -a` wrapper scripts for an AppImage (whose `current_exe()` is an ephemeral mount). The shims self-heal on a move or self-upgrade, are idempotent, and never clobber a `chan` / `cs` you installed yourself. To check the client path on a built artifact, point the inner binary at a running server's control socket and confirm it runs the client, not the GUI:

```sh
# in the container, with a `chan serve` running and $CHAN_CONTROL_SOCKET
# pointed at its socket:
exec -a cs ./squashfs-root/usr/bin/chan-desktop terminal list   # rc=0, no GUI
```

Packaged-AppImage dispatch: invoking the AppImage through its `cs` / `chan` wrapper (`exec -a cs "$APPIMAGE"`) DOES reach the inner binary as the right name. linuxdeploy's `AppRun` re-execs `AppRun.wrapped` without preserving argv[0], but the type-2 AppImage runtime exports the `exec -a` name as `$ARGV0`, and the `cs` / `chan` stem probes read `$ARGV0` before `argv[0]` (`chan_shell::invoked_arg0`), so the CLI / control client runs instead of the GUI. Off an AppImage `$ARGV0` is unset and behavior is unchanged.

Packaged-AppImage working directory: `AppRun.wrapped` is not the app binary but the legacy AppImageKit `AppRun`, which chdirs into the mounted `<AppDir>/usr` before exec'ing `usr/bin/chan-desktop` and exports no `OWD`. The wrapper shims therefore export `$CHAN_CALLER_PWD`, and `cs_install::restore_caller_cwd` chdirs back at boot so relative CLI paths resolve against the invoking shell's directory. When testing the AppImage by hand (without a shim), a relative `chan serve .` still resolves inside the mount; pass an absolute path or set `CHAN_CALLER_PWD` yourself.

## CLI: build the static musl `chan` tarball

The standalone `chan` CLI tarball (what `install.sh` and the self-upgrade download) is built fully static against musl, so a too-new build glibc does not gate older Linux machines. The locally built `.deb`/`.rpm` bundles and the chan-desktop AppImage stay gnu: the distro provides glibc, and webkit cannot be static.

This is a host cross-compile, no container. cargo-zigbuild uses zig as the cross C/C++ compiler so the C/C++ deps (ring, bundled SQLite, tokenizers' esaxx-rs/onig) link static. Prerequisites on the host: zig, cargo-zigbuild, and the musl rust targets.

```bash
# one-time: tooling (zig must already be on PATH) + the musl rust targets
cargo install cargo-zigbuild
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl

# build the static tarball for an arch (from the repo root)
make linux-chan-tarball LINUX_TARGET=x86_64-unknown-linux-musl
make linux-chan-tarball LINUX_TARGET=aarch64-unknown-linux-musl

# the tarball lands at target/release/chan-<target>.tar.gz; confirm static
tar -xzf target/release/chan-x86_64-unknown-linux-musl.tar.gz -C /tmp
file /tmp/chan          # -> ... statically linked
# on Linux: ldd /tmp/chan -> "not a dynamic executable"
```

CI builds these in `release.yml`'s `linux-cli-artifacts` job (zig via `mlugg/setup-zig` + cargo-zigbuild); the locally built `.deb`/`.rpm` bundles stay gnu. The `chan-tarball` Make target uses `cargo zigbuild` for musl targets and plain `cargo build` for gnu.

## Devserver: the `--service=systemd` user-service path

`chan devserver` supervision is per-OS, and `--service` defaults to `auto`, which resolves to systemd on a systemd Linux host (so a bare `chan devserver join` and the explicit `join --service=systemd` below are equivalent there; the examples name the backend explicitly to make clear which path they exercise). `chan devserver join --service=systemd` runs the server under a `chan-devserver.service` systemd **user** service (it ensures linger, starts the unit, re-attaches to an already-running one, and stays attached blocking on the health watchdog), and the `chan serve PATH` discovery socket that registers workspaces with it is Unix-only. `start --service=systemd` does the same setup but returns instead of attaching, `stop --service=systemd` stops and disables the unit, and `restart --service=systemd` bounces it. On macOS `--service=systemd` errors (systemd is Linux-only; use `--service=launchd` or `--service=chan` there), so to develop and exercise the systemd path on a Mac you run it inside lima/sdme, the same Linux flow as everyone else. The supervision shape and its token-delivery contract are in [`design.md`](../../design.md) ("Devserver and the multi-workspace host").

The one thing this needs beyond the core gate's container is a **systemd user manager**: `--service=systemd` drives `loginctl enable-linger` and `systemctl --user`, which require a regular (non-root), lingering user with a live user session -- not the root shell `sdme join` drops you into. Stand one up once:

```sh
limactl shell default sudo sdme create --name chan-devserver-dev -r ubuntu --storage btrfs
limactl shell default sudo sdme start  chan-devserver-dev

# a lingering dev user whose `systemctl --user` manager is running
limactl shell default sudo sdme exec chan-devserver-dev /bin/bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y dbus-user-session sudo
  id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev
  loginctl enable-linger dev'
```

> `devserver-fdstore.sh` additionally requires `python3` and `node`, and **SKIPs with exit 0** when either is missing -- so a guest without them yields a run that looks green and proves nothing. On a noble (24.04) base, apt's Node is v18 and the suite dies on `node: bad option: --experimental-websocket`; it needs Node 21+. Both observed on a real run; see the table in [`windows-and-linux.md`](windows-and-linux.md#the-systemd-fd-store-suite), which is platform-independent despite living in the Windows doc.

Seed the `chan` binary into the container the way the core gate seeds the tree (`git archive HEAD` + `sdme cp`, then build inside with the aarch64 flag from the build note below), and put it at a stable path such as `/usr/local/bin/chan` -- the unit's `ExecStart` records the binary's resolved path, so a moving target dir would break a restart. Then run the devserver **as the dev user**, exporting that user's runtime dir and bus so `systemctl --user` resolves:

```sh
limactl shell default sudo sdme exec chan-devserver-dev /bin/bash -c '
  U=$(id -u dev)
  sudo -u dev -H env \
    XDG_RUNTIME_DIR=/run/user/$U \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus \
    chan devserver join --service=systemd --bind 127.0.0.1 --port 7777'
```

Expect the locked `CHAN_DEVSERVER_TOKEN=<token>` marker on **stdout** (the contract the desktop control terminal scrapes), the unit at `~dev/.config/systemd/user/chan-devserver.service`, and `systemctl --user status chan-devserver.service` reporting active; a second `join` re-attaches to the running unit and re-emits the marker. This container is also where you reproduce the journal-readability edge the supervisor is hardened against -- the token still reaches stdout when the user cannot read the unit journal (a uid below `SYS_UID_MAX`, or a user outside the `systemd-journal`/`adm` groups), because the supervisor reads the persisted token and emits the marker itself rather than relying on the journal follow. `--service=systemd` is not reachable from CI (the runner has no systemd user manager), so this local flow is how you exercise it.

The macOS counterpart, `--service=launchd`, runs **natively** on your Mac -- no container needed. `chan devserver join --service=launchd` writes `~/Library/LaunchAgents/app.chan.devserver.plist`, bootstraps it into your `gui/$(id -u)` session, and emits the same `CHAN_DEVSERVER_TOKEN=` marker on stdout; inspect it with `launchctl print gui/$(id -u)/app.chan.devserver` and tear it down with `chan devserver stop --service=launchd` (which boots it out and disables it). Like `--service=systemd`, it is not reachable from CI (the runner has no GUI launchd domain), so exercise it locally.

### Running a local devserver beside chan-desktop

A foreground devserver started on the same machine with the default environment shares `~/.chan` with chan-desktop. That means both processes read the same workspace registry and contend on the same per-workspace writer locks. If chan-desktop is already serving a workspace, the devserver's launcher should show that workspace as locked, not off; turning it on from the devserver would be a second writer and is refused until the desktop turns that workspace off.

Use a separate `CHAN_HOME` when you want the devserver to have an independent library for PWA or launcher testing:

```sh
rm -rf /tmp/chan-devserver-home && mkdir -p /tmp/chan-devserver-home
CHAN_HOME=/tmp/chan-devserver-home \
  ./target/debug/chan devserver run --service=none --bind 127.0.0.1 --port 8787
```

`CHAN_HOME` replaces `~/.chan` for that process: registry, devserver config, per-workspace metadata, locks, tokens, and `CHAN_HOME/.local/bin/{chan,cs}` shims. The override also propagates into the systemd and launchd devserver service definitions when those backends are started from an environment carrying `CHAN_HOME`.

## Smoke-testing chan-desktop in isolation

The built macOS `.app` (`make chan-desktop` produces `target/release/bundle/macos/Chan.app`) reads and writes your **real** `~/.chan` library and, on a plain launch, hands off to your **real** running chan-desktop. To exercise a dev build without disturbing either, run it from a terminal with a throwaway `HOME` and `XDG_RUNTIME_DIR`:

```sh
rm -rf /tmp/chan-smoke /tmp/chan-smoke-xdg && mkdir -p /tmp/chan-smoke /tmp/chan-smoke-xdg
HOME=/tmp/chan-smoke XDG_RUNTIME_DIR=/tmp/chan-smoke-xdg \
  target/release/bundle/macos/Chan.app/Contents/MacOS/chan-desktop
```

Why each piece matters:

- **`HOME=throwaway` redirects the whole library when `CHAN_HOME` is unset.** chan resolves `~/.chan` from `$HOME` -- config, state, cache, workspace registry, and window state all live under `$HOME/.chan` -- so a smoke instance under a throwaway `HOME` never touches your real workspaces, window registry, or settings. `CHAN_HOME=throwaway` is the narrower override when you want only chan's home redirected without changing the process home.
- **`XDG_RUNTIME_DIR=throwaway` redirects the discovery socket.** A plain launch hands off to an already-running chan-desktop through a per-user discovery socket: `$XDG_RUNTIME_DIR/chan-desktop.sock` when that variable is set, otherwise `$TMPDIR/chan-desktop-<uid>.sock` on macOS (which has no `XDG_RUNTIME_DIR` by default). Pointing `XDG_RUNTIME_DIR` at a throwaway dir moves the socket there, so the smoke instance neither hands off to nor collides with your real desktop.
- **Start it from a terminal, not a Finder/Dock double-click.** A GUI launch ignores your shell environment, so the `HOME`/`XDG_RUNTIME_DIR` overrides only take effect when the binary is started from a shell.

### Driving the smoke instance from the CLI

On boot chan-desktop installs its `chan` and `cs` shims into `$HOME/.local/bin` -- under the throwaway `HOME` that is `/tmp/chan-smoke/.local/bin`. Drive the smoke instance with *that* `HOME`'s `cs`, so the command resolves the smoke library's sockets rather than your real one's:

```sh
HOME=/tmp/chan-smoke /tmp/chan-smoke/.local/bin/cs terminal list
```

It is the same `cs -> chan-desktop` symlink the cs-alias verify above covers, installed into the isolated `HOME` instead of your real one.

### Reproducing the restricted GUI PATH

A Finder/Dock launch runs under launchd's restricted `$PATH` -- no `~/.local/bin`, no `/opt/homebrew/bin` -- which is the environment in which cs-detection has to find `cs`. Reproduce it from a terminal by stripping `$PATH` to the launchd default:

```sh
PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/tmp/chan-smoke XDG_RUNTIME_DIR=/tmp/chan-smoke-xdg \
  target/release/bundle/macos/Chan.app/Contents/MacOS/chan-desktop
```

chan-desktop resolves your real login-shell `$PATH` at startup (it runs your login shell and reads back its `$PATH`), so cs-detection still locates the shim under the stripped environment -- which is exactly what this variant exercises.

### End-to-end: connect the isolated desktop to a lima devserver

Run a devserver in lima/sdme as in the Devserver section above -- a smoke does not need `--service=systemd`; a foreground `chan devserver run --bind 127.0.0.1 --port 7777` in the container is enough, and it prints the `CHAN_DEVSERVER_TOKEN=<token>` marker on stdout (the same marker the desktop control terminal scrapes). sdme containers use host networking and lima forwards the VM's loopback ports, so the devserver is reachable at `localhost:7777` from macOS (the reachability the Prerequisites note above describes). In the isolated chan-desktop, add a devserver pointed at `http://localhost:7777` with that token; the desktop connects directly over the bearer, no scraping. If you instead expose the container with a published port (`sdme … -p`, which is DNAT rather than host networking), lima does not observe the mapping -- bridge it with `ssh -F ~/.lima/default/ssh.config -N -L 7777:127.0.0.1:7777 lima-default` and point the desktop at the forwarded `localhost:7777`.

## Gateway: Postgres-backed tests

The gateway is a separate workspace with Postgres-backed integration tests. Its container setup (a `chan-psql` Postgres rootfs) and the test commands live in [`gateway/docs/dev-setup.md`](../../gateway/docs/dev-setup.md).

The gateway's per-change test loop runs `cargo` + `npm` **on your host** against the `chan-psql` container at `localhost:5432` (host networking makes it reachable). That inner loop needs Rust + Node on the host; only Postgres lives in a container. Binding the source into a container instead does not help here: lima mounts `/Users` read-only, so `cargo`/`npm` could not write `target/`, `node_modules`, or `web/dist`. The in-container flows on this page (the core gate above, the packaging validation below) are for CI parity and deploy validation, not the inner loop.

## Packaging: validate a deploy locally

The gateway ships five `.deb` packages run under systemd. To verify the prod path (packages -> postinst user -> systemd units -> `configure.sh` -> running services) end to end, build and install them in a systemd container with a reachable Postgres (the `chan-psql` container from the gateway doc; host networking makes it reachable at `localhost:5432`).

```sh
# create a build container and seed the repo (tracked files only)
limactl shell default sudo sdme create --name chan-gw-build -r ubuntu --storage btrfs
limactl shell default sudo sdme start  chan-gw-build
git archive HEAD -o ~/chan-src.tar
limactl shell default sudo sdme cp ~/chan-src.tar chan-gw-build:/root/chan.tar

# drop into the container; everything below runs inside it
limactl shell default sudo sdme join chan-gw-build
```

Inside `chan-gw-build`:

```sh
mkdir -p /root/chan && tar -xf /root/chan.tar -C /root/chan

# build deps + the pinned toolchain. openssl + python3 are required by
# configure.sh (random secrets + password URL-encoding).
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential pkg-config libssl-dev curl \
  ca-certificates nodejs npm openssl python3
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
cargo install cargo-deb

# build the SPA, then the five .debs
(cd /root/chan/web && npm ci && npm run build -w @chan/profile)
cd /root/chan/gateway
cargo build --release -p profile -p identity -p devserver-proxy -p devserver-control -p admin
for c in profile identity devserver-proxy devserver-control admin; do cargo deb --no-build -p "$c"; done

# install (postinst creates the chan-gateway user + units + default env),
# generate config, start, and check health
dpkg -i target/debian/*.deb || apt-get -f install -y
bash ../packaging/gateway/scripts/configure.sh   # answers: PG user/pass/db, base domain, scheme, >=1 provider
systemctl enable --now chan-gateway-profile chan-gateway-identity chan-gateway-devserver-proxy chan-gateway-devserver-control
systemctl is-active chan-gateway-profile chan-gateway-identity chan-gateway-devserver-proxy chan-gateway-devserver-control
for p in 7001 7000 7002 7003; do curl -fsS "http://127.0.0.1:$p/healthz"; echo; done
```

`configure.sh` points `DATABASE_URL` at `127.0.0.1` for the answers above, so the `chan-psql` container must be running on the same host network. All four `/healthz` returning `ok` means the deb assets, the systemd units (which load the shared `domain.env` first), the generated secrets, and the devserver-gate wiring are all consistent.

## How this maps to CI

CI does not run `sdme`. GitHub Actions runs directly on its ubuntu runners with the deps installed natively; the `sdme` flow above is just the local way to reproduce that Linux environment on your machine. The two are deliberately separate setups.

- `.github/workflows/ci.yml` runs native Linux, macOS, and Windows build lanes in parallel. Linux builds and boots the release devserver and emits an AppImage; macOS emits and verifies an ad-hoc-signed `.app`; Windows emits an unsigned NSIS installer and boots the desktop binary as a devserver.
- The same workflow builds the direct `.deb`/`.rpm`, both AUR packages in clean Arch containers, COPR/PPA source packages, and the chan OCI image.
- `.github/workflows/gateway-ci.yml` runs the gateway gate directly on the runner against a `postgres:16` **service container** (not `chan-psql`) and separately builds all four gateway OCI images.

Local `sdme` is the fast loop; CI is the canonical lane (and owns x86_64).

## aarch64 Linux build note

chan does not compile for aarch64-linux out of the box: gemm-common 0.19 (a candle dependency) uses fp16 inline asm (`fmla .8h`) that the default `aarch64-unknown-linux-gnu` target lacks. On Apple-Silicon-hosted VMs (the lima/sdme flow above) the CPU supports it -- build with:

    RUSTFLAGS="-C target-feature=+fp16" cargo build ...

x86_64 (CI's lane) is unaffected.
