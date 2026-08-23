# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v0.96.0] - 2026-08-23

v0.96.0 publishes FreeBSD amd64 and arm64 as supported targets, makes the release pipeline build warm and in parallel instead of cold and serially, and restores keyboard focus to a terminal after macOS wake.

### Added

- **chan publishes FreeBSD amd64 and arm64 builds.** Every release carries `chan-x86_64-unknown-freebsd.tar.gz` and `chan-aarch64-unknown-freebsd.tar.gz`, statically linked binaries packaged like the Linux tarballs with `chan`, `LICENSE` and `README.md`, and `https://chan.app/install.sh` supports the FreeBSD target: the installer recognizes a `uname -s` of `FreeBSD`, selects the build matching `uname -m`, and downloads through the base system's `fetch` where neither curl nor wget is present. `chan upgrade` resolves the new target and `/dl/cli/latest.json` lists it. `aarch64-unknown-freebsd` is a Rust tier-3 target with no rustup standard library, so its release job alone builds on a pinned nightly with `-Z build-std`; the amd64 job stays on the repository's pinned stable toolchain. Reaching that point fixed what FreeBSD exposed in the workspace layer, all of it FreeBSD-scoped and none of it changing Linux, macOS or Windows behavior: the file watcher queues a rescan that resynthesizes the creations notify's kqueue backend drops, since that backend names only the first new entry per directory write, identifies a directory by inode and change time so a recreation onto a reused inode still reads as new, anchors every catch-up walk to a capability handle opened `NOFOLLOW` and `RESOLVE_BENEATH` so a directory swapped for a symlink mid-debounce cannot lead the walk outside the workspace, and opens one child at a time so a subtree that arrived whole cannot exhaust the descriptor budget, the descriptor probe reads the real `RLIMIT_NOFILE` and declines to trust a `/dev/fd` listing that a one-time probe shows is a devfs stub, and two cap-std assumptions that held only on Linux are corrected, so an `O_PATH` directory handle is reopened close-on-exec through `openat(dir, ".")` instead of procfs and a kernel-resolved `ENOTCAPABLE` is classified as the escape it is.

### Changed

- **The release workflow runs warm and in parallel.** The Rust caches are keyed per OS and architecture and shared between `ci.yml` and `release.yml`, with the three `make ci-*` jobs on `main` as their only writers, so a release branch or tag no longer fills the repository cache cap and evicts `main`'s entries: the root-workspace Release jobs restore a warm dependency cache instead of compiling two thousand crates cold, while the explicit-target musl and gateway jobs keep their own keys and stay off that critical path. The Linux and macOS artifact jobs start from `release context` alongside the validation jobs instead of behind them (publication still waits for both), the validation jobs install the prebuilt `tauri-cli` instead of compiling it, `macOS validation` selects the same Xcode the desktop package links against, the macOS CLI package builds the host target so it shares the cache, and the SSL.com CodeSignTool download retries. `make ci-windows` builds the web bundles once, before the release CLI, and `chan-server`'s build script no longer tracks a model bundle that does not exist: Cargo treats a missing `rerun-if-changed` path as stale on every invocation, so on every CI checkout and on any development tree without `make models` each cargo call recompiled `chan-server` and every crate above it (`chan`, `chan-desktop`) with nothing changed; and the `chan` and `chan-desktop` build-id scripts run `git status` without optional locks, so computing the `-dirty` stamp no longer refreshes `.git/index`, which those scripts also watch. A second `cargo build` is a no-op in a tree whose frontend has been built through the Makefile; `web/.chan-build-stamp` and its launcher twin are still watched while absent, so a tree that has never built the frontend still relinks `chan-server`. The release process records the cycle's run ids after the tag instead of re-cutting the GA commit for them, which removes a second full CI wait from every GA.

### Fixed

- **A focused terminal accepts keyboard input after macOS wake without switching tabs.** Host resume events and the wall-clock wake detector reassert keyboard focus only when the terminal still owns the active pane and no Find box, tab menu, Rich Prompt, survey, or external DOM surface owns input; renderer recovery and PTY reconnection retain their existing behavior.

## [v0.95.1] - 2026-08-22

v0.95.1 is a one-fix patch release from using v0.95.0: turning a workspace off on a gateway-registered devserver works from the launcher, and from `chan workspace close WS --on TARGET`, again.

### Fixed

- **Turning a workspace off on a gateway-registered devserver works from the launcher again.** The desktop's gateway arm sent both toggles to the devserver's launcher `/on` route, carrying the direct arm's `{on, force}` body that the route ignores, so an off re-mounted the workspace as a no-op: the launcher reported success, the row stayed on, and nothing surfaced as an error. The arm now posts the launcher's `/off` route with the `{force}` body its live-terminal guard reads, the same request the browser launcher sends, so the off lands and an unforced off of a workspace with live terminals still confirms and can be forced. `chan workspace close WS --on TARGET` against a gateway-registered devserver took the same arm and is fixed by the same change. Direct and ssh devservers were not affected.

## [v0.95.0] - 2026-08-21

The Linux AppImage and the Windows install self-upgrade the way the macOS app does, a workspace on a registered remote devserver is managed from the CLI, and the chan tree speaks the cs prefix grammar.

### Added

- **A workspace on a registered remote devserver is managed from the CLI.** `chan workspace serve WS --on TARGET`, `chan workspace close WS --on TARGET` and `chan workspace forget WS --on TARGET` (and the elevated `chan serve` / `chan close` spellings) mount, unmount, and forget a workspace on a devserver the desktop has registered and connected, where TARGET is the registered URL or launcher label exactly as `chan devserver ls` shows it and WS is a path on that machine. The desktop resolves TARGET and the workspace and refuses over guessing: an ambiguous label lists the candidates, a path that matches no registered workspace lists the ones that exist, and a registered but disconnected devserver points at `chan devserver connect`. `close --on` and `forget --on` keep the devserver's own live-terminal refusal. `--on` is distinct from `--devserver=<port|url>`, which keeps its local meaning: a port-shaped `--on` value and a label-shaped `--devserver` value are both refused with a pointer at the other flag. Without `--on` the three verbs behave exactly as before.
- **The Windows install self-upgrades.** chan-desktop installed by the NSIS installer checks `https://chan.app/dl/desktop/latest.json` on launch, downloads and verifies a newer installer in the background, and asks in the launcher whether to restart now; restarting drains the desktop, runs the installer passively, and relaunches the app. `chan upgrade` (and `--check`) from the install's `chan` shim drives the same updater through the running desktop (the shim's console `chan.exe` now routes its upgrade to the desktop it ships with instead of looking for a Windows CLI tarball that does not exist), launching `chan-desktop.exe` first when none is running; a handoff that finds the on-launch download already staged installs it instead of downloading twice. Every release now minisigns the installer with the updater key and publishes its `.sig`, and the desktop updater manifest gains a `windows-x86_64` entry. An install from an earlier release must be updated by running the new installer by hand once. Known limits, named honestly: the passive reinstall and relaunch are verified by the release build and signing, not yet on a Windows 11 machine; an install whose chan.exe is held by a running `chan devserver start --service=chan` daemon refuses to update until `chan devserver stop`; and the standalone Windows CLI zip is unchanged and has no self-upgrade.
- **The Linux AppImage self-upgrades.** chan-desktop run from its AppImage checks `https://chan.app/dl/desktop/latest.json` on launch and installs a newer release in the background, and `chan upgrade` (and `chan upgrade --check`) from the AppImage's `chan` shim drives the same updater through the running desktop: the `.AppImage` file is replaced in place and relaunched, so the `~/.local/bin/{chan,cs}` shims keep pointing at it. The two drivers serialize, so a `chan upgrade` that arrives while the on-launch check is already installing waits and then relaunches instead of replacing the image twice. Every release now signs both AppImages with the same minisign key as the macOS payload, publishes their detached `.sig` assets, and adds `linux-x86_64` and `linux-aarch64` entries to the desktop updater manifest. An AppImage from an earlier release has no Linux updater arm and must be downloaded by hand once; after that it updates itself. A Linux build that is not running from an AppImage answers `chan upgrade` with a clear not-supported message that names the AppImage (the refusal comes from the desktop; with none running the CLI still launches one to ask it), and distro packages (COPR, PPA, AUR, Nix) keep refusing in favour of the package manager.

### Changed

- **The chan tree speaks the cs prefix grammar.** Every level of `chan` resolves an unambiguous first-letters prefix the way `cs` does (`chan w ls`, `chan de status`, `chan w i r PATH`) and refuses an ambiguous one (`chan s`, `chan c`, `chan d`) rather than guessing; no spelling or alias changes, and `chan --help` documents it.
- **The release workflow's apt steps time out, retry, and fall back instead of hanging.** The Linux desktop jobs fetch with socket timeouts and retries, drop the runner image's azure mirror for one retry against archive.ubuntu.com when a fetch fails, and carry a 15-minute step deadline, so a stalled mirror is a fast red that a rerun clears rather than a hung release.

### Fixed

- **The AppImage's `chan` / `cs` shims run in the caller's directory.** The bundled AppRun chdirs into the mount, so `chan serve .` registered `/tmp/.mount_*/usr`; the shims now export `CHAN_CALLER_PWD` and the desktop restores it at boot (existing shims rewrite themselves on the next launch; a hand-run AppImage without a shim still starts in the mount).
- **`cs upload .` and `cs download .` work in a standalone window.** The standalone transfer leg normalizes the path lexically before signalling the window, so a `.` or `..` component no longer trips the desktop's native-transfer validator, while a symlinked path keeps the name the user typed; on Windows the native upload accepts an absolute filesystem target.
- **Enter mid-way through a list item splits it into two items** in the editor (ordered lists renumber, task items start unchecked, nested indent kept), so Enter-then-Tab breaks a long item up instead of leaving an unmarked line; a list-shaped line inside a fenced code block is left alone.
- **Windows paths no longer show the `\\?\` prefix.** Devserver workspace listings, the desktop's window titles and SPA workspace list, the VCS-parent refusal, `chan upgrade`'s printed binary path, and `cs terminal team`'s outside-the-workspace error all print the plain `C:\...` form, and a registry row an older build stored with the prefix is normalized when the registry loads; `chan ps` also enriches devserver-served workspaces on Windows again, which the prefixed path had silently broken.
- **The launcher's update dialog shows a command's string rejection** instead of `undefined`.

## [v0.94.0] - 2026-08-19

The CLI grammar moves to noun families, a standalone window gains drafts and Rich Prompt, gateway operators mint and revoke PATs through the app layer, extensions get a front-door guide, the `/api/files` alias is removed on the release its deprecation named, and the gateway's tunnel namespace renames from `usr.{domain}` to `proxy.{domain}`.

### Added

- **Drafts and Rich Prompt work in a standalone window.** New draft, New diagram, New slide deck, and Rich Prompt are no longer workspace-only: a standalone terminal window creates, edits, discards, and promotes drafts backed by a per-library store the embedder places (`~/.chan/Drafts` on a desktop host, `~/.chan/devserver/Drafts` on a devserver), so a same-machine pair stays disjoint. Discarded drafts land in a working flat trash with the standard 30-day sweep, and a discarded workspace draft is now a restorable trash entry instead of being destroyed by the next sweep. Workspace windows are byte-identical throughout.
- **Gateway operators mint and revoke PATs through the app layer.** Identity gains an operator revoke route (`POST /admin/v1/tokens/{token_id}/revoke`) with the same immediate tunnel and session cut as an owner's own revoke, operator revokes are audited as `revoked_via_admin` so an owner can tell them from their own, and the admin CLI's `token revoke` accepts the 202 the server actually answers. Host tooling no longer writes gateway tables: operator mints ride `POST /admin/v1/tokens` with a default expiry, so a permanent credential requires spelling `never` rather than happening silently.
- **Extensions have a front-door guide.** [docs/extensions.md](docs/extensions.md) explains how Chan uses extensions (the declaration, the handshake, the capability-path proxy, the sandbox), walks through building one against the in-tree echo fixture, codifies the `chan-ext-*` packaging convention the published extensions converged on, and is linked from a new Guides section in the README together with the configuration reference.

### Changed

- **The CLI speaks noun families with a pinned serve/close elevation.** The polymorphic `chan open` is gone: `chan workspace serve|close|forget` own the workspace lifecycle, top-level `chan serve` and `chan close` are the only elevated family verbs, and `chan devserver` holds server-side verbs (`run`, `start`, `stop`, `restart`, `status`, `join`, `rotate-token`) beside new client-side verbs (`register URL`, `ls`, `connect`, `disconnect`, `forget`) over the desktop handoff socket, so a devserver registration can finally be listed, dialed, and dropped from the CLI. There are no aliases and no deprecation cycle. One operational skew: a systemd or launchd unit installed by a pre-rename chan invokes `chan devserver` with no verb, which the upgraded binary refuses to parse; `chan devserver start` (or `restart`) rewrites the unit.
- **The gateway tunnel namespace is `proxy.{domain}`.** The tunnel ingress dials `proxy.{domain}/v1/tunnel` and a devserver's public tenant origin is `{owner}--{disc}.{proxy}.proxy.{domain}` (for example `uk.proxy.chan.app` instead of `uk.usr.chan.app`). The scheme is configuration-driven, so the rename moves documentation, fixtures, and the shipped deployment values; there is no compatibility alias for the old namespace.

### Removed

- **The `/api/files` compatibility alias.** File content and transfers moved to `/api/fs` in v0.93.0 with the alias documented as removed in v0.94.0, and it is: both tenant route tables, the desktop native-transfer classifier, and the gateway transfer policy now serve `/api/fs` only, with refusal pins keeping the alias out.

## [v0.93.0] - 2026-08-18

File operations move to one `/api/fs` namespace reachable from every window kind, the Linux desktop AppImage follows its own driver decision when choosing the terminal renderer, and a long-standing intermittent test failure gets a named mechanism and a structural repair.

### Added

- **File operations use one `/api/fs` namespace rooted at the serving tenant's capability root.** A workspace tenant resolves paths from its workspace and a standalone terminal tenant resolves them from `/`. `cs download` and `cs upload` reach any path the shell's uid can access from a workspace window and a standalone terminal window alike, under the same readability preflight, atomic writes, admission bound and transfer ceiling in both. `/api/files` remains a compatibility alias in v0.93.0 and is removed in v0.94.0.

### Changed

- **A Linux desktop AppImage uses the WebGL terminal renderer where its driver supports the accelerated path.** The AppImage bootstrap already decides whether to keep WebKit off its dma-buf renderer, which it does for the NVIDIA proprietary driver, and the terminal renderer follows that same decision instead of refusing WebGL on every Linux desktop. The decision travels to the browser as a signal on the window URL, so a window served by a remote devserver makes the same choice as a local one. Other Linux packages do not run that bootstrap, make no decision, and keep the DOM renderer on every driver. macOS and Windows are unchanged, and `CHAN_LINUX_DMABUF` still selects the dma-buf behaviour by hand.

## [v0.92.0] - 2026-08-17

The gateway gets a canonical design, workspace terminals survive a devserver restart, and an intermittent stale-read closes as correct behaviour rather than a defect.

### Added

- **The gateway has one canonical design document.** `gateway/design.md` explains how a `chan-desktop` account discovers a gateway, signs in, receives a roster of owned and shared devservers, and enters a selected devserver through its exact proxy origin, alongside how each devserver publishes itself through an outbound tunnel. Four diagrams carry the deployment boundaries and the publication, account, and entry sequences. Every document under `gateway/` was checked against the running code rather than against its neighbours, which removed stale claims about automatic database migrations, ports and origins, one devserver per user, an admin service that is really a CLI, retired tunnel flags, and revocation and systemd behaviour that had drifted.
- **The dashboard About card shows the build id.** Two builds of one version are now distinguishable from inside the app, matching what the native About window already showed. The Apache 2.0 link left the card; the licence is in the repository.

### Changed

- **Mounted tenant routes answer 503 with a retry hint during startup.** While a devserver restores persisted workspaces, adopts inherited terminal sessions, and resumes parking, routes into a mounted workspace say to retry rather than failing outright. Root health and management routes stay responsive throughout, on the direct listener and through a gateway tunnel alike.

### Fixed

- **A terminal in a workspace survives a devserver restart.** Restoring inherited terminals ran before persisted workspaces were mounted, so a shared-terminal shell came back while a workspace shell was rejected and its process killed. Workspaces now mount first, and a shutdown that lands before parking resumes leaves the inherited terminals recorded rather than dropping them.
- **A terminal renderer no longer caches glyphs before its font has loaded**, so a freshly opened terminal renders in the font it was configured with.
- **"Graph from here" on a directory shows the files inside it.** A directory whose immediate children are all directories opened as folder bubbles with no file on screen, while the inspector beside it reported a file count for the same directory; the graph now opens deep enough to reach them. A workspace-scoped graph with the same shape is unchanged.
- **The About window ends with the margin it starts with**, and it scrolls rather than clipping when the window is too small for its content.

## [v0.91.0] - 2026-08-16

### Added

- **A standalone terminal window browses and edits the machine's files.** A window opened without a workspace now carries a file browser and the editor, over the server machine's filesystem, with no registry row, no lock, no index and no graph behind it. The surface is deliberately narrower than a workspace: symlinks are inert rather than followed, deletes reach regular files and empty directories only, moves and copies refuse to clobber, and your home directory is protected as the window's start directory. What a window can do is decided by its capabilities on the server, so a workspace window does not gain this and a files window does not reach workspace-only routes.

- **`cs window new` opens another window like the calling one**, and `cs terminal new --path` starts a terminal where the files are.

- **Terminals open on a shell you pick, on Windows.** The server lists the shells the machine actually has -- PowerShell 7, Windows PowerShell, cmd, Git BASH and every installed WSL distribution -- and the pane's New terminal menu offers them. macOS and Linux discover nothing and keep using your login shell, because that is already the system-wide answer there; the picker stays out of the way unless you declare profiles yourself. Each profile carries its own argument convention, so a login shell, `-NoLogo` and a WSL one-shot are each spawned the way that shell expects. A tab keeps the shell it was opened with across restart, server restart and reload.

- **`[[terminal.profiles]]` in `server.toml`** renames a discovered shell, replaces its arguments, hides one you never use, or adds one discovery cannot find, and `terminal.default_profile` chooses which one new terminals get. A malformed entry costs you that entry and nothing else in the file.

### Changed

- **`cs open` on a path outside your workspace opens it instead of refusing.** The path is routed to a standalone window, reused if one is already open, and a burst of opens fills one window rather than minting one per file.

- **AUR publication is restored.** It was suspended from 2026-08-06 while Arch Linux restricted package pushes during the AUR malicious-packages incident; the AUR re-enabled pushes on 2026-08-11, and a GA release publishes both pkgbases again.

### Fixed

- **A tab dragged to another window arrives as itself.** Dragging a graph, file browser or dashboard tab between two windows of one workspace replaced it with an empty terminal and closed the original; it now moves, carrying its view state. Dragging a draft could discard or relocate the file mid-move, and no longer can: a move releases the tab rather than running the draft's save-or-discard flow. A window that cannot rebuild what it was handed now refuses the drop instead of accepting it and leaving the source to close.

- **A window with no workspace no longer offers, or tries to load, workspace-only things.** The file browser and the editor's details panel asked for code reports and inspector metadata that only exist on a workspace, so every selection made requests that could only 404 and then showed "report unavailable" where the section should simply be absent. "New Graph" and "Graph from here" are gone from the same surfaces for the same reason: the graph is built from the workspace index, so there was nothing to graph from.

- **Opening a file browser lands in the directory you asked for.** It expanded the ancestors and highlighted the target, so a standalone window -- whose root is the whole machine -- showed `/` with your home directory selected somewhere below it, and you had to walk down to it. A directory target is now opened; a file target is still selected inside its parent.

- **`chan open` no longer leaks the Windows `\\?\` verbatim prefix** from the serve root into the desktop window title.

## [v0.90.0] - 2026-08-14

The Windows execution release: server-spawned Windows terminals unwedged from ConPTY's own startup handshake, the workspace lock's holder record readable while held, chan.exe executed by CI for the first time, and the light theme made legible in the terminal and the empty-pane animations.

### Removed

- **The penguin-grid empty-pane animation is retired.** A session that had it selected falls back to a random animation from the registry rather than a blank pane.

### Fixed

- **Empty-pane animations are legible in the light theme.** Two defects stacked. The point renderers behind six animations blended alpha into the destination channel, and the premultiplied canvas then composited the page through every drawn pixel by a term that scales with page brightness: a subtle brightening of dense clusters on the dark theme, a washout toward white on light, which is why those six were the faintest of the family. The renderers now blend color only, pinning destination alpha at 1. Independently, the light-theme intensity variables of eleven animations sat well below their dark counterparts even though ink near white needs more, not less, contrast to read equally; they come up to visual parity, with the dark values untouched, verified by a dark/light screenshot sweep of the whole family.

- **The light terminal darkens under-contrast text to a readable floor.** Agent CLIs print truecolor secondary text tuned for dark backgrounds: hints and summaries at `#999999` (2.85:1 against white), selected menu options at 1.9:1, warnings at 1.6:1, and the 16-colour palette cannot reach truecolor to correct them. The light xterm terminal now sets a minimum contrast ratio of 4.5 (WCAG AA), which darkens only foregrounds under the floor: a measured `#999999` renders as `#6e6e6e` (4.6:1). The dark theme keeps the identity ratio and renders pixel-identically, and the ghostty backend, which has no equivalent option, is unchanged.

- **Windows terminals run their command instead of hanging at startup.** A terminal spawned server-side on Windows could sit forever with a four-byte scrollback, ConPTY's own startup cursor query and nothing else: conhost emits `\x1b[6n` before it pumps the child's output, every Windows shell is gated behind it (powershell.exe and cmd.exe deadlock identically), and nothing in a server-side spawn answers until a frontend attaches. This is exactly the Team Work spawn shape, where the agent shell is created before any frontend exists and the SPA suppresses replayed replies on reattach, and the headless-server and headless-test shapes. The library now answers the query itself: the reader arms a pending query and the controller replies `\x1b[1;1R` on its existing 25 ms tick, after a grace in which an attached frontend's own report wins, so the real cursor position stays authoritative in ordinary interactive use. Verified on real Windows 11 end to end through the same terminal-create call the team dialog makes: v0.89.0 never ran the command in 25 s, this release runs it in 2 s, and a frontend answering with distinctive coordinates is consumed by ConPTY with the library writing nothing.

- **`chan ps` and `chan close` recognize a served workspace on Windows.** Every read of a workspace's lock holder record returned None on Windows, and had since the lock existed: `LockFileEx` is a mandatory byte-range lock, and the record was stored in the body of the locked file, readable by no process while a holder existed, the holder included. So `chan ps` showed blank BY, PID and SINCE columns for a served workspace, `chan close` reported it as not served, launchers showed chan's own workspace as taken by someone else, and reopening a workspace chan already had open read as locked by another process. The record now also lives in a `writer.json` sidecar that carries no lock, written atomically so a racing reader sees a whole record; the lock body keeps a copy fed from the same value, so an older chan on the same box still reads a record a current one writes and a current chan still reads a lock dir an older one wrote. Reads prefer the body, which every holder rewrites inside its own tenure, and fall back to the sidecar only while the body is unreadable; the holder removes the sidecar on release, and a sidecar-sourced record never authorizes stealing a lock, so a crash leftover cannot shadow a live holder or unlink its lock. Unix behavior is unchanged.

- **Terminals spawned from the Linux AppImage get the host environment, not the bundle's.** The AppImage runtime and its GTK hook redirect loader and toolkit variables into the ephemeral `/tmp/.mount_*` squashfs before chan-desktop starts. The GUI needs them; a spawned shell must not inherit them: system binaries resolved against the bundle's older libraries, `xdg-open` came from the bundle, `GDK_BACKEND` pinned GTK children to XWayland, and a `PYTHONHOME` with no stdlib aborted anything embedding CPython from a login shell. The host environment is reconstructed at spawn: variables are matched on whether their value hides the mount rather than against a list of names, so a plugin exporting a new bundle-scoped key is caught without a list to update, and search paths the runtime prepends to are filtered entry by entry so the shell can still resolve commands.

- **A reverse tunnel survives fd pressure on the desktop.** An accept error on the desktop listener broke the client run loop and closed the control socket, which the devserver rightly reported to the blocked `cs tunnel` as the desktop dying. Under fd pressure accept fails with EMFILE while every established socket keeps working, so a transient starvation spike tore down a healthy tunnel. Accept errors now follow the policy of axum's serve loop, which the devserver end already rides: connection-class errors retry immediately, everything else retries after a 500 ms pause so a starved process never spins hot. Proven by running the e2e suite under `ulimit -n` 88 to 112.

- **macOS terminal spawn absorbs a transient openpty refusal.** On macOS `openpty` fails with ENXIO both when the pty pool is exhausted and transiently under concurrent open/close churn, where the very next attempt succeeds. The spawn path now retries a refused openpty on a short bounded backoff (10/20/40/80 ms), so churn is absorbed within a beat while a genuinely exhausted pool still fails with the original error.

- **The CLI runs on a stack the binary sizes itself.** A debug-profile `chan.exe` died at startup on every invocation, `--version` included: the MSVC linker reserves 1 MB for the process main thread and the future the CLI polls does not fit in 1 MB unoptimized. The release build happened to fit, so the shipped binary was fine, but the limit is a cliff one future-sized change away from reaching the published artifact as a startup crash. `main` now spawns the CLI on a thread with an explicit 8 MiB stack, the size Linux gives a main thread by default, and joins it, resuming a panic's unwind so the process still dies with the panic's status.

## [v0.89.0] - 2026-08-12

### Added

- **The graph's node colours are configurable.** The eight node-kind hues had no setting and never had one: a read-only swatch legend shipped in May, its only render site was deleted in July, and what remained was a `HybridGraphConfig` component that nothing mounts and a release note describing a colour legend that no longer exists. Each hue is now settable per colour scheme through `editor.graph_colors.{dark,light}.*` with a mode key, mirroring the `terminal_colors` shape: sparse serialization, a whole-composite PATCH with per-hue hex validation, and a client-side drop to the theme default for any hand-edited value, so a malformed hue never reaches a paint call. Overrides land on the graph surface alone, on `.graph-tab` and the portaled tab-menu bubble rather than on `:root`, so the file tree, kind chips, inspector, JSON tree and empty-pane carousel keep the theme palette. The default hues now have a single definition that the canvas, the tuner and the settings row all read, and the dead legend component is removed with its layout folded into the Appearance section.

- **Google Antigravity is a submit agent.** Google's `agy` CLI, the successor to gemini, joins Claude Code, Codex, Gemini, Kimi Code and OpenCode as a named terminal submit agent. A session launched as `agy`, `agy --continue`, or an absolute launcher path derives to `agy` with no `CHAN_AGENT` override, `cs terminal list` reports that identity, `cs terminal write --submit=agy` is accepted, and generated team bootstrap material uses the agy submit chord. The built-in encoding is bracketed paste followed by a carriage return, which was live-probed against the 1.1.12 CLI as the one delivery shape whose single-message guarantee does not depend on the CLI's burst-coalescing timing, so it is eligible for chronological notification batching. Whole-word matching recognizes bare, flagged and absolute-path launchers without matching a containing word such as `stagy`, and a `CHAN_SUBMIT_AGY` or `[agy]` override remains its own boundary. Gemini stays supported.

- **The slide deck's two chords are rebindable, and the assign dialog can swap a held chord.** The deck's present-windowed and present-fullscreen actions dispatched from one hardcoded `Enter` branch that no shortcut registry entry described, so a user who rebound `Mod+Enter` changed it everywhere except on a deck, where the muscle-memory chord kept firing the old action. Both actions are registry commands now, rebindable in the user's own config while the shipped `Mod+Enter` and `Mod+Shift+Enter` defaults stay. Assigning a chord already held by another command now offers to swap it, but only when the exchange resolves cleanly: the candidate must have exactly one holder and that holder must be a catalog command whose dispatch runs through the override layer. A chord held by two commands, or by a surface that binds it without consulting the override layer, is reported as a conflict with no swap offer, because swapping either one shipped a fresh persisted collision or moved a holder whose old chord kept firing while its new chord dispatched nothing.

### Changed

- **Settings is organised by concern, not by the app being configured.** The overlay grouped its rows so that configuring the terminal meant visiting Terminal for its font, size and scrollback and Appearance for its background, foreground, cursor, ANSI contrast and body theme, while the graph and dashboard had no section of their own and survived only as single rows inside Appearance. The sections are now derived from the command registry's own surface grouping, which has filed each theme command under its surface for longer than the overlay has existed, so each app's controls sit together and the browser side panes and editable secret masking surface where they belong. The per-machine and per-workspace rows are rebuilt on a shared set of settings-field primitives rather than each section holding its own layout.

- **ghostty is the terminal backend the Linux desktop defaults to.** The Linux desktop ships xterm.js's DOM renderer, which defers box-drawing and block characters to the resolved font; a font draws them at its own ink height, so chan's 1.2 line height leaves an unpainted scanline at every cell boundary, measured at 96.0% rule continuity and 95.2% block coverage against a 99.5% bar in the desktop's own webview and reproduced on a third independent host. ghostty draws those characters itself, measures 100% on every arm, and is the only backend that holds on both sides of the dma-buf switch, so the Linux desktop now defaults to it. macOS and Windows ship the WebGL renderer, which also measures 100%, and stay on xterm.js. The default is keyed on the server's platform, where the terminals run, and is a named serde default so an existing config file is not pinned to xterm.js by a bare boolean default.

- **Ctrl+Shift+W closes the tab off macOS, and window close moves to Ctrl+Alt+W.** On macOS `Cmd+W` closes a tab and `Cmd+Shift+W` closes the window. Off macOS chan declines `Ctrl+W`, which is readline delete-word in a focused shell, so the chord a Linux or Windows user reaches for to close a tab is `Ctrl+Shift+W`, and chan spent it on window close: it discarded the whole window, deleting its persisted session and letting the server reap its terminals. `Ctrl+Shift+W` off macOS now behaves as `Cmd+W` does on macOS and closes the tab, raising the same "still running, close anyway?" prompt every terminal already raises, and window close moves to `Ctrl+Alt+W`, the established off-mac substitute family, so the two commands never share a chord on any surface. On the connecting screen, where no command bus is listening, `Ctrl+Alt+W` invokes the window close directly instead of being swallowed.

### Fixed

- **Turbulent Oculus has a pupil again, not a hole.** The mask at its centre is a radius that cuts the pattern away and lets the pane's background through, and it shipped at twice the source sketch's figure, which swallowed the middle of the eye. The radius is now a fifth of what it was, so the dark centre reads as part of the pattern rather than as something missing from it.

- **Polar Drift holds its frame rate on Linux.** It was the last empty-pane animation still painting through a 2D canvas path: 9,999 `ctx.rect()` calls collected into one fill every frame, and up to four simulation sub-steps on a slow frame, which the browser GPU-accelerates on macOS and software-rasterizes on Linux. It now paints through WebGL2 like the rest of the family, drawing the field as `gl.POINTS` over a ping-pong framebuffer pair that reproduces the alpha-`fillRect` trail fade, 8-bit quantization included, and reusing one vertex buffer so a frame allocates nothing. The simulation is untouched, the per-axis stretch that fills the pane is preserved, and the frame's fade is applied once rather than once per sub-step. The v0.88.0 note that moved the rest of the family described the point cloud as the last 2D canvas path left; this one was missed.

- **Path containment fails closed when a path cannot be resolved.** On the workspace sandbox boundary a `canonicalize()` failure was answered three different ways across the functions that enforce containment, and one of them accepted an unresolvable parent as inside the root. A non-`NotFound` canonicalization failure is now treated as an unknown sandbox result and refused, missing-leaf handling walks only to a canonical existing ancestor, and the symlink-blind lexical fallback is removed, so the strict answer the rest of the file already used is now the only answer. The duplicated lexical-containment helper is bound to the workspace root through the graph walker, so a caller can no longer transpose its two path arguments. This closes finding F2 from the v0.88.0 workaround audit.

- **A failed reset no longer wedges the workspace behind a retryable error.** `perform_reset` took the tenant's workspace cell out of its lock near the top and put it back on only two of its eight exits; on the other six it returned an error with the cell still empty and nothing in the process ever restoring it, so from then on every request needing the workspace answered a `503` with `Retry-After: 1` reading "temporarily unavailable" and a permanently dead tenant reported that it was briefly busy, clearable only by a process restart. The cell is now reinstalled after a reset error, a failed reopen retries once, and watcher registration stays best-effort across the swap, so a failed reset leaves the previous workspace in place and reachable. A cell that is genuinely missing outside the reset window is now a permanent `500` without `Retry-After`, so an unrecoverable state stops advertising itself as retryable.

- **The chan home no longer collapses to the working directory.** `config_dir()` is the single authority for the chan home, and its fallback for an absent OS home was `PathBuf::from(".chan")`, a relative path, so when `home_dir()` returned `None` the chan home, and with it the workspace registry, the devserver state, the global config and every workspace's metadata, resolved against whatever directory the process happened to be running in. An absent home now resolves to a named absolute path, and the resolver takes its home and override sources through injected seams so the fallback is testable without mutating the process environment.

- **A killed terminal process is reaped.** Terminating a PTY child called `kill()` on a cloned killer and never waited on the child, so every kill, write-failure teardown and stop left a zombie process behind. The teardown now kills and then waits, reaping the child, and portable-pty is upgraded to 0.9.0.

- **A metadata import no longer looks like a permanent failure to concurrent requests.** The import took the workspace cell inside a helper that dropped the write guard on return, leaving the slot empty and the lock free for the whole drain, archive extraction, optional rescan and reopen, up to several seconds. Every concurrent workspace-facing route read that window as a permanent-looking `500` with no `Retry-After`, for a state that clears in seconds. The import now holds the guard across the whole operation, the same shape the reset path ships, so concurrent readers see the held lock as `Busy`, a `503` with `Retry-After`, and the permanent error is reachable only by a genuinely unrecoverable double-reopen failure.

- **A hand-edited invalid graph hue no longer silently fails every palette write.** `preferences.toml` is hand-editable and the server serves stored hues unvalidated but rejects the whole object with a `400` on any invalid hex, and the settings commit path spread the raw stored palette into every `graph_colors` PATCH, so one bad value failed every subsequent palette write while the optimistic buffer kept showing the change as applied. The outgoing body now passes through the same per-key drop the paint path applies, so a stored invalid hue is dropped from the PATCH instead of poisoning it, and an emptied palette collapses to an omitted scheme key.

- **`chan config get` reads a never-set graph colour key.** `chan config get editor.graph_colors.mode` and the sixteen hue keys bailed with "missing from the serialized schema" on any config that never set them, because the whole subtree is skipped from the dump when empty, taking the always-present mode field with it, and the reader had default fallbacks only for the optional range and enum kinds. Colour leaves now read as unset when absent and `graph_colors.mode` reads its serde default by consulting the same schema the write path uses to materialize skipped subtrees; the terminal custom-colour leaves ride the same fallback.

- **An out-of-range setting shows its clamp warning.** A number field returned before its commit callback whenever the committed value equalled the stored one, including when it got there by clamping, so a caller's out-of-range warning never appeared in exactly the case a user typed an out-of-range value onto a stored bound, or cleared the field at the minimum, such as the screensaver timeout. A clamped result now always fires the callback and only a genuinely unchanged, unclamped entry commits nothing.

- **AltGr character entry works on international keyboard layouts.** Windows delivers an AltGr keydown with both Ctrl and Alt set, so on layouts where AltGr composes text, such as US-International where AltGr+W types a character, the desktop key bridge's alt-branch chords swallowed the keystroke and `Ctrl+Alt+W` closed the window and discarded its session with no confirmation. The bridge now bails on AltGraph before any chord fires and without preventing the default, so the key reaches the webview; the bail is gated on Ctrl being set so an engine that flags macOS Option as AltGraph cannot break Cmd+Opt+I.

## [v0.88.0] - 2026-08-10

### Added

- **`chan ps` says what each workspace is doing.** The table reported a state and a pid, which was enough to see that a workspace was served and nothing about whether it was making progress. It now carries readiness, the generation triple, the required action, indexer status, queue depth, and the last event and settle times, all read from the surfaces that already computed them so the command cannot report a different truth than `/api/health` and `/api/index/status`. A workspace with no indexer renders those columns as absent rather than as zero. Diagnosing a workspace parked in recovery previously took a shell on the host, the management token out of the devserver config, a per-workspace token fetched over HTTP, and hand-read JSON from two endpoints.

### Fixed

- **A recovery pass no longer locks you out of the workspace.** While the index rebuilt, the boot overlay locked and the whole workspace was unusable, which was the only sane behaviour back when a stalled pass and a healthy one were indistinguishable. They are distinguishable now, so a pass that is progressing lets you in: the editor, terminal and file tree work throughout, and the rebuild is reported without blocking. Search is the one thing that genuinely needs the index, and it now says it is paused while the index rebuilds rather than returning an empty result set that reads as "no matches".

- **`chan devserver --restart` no longer destroys the tunnel registration.** A supervised devserver's systemd unit is the only store for its tunnel token, and the restart path could not read it back yet rewrote it anyway. Run from a devserver-spawned terminal, which inherits the token, the command was refused outright, and that refusal covered `--status` as much as `--restart`. Run from a shell without the token, it resolved no tunnel at all and rewrote the unit as a plain local devserver, destroying the only copy of the credential while appearing to succeed. The endpoint now resolves where it is used, so the supervised path reads `--tunnel-url` and the token back out of the installed unit, an explicitly passed token still wins so a rotated one installs, and a token with no resolvable endpoint fails by name instead of silently downgrading the service. `--no-tunnel` remains the deliberate way back to a local devserver.

- **The Nix-built desktop package reports a real build id.** `nix build .#chan-desktop` stamped `unknown`, because the flake hands the derivation a store source with no `.git` and the build script fell through to its git-less branch. The flake default is the desktop package, so `nix run github:fiorix/chan` was affected, as was the `chan` binary that same package ships and symlinks at `bin/chan`. Both now carry an id threaded down from the flake, and two builds from different commits are distinguishable by it.

- **Block characters fill their cell on the ghostty terminal.** Bar charts, gauges and sparklines came out banded: `█` and every partial block were left to the font, which draws them at the glyph's own ink height, so chan's 1.2 line height left an unpainted strip at each cell boundary. A block element is defined by the cell rather than by a typeface, so the whole U+2580..U+259F range is now drawn into the cell rectangle, with cell edges snapped to device pixels so two neighbouring cells meet on one edge instead of each antialiasing half of it. Shades paint at reduced coverage rather than as a dither, which would moire against the cell grid at some sizes and flatten at others. Box-drawing rules were already covered; the xterm.js backend still defers both to the font on the Linux desktop, where its custom-glyph renderer is off.

- **The terminal's Source Code Pro face loads.** The `@font-face` src was an absolute `/static/fonts/SourceCodePro-Regular.otf.woff2` while every tenant mounts under a single-segment slug, so the request resolved against the origin root instead, where the launcher root fallback answers with `index.html`. The face failed to decode with nothing to see: `font-display: swap` just kept walking the fallback chain, and the terminal came up in a system font that looked close enough to pass. The default build made it unreachable a second way, since the rust-embed bundle behind that path was gated on a cargo feature no build target set, leaving a runtime download from GitHub as the only way to populate it. The woff2 now rides vite's asset pipeline like every other asset, so the emitted URL is relative and resolves under any prefix, and it ships inside the SPA bundle with nothing to fetch and no feature to remember. The SIL OFL notice ships beside it, which is what permits bundling the face at all.

- **The canvas animations hold their frame rate on Linux.** They painted through 2D canvas paths that the browser GPU-accelerates on macOS and software-rasterizes on Linux, so the same code was smooth on the platform it was written on and sluggish on the one chan is developed on. The sixfold vortex filled a path of 30k 1x1 rects every frame; the hexagonal and fourteenfold blooms added roughly 20k point rects plus 6 to 14 rotated full-canvas `drawImage` calls; and the point cloud behind Lorenz Constellation, Rippled Duet, Striated Current and Twin Veil Dance collected 30k `ctx.rect()` calls into a single fill. All of them now paint through WebGL2 with their simulation and motion logic untouched, reusing vertex buffers so a frame allocates nothing, and the vortex and both blooms hold 60 fps on Linux where they did not before. One visible difference comes with it: overlapping points accumulate opacity where a single path fill painted each pixel once, which is the same shift the rotational field took when it moved first.

### Changed

- **The os-default terminal font resolves per OS.** One chain served all three platforms and named `"DejaVu Sans Mono"` ahead of the generic fallbacks, so Linux landed on whatever fontconfig installed first while macOS took SF Mono, and the same session rendered in a noticeably wider, squarer face on the two. macOS and Windows keep leading with their native mono. Linux leads with the bundled Source Code Pro, which is the one answer that does not vary by distro. `ui-monospace` sits behind it there: ahead of it, it resolves to the fontconfig monospace and the bundled face can never win. The Source Code Pro setting still promotes that face to the head of the chain on every OS, and no longer downloads anything to do it.

## [v0.87.0] - 2026-08-09

A flaky test turned out to be a production data-loss path: the write compare-and-swap trusted a filesystem timestamp that does not always advance, so an external edit landing inside that window was silently overwritten. That is fixed, along with a workspace that could park in `recovering` forever after a `.gitignore` write, desktop authorization landing on the profile page, a runtime build id for the devserver, `--submit` naming the chord instead of only asking for one, and the command launcher listing scopes completely and windows as targets.

### Added

- **A window's caption shows everywhere it is named.** The optional per-window caption rendered only in the launcher's own rows; the chan-desktop titlebar, the native Window menu, and the browser tab all dropped it. One shared helper now composes `Window N [caption]` for the launcher rows, both command decks, the OS titlebar, and the new per-window browser tab title. A caption edited while its window is open follows live on both surfaces: the window watcher syncs the OS title, and the library pushes a targeted frame down that window's own socket.
- **The command launcher lists windows as targets.** Computers had four sibling branches -- Focus, Hide, Show, Close -- each drilling into its own filtered copy of the same roster, so closing a window meant choosing the verb before the launcher would say which windows existed, and one window could appear in four lists. A single Windows branch now lists each window once, carrying whether it is open or hidden, and choosing one offers the actions that window can actually take: a hidden window is shown rather than focused, a control terminal offers no mutation the capability route would refuse, and a readonly grantee gets Focus alone. Typed search still reaches an action in one step.
- **A devserver build identifies itself.** `chan --version` and the health surface carry a build id alongside the release version, so two binaries built from different commits are distinguishable at runtime. Between release bumps the version string alone never told them apart, and an operator diagnosing through a tunnel had no way to confirm which build was answering.
- **Four actions the menu trim left unreachable are commands again.** Syntax highlighting can be toggled per tab (its setter had lost every caller while the flag stayed persisted and honoured, so a tab switched off in an older build could never switch back on); a graph reloads without reloading the window; a file reloads from disk; and a standalone terminal window can copy its `$CWD`, which was gated on a workspace root the copy does not need.

### Fixed

- **An external edit can no longer be silently overwritten.** The write compare-and-swap decided whether a file had changed underneath a session by comparing modification timestamps alone, and a filesystem timestamp does not advance on every write. An external editor writing inside the same non-advancing window as the token chan captured was read as no conflict, and the session's flush destroyed that edit with no banner and no trace. The swap now verifies the bytes the session last observed against the file before writing, and a disk it cannot read to check is treated as a conflict rather than risked. The same collision on the read side made the reconciler settle a genuine hand edit as chan's own flush echo, which is fixed with it. Two narrow windows stay open and are documented in the item: a session that has not flushed since seeding, and the echo path where the baseline and flushed tokens disagree.
- **Writing `.gitignore` no longer strands the workspace in `recovering`.** A watcher-driven scope-policy change parked a recovery pass that nothing was assigned to run, so the workspace sat behind a boot overlay that never dismissed and a status bar reading `workspace recovering` forever. The only escape was an out-of-band index rebuild call. The pass now has a driver, the same one its sibling path already used.
- **Desktop authorization ends on the profile page.** After authorizing a desktop, the browser landed on a bare local page reading "You can close this tab", off the gateway origin, with nothing indicating the sign-in had worked. It now returns to the gateway and lands on the profile page, signed in. The loopback listener stays neutral to a prober: a callback with no active flow answers exactly as it did before.
- **The Linux desktop app renders its windows again.** The Computers window and every terminal pane opened onto a blank card carrying only a mirrored screen name or a side letter. Both flip cards hid their back face with `backface-visibility: hidden` alone, and WebKitGTK, the engine the Linux app runs on, ignores that property on every element, pseudo or not, with or without `perspective` or `transform-style: preserve-3d`, on either axis, and regardless of `WEBKIT_DISABLE_DMABUF_RENDERER`. An opaque full-bleed face above the content therefore painted permanently. The back face is now gated on the turn actually running, and hands over to the content face at the easing's 90deg crossing rather than at half the duration, so neither face is ever shown mirrored. Chrome-based checks could not see any of this: Blink honors the property, so `scripts/e2e/webview-flip-render.py` measures the real engine instead.

### Changed

- **Choosing a launcher scope lists it completely.** The deck's five-row teaser applied inside a chosen scope too, so the Tab orb showed five of the fourteen commands a terminal registers, and category ordering put the generic tab rows ahead of the focused application's own. Toggle outline, Toggle details, Toggle style toolbar, Copy path to `$CWD` and roughly forty more were reachable only by guessing a search string, none of them with a chord. Only the root deck stays a teaser now, and the active application's commands lead its Tab scope. An extension tab contributes the commands that extension declares rather than every app-spawn entry.
- **`cs terminal write --submit` names the chord that gets applied.** The agent you named was discarded: the server derived the target's agent from the command it was spawned with and used that instead, so the value only shaped the error message. A session spawned as a shell whose operator then started an agent inside it derived nothing forever and refused every submit with exit 69, while a perfectly submittable agent sat at the other end. The agent you name now selects the chord, and the server reports a disagreement in the acknowledgement instead of overriding you. Naming the wrong agent therefore delivers the wrong chord rather than being corrected, and one chord is encoded per command, so target a mixed-agent group per session rather than by group.
- **Restarting a terminal asks only when there is something to stop.** The confirm is dropped once the shell has exited, where warning that the running process will stop was untrue; the command doubles as the old Start New Session there.

## [v0.86.0] - 2026-08-08

Extensions boot through the gateway for the first time, CLI terminals can spawn and repair agent-deriving sessions, archives respect the transfer ceiling, and the editor and the gate shed their nondeterminism.

### Added

- **`cs terminal team` honors the config's pane layout.** A config whose members carry `position` grid coordinates (what the Team Work dialog's split layout saves) surfaces as that pane grid instead of stacking every member as a tab in one pane, so a team spawned from the CLI comes up with the same screen layout the dialog builds. The target window must hold a single pane, the seed the grid carves; a busier window is refused before anything is written or spawned, naming the ways out: close the extra panes, pass the new `--tabs` flag to stack, or target a fresh window with `--window`. A member-free grid cell receives the seed pane's existing tabs, so the host terminal that ran the command keeps a pane of its own instead of hiding behind the lead; with every cell occupied it stays stacked in cell 0. An explicit `--pane` names the seed and skips the single-pane requirement, a windowless caller spawns unsurfaced as before, and validation caps the derived grid at 9 panes. The surfacing push also carries the registry-settled tab name, so a second copy of a live team titles its tabs `@@Lead-2` exactly as `$CHAN_TAB_NAME` reports them.

- **`cs terminal new` and `cs terminal restart` take `--command` and `--env`.** A terminal spawned or relaunched from the CLI can carry the command and environment that derive its submit agent, so a single session is pokeable without provisioning a team, and a live shell tab can be repaired into an agent session by restarting it with overrides. Identity stays fixed at spawn and server-derived; a session without the flags derives nothing, and an ungranted submit still refuses loudly with exit 69.
- **A chan-desktop build identifies itself.** The About window carries the specific build id alongside the version, so two builds from different commits are distinguishable at runtime; between release bumps the version string alone never distinguishes them.
- **A desktop advertises its native vocabulary.** A gateway-served page can query which native commands the running desktop grants and suppress affordances the host does not carry, instead of discovering a missing command through a thrown refusal; the refusal interpretation remains the only mechanism for builds predating the query.

### Fixed

- **Extensions boot through the gateway.** The gateway admits the extension capability path shape without the tenant session cookie, so the sandboxed extension iframe's cookieless module-script fetches reach the devserver whose per-process capability check authorizes them; extensions previously rendered their shell and never booted on any gateway-served window. Every response leaving the extension namespace, on both the devserver and the gateway, now carries CORS headers, so a sandboxed iframe reports true statuses instead of masking every failure as a CORS violation, and the capability segment stays out of both binaries' trace logs.
- **Extension tabs converge after a devserver restart.** The extension catalog re-resolves on watch reconnect and mounted frames re-navigate to the freshly minted capability, so a window that outlives a restart returns to a working extension tab without a manual reload; a failed health probe during recovery retries instead of silently skipping.
- **Markdown fold ranges stop lying under load.** The fold helper's syntax tree now refreshes on tree identity rather than only on effects, closing a staleness path where a time-budgeted parse could return a fold range ending at the document instead of its real terminator; the three editor widget tests that flaked on this are deterministic, 60 isolated and 5 full-suite runs green on an idle host.
- **Archives respect the transfer ceiling on both arms.** An archive of a tree above the configured ceiling refuses up front when the plan can already see the bound exceeded and otherwise errors the response body at the bound mid-stream, instead of streaming to completion past the ceiling.

### Changed

- **The gw/usr gateway naming is used everywhere.** Every remaining `id.chan.app` / `devserver.chan.app` reference in docs, package metadata, systemd unit descriptions, test fixtures, and provisioning text uses the identity origin `gw.{domain}` and the tunnel namespace `usr.{domain}`.
- **The devserver connect log treats every gateway alike.** The CLI no longer special-cases the maintainer's tunnel terminator: the tunnel-connected line prints the identity-only form for every `--tunnel-url`, and no deployment host is compiled into the binary.
- **The desktop keychain account follows the identity origin.** Sign-in tokens are stored under `gw.chan.app`; an existing install prompts for one fresh sign-in to re-mint its PAT.

- **The empty-pane mark flashes instead of lingering.** The chan mark flashes in and out over the animation field on mount and on every animation switch, staying hidden while the animation runs; short panes keep dropping it entirely.
- **The pre-push gate executes gateway tests.** The database-free gateway suites run in every gate with the seven Postgres-backed integration files reported as not run, the gateway steps state which execute and which only compile, and the web lockfile check refuses npm older than 10, whose dry run destroys node_modules.

## [v0.85.0] - 2026-08-06

Large transfers are bounded by the server rather than by the browser: every transfer path now runs on a process-wide admission lane that never draws from the threads serving editor saves and terminal spawns, the 50 MiB compiled-in write limit is replaced by a validated configuration ceiling that also bounds terminal downloads, and a client past the queue bound is refused before its body is read. Terminal appearance settings reach standalone terminal windows, Hybrid Nav splits panes with the mouse, the file browser and inspector share one action source, chan-desktop opens library windows natively, and ghostty stops erasing the last columns it draws over.

### Added

- **Hybrid Nav splits panes with the mouse.** Dragging a pane divides each target into 25 percent edge zones plus a center; an allowed edge previews the half that will receive the grabbed pane's content, and mouseup stages a 50/50 split in the draft. A pane can split against its own edge, so a single-pane window splits by mouse, while a center drop on another pane keeps the existing content swap. An edge is refused rather than downgraded when either resulting pane would fall below 240 by 160 pixels; the gate measures the panes that would result, subtracting the 12 pixels of chrome a nested split costs on the main axis, so a row edge needs 492 pixels of width and a column edge 332 of height. Mouseup revalidates the target bounds so an edge armed before the pane shrank cannot land, hover and mouseup never mutate the live layout, and a draft going stale clears grab, hover, and preview together so no cue stays painted over a transaction that can no longer commit.
- **The file browser context menu and the inspector share one action source.** A capability-driven classifier decides which non-destructive actions apply to a path from its kind and the caller's capabilities, and both surfaces render what it returns, so a video reached by right-click now has the view and download entries the inspector always had. The two cannot drift apart by construction rather than by convention: they pass different capability sets for the same path and therefore legitimately show different rows, without either holding its own list. Ordinary-file replacement stays a tree-only action and is pinned directly.
- **chan-desktop opens and focuses library windows natively.** Two capability-gated commands mint a native-origin window record and raise an existing one, replacing a flow that depended on `window.open` and therefore did nothing in a desktop window. Both resolve the target library from the invoking window's own label, so a window reaches only its own library, and the workspace id is resolved to a path on the desktop side rather than accepted from the page. Hiding and closing another window depended on the same handle and are fixed with it. Browser tabs keep `window.open` unchanged.
- **Native desktop transfers respect the server's transfer ceiling.** Downloads and uploads read the server-reported effective cap and refuse work that would exceed it before writing, leaving no temporary file and an existing destination byte-for-byte intact. The cap has exactly one owner: an absent value means the policy is unknown, so the desktop enforces nothing client-side rather than inventing a default, and it is never treated as unlimited. What that costs depends on the path, because the URL does not say which tenant will answer: an upload is refused by the server on either tenant and a terminal download is refused by the ceiling on its route, so there the unreadable cap costs only the client-side fail-fast, while a workspace download is bounded by no server ceiling and the client-side check is the only one in the path.
- **`cs terminal list` shows queue depth.** The markdown table gains a `queue` column between `status` and `cwd`, reporting the logical messages still waiting in each session's write queue. A session whose server does not report the value renders `-` rather than `0`, so "not reported" stays distinct from "nothing pending". The JSON output already carried the field.

### Changed

- **Large transfers are bounded by the server, and the write ceiling is configuration.** Binary workspace writes were refused above 50 MiB; that compiled-in limit is gone, and the effective ceiling is `[transfer] max_bytes` in the registry, captured once when the library opens and reported to clients as one value, so no caller keeps an independent copy. Every transfer path now runs on a process-wide admission lane with two dedicated worker threads that never draw from the pool serving editor saves and terminal spawns: workspace and terminal downloads, workspace and terminal uploads, directory archives, and the copy batch. Two transfers run at once and thirty-two more may wait; the request past that bound is refused with HTTP 503 and `Retry-After: 1` before any body is read, which is not a transfer failure since nothing was read or written. A move is deliberately not admitted, because a rename plus a link-rewrite walk waiting behind two multi-gigabyte downloads inverts what the lane is for. The desktop binary's embedded `chan` runtime declares its own blocking-thread ceiling from the shared policy constant rather than inheriting tokio's much larger default, since a pool that large would let bulk work expand into the threads the lane exists to protect.
- **The browser renders the queue position the server assigns it.** It no longer counts slots, holds a queue, or promotes work: it starts what the user asked for, sends a window and transfer header so the server can report on it, and renders the rank it is given. A reported position is a rank among that tenant's own waiting transfers, so first means next among this window's work rather than next on the server, and the frame carries no path, filename, or content. Callers that cannot send the headers, including `curl`, MCP, and the SPA's direct download anchors, are admitted and bounded identically and simply show no position.
- **Bounded file slices are read on the consumer's thread.** `BoundedFileReader` no longer spawns a producer thread per read; it holds the open handle, seeks once at construction so a bad offset fails before any framing is derived, and reads each chunk inline. A short read still reports the shortfall rather than silently returning fewer bytes than the declared response or tar entry.
- **`chan config` accepts every key it prints.** The reader, the writer, and the dump derive from one key set, so a field added to the serialized configuration cannot reach the dump without reaching `get` and `set`. A test enumerates the serialized leaves and fails when one has no owner.
- **Tunnel bulk transport and gateway transfer policy are tuned.** Shared window constants replace per-crate values across the tunnel client, server, and protocol, and the gateway applies a distinct transfer class rather than its general request and response caps.

### Fixed

- **Terminal appearance settings reach standalone terminal windows.** A standalone terminal loaded its shell without ever fetching preferences, and a live configuration change was routed through a refresh path that returns early for terminal-only windows, so every preference read fell back to a default. Both boundaries are fixed together, since fixing either alone leaves the other broken. The effect is wider than appearance: the same source also drives scrollback, mouse capture, secret masking, the font chain, and the terminal backend, so a standalone terminal now renders whichever backend the setting selects rather than always xterm.js.
- **A transfer cancelled mid-stream fails its response instead of ending it cleanly.** Process shutdown cancels every active transfer, including one whose client is still connected and draining, so a cancellation was never synonymous with a departed client. Both download arms now forward an error that fails the body rather than returning silently. The workspace arm has already put a `Content-Length` on the wire, where ending cleanly answers 200 with fewer bytes than it promised; the terminal arm declares no length, where a chunked body ending cleanly is indistinguishable from a complete one and the shortfall is correspondingly harder to notice. When the client really is gone the forwarded error has nowhere to arrive and nothing changes.
- **A gateway-served page explains a withheld native command instead of quoting Tauri at the user.** The SPA decided whether to call a native window command by asking whether it was running inside a Tauri webview, which is not the same question as whether the installed app grants that command. A local window cannot tell the two apart, because chan-desktop embeds the bundle it serves; a gateway-served window is delivered by the remote devserver while the ACL gating its invokes belongs to the chan-desktop installed on the machine, so the two are independently versioned and the page can call a command an older app has never heard of. That surfaced as `Command create_library_window not allowed by ACL` in a dialog with a retry, against a failure retrying cannot change. Both native call sites now classify a rejection as the app withholding the command or as the command running and failing, and report them differently: a withheld command names the app as the cause, says a gateway window is driven by the locally installed chan-desktop which can be older than the page, and says retrying will not help, while any other failure keeps the handler's own reason rather than having it replaced by a guess about versions. The version cause is named as likely rather than certain, because a release build collapses every rejection shape into one string and cannot separate a command the app never had from one it grants but not for this window. Hiding and closing windows are unaffected: they run the scoped HTTP action and invoke nothing native.

- **Terminal downloads are bounded by the transfer ceiling.** The terminal download arm read to EOF against no bound, so a file larger than `[transfer] max_bytes` streamed in full while the desktop client documented a server refusal that did not exist on that route and a browser download carried no cap at all. A file whose open handle exceeds the ceiling is now refused with HTTP 413 before any header is sent, in a message naming both the size and the bound it passed, so the refusal costs one open and no streamed byte. The reader also counts bytes against the ceiling as they stream and fails the body if the file grows past it after the plan measured it, because otherwise appending to a file is enough to serve past the bound; it fails rather than ending cleanly, since a stream that simply stops is indistinguishable from a complete transfer. The response still declares no `Content-Length`: a ceiling is a maximum rather than a count, so a file may still grow freely below it, and the only length that could be declared is the one seen at open, which is the promise this path does not make. Two exclusions are deliberate. A directory archive stays bounded by lane admission and concurrency alone, because a tarball has no size until it has been built. A workspace download stays uncapped, because refusing a user a file already sitting in their own workspace fails toward denying them their own data rather than toward safety.

- **Ghostty viewport handling is stable under streaming output.** Ghostty writes and macOS pixel-wheel input route through one viewport controller. Anchored output preserves its relative position, bottom-follow stays at the live edge, and a trim or clear clamps the viewport. Primary-screen trackpad input uses synchronous scrolling and the xterm parity factor; alternate-screen mouse reporting and xterm behavior are unchanged.
- **Selected settings pills no longer switch their outer border to blue.** Checkbox pills and radio pills both keep their shape, spacing, neutral border, and selected background, and are distinguished by that background alone. A radio pill's selected dot and focus ring come from the native input rather than from the pill rule and are unaffected. Plain checkboxes without pill chrome are untouched. A hovered selected pill now renders the ordinary hover border instead of the blue one, which follows from the existing cascade and is intended.

## [v0.84.1] - 2026-08-05

v0.84.1 is a patch release whose scope came from using v0.84.0: a large graph no longer burns frames while idle or shakes after a click, deleted directories leave the search index, splitting a pane that hosts a terminal no longer wedges the window, terminal chrome follows a custom background, a devserver join detaches cleanly when its control input closes, and a chan-desktop window that cannot open names the real cause instead of blaming a browser popup blocker.

### Performance

- **A settled graph paints nothing, and selecting a node no longer disturbs the layout.** On a workspace rendering 3519 nodes and 12279 edges at the maximum depth, `onMouseDown` could not tell a click from a drag, so every press pinned the node and re-heated the simulation: a 150ms tap raised d3-force's alpha to roughly 0.05 and then needed about 170 ticks to settle, each rebuilding the charge and collide quadtrees over every node. Pinning and re-heating now wait for the pointer to pass the drag threshold that `onMouseUp` already used. The animation loop also painted every frame unconditionally, and the paint pass rebuilt its selection-derived inputs each time (the containment spine, the lit-overlay edge filter, and the per-kind edge buckets); those depend on graph structure rather than node positions, so they are memoised against the working set and the selection, a dirty flag gates the paint, and nodes and edges fully outside the viewport are skipped, with labelled nodes exempt because a label extends past its disc. Measured on the same workspace and gestures: idle paints over three seconds 196 to 0, paints from one click 412 to 1, and layout motion after that click 6606 ms to 0 ms. Dragging still moves and re-heats the layout, releasing still settles, and paged node loading is unchanged.

### Fixed

- **Deleting a directory removes its paths from search.** `Bm25Index::known_paths()` read each segment's path term dictionary directly, and Tantivy retains terms from deleted documents until a segment merges, so tombstoned paths kept answering user-facing queries after their directory was gone. Path terms are now verified against live postings through the segment's alive bitset when a segment carries deletions, and clean segments keep the term-only fast path. This also removes the segment-layout dependence that made `apply_watch_change_directory_delete_forgets_subtree` fail macOS validation on the v0.84.0 release tag; that run was finished with a job rerun, and the accessor is now fixed and pinned by a deterministic merged-segment test.
- **Splitting a pane that hosts a terminal no longer blanks the terminal and wedges the window.** The terminal tears down as its leaf is re-parented and its socket close walks the whole layout to unregister metadata. That walk runs inside the Svelte batch the split commits, where a torn-down branch reads pre-batch source values, so the new pane and split nodes enumerated as keys but read back `undefined`; `Object.values` handed out holes, `node.kind` threw, and the throw aborted the render flush, so the destroyed terminal was never rebuilt. The teardown now skips the holes, which is the layout-as-it-was view it wanted.
- **Terminal chrome follows a custom background.** The custom terminal colours added in v0.84.0 left the terminal body, host padding, viewport, and scrollbar track on the standard theme background, so a custom background rendered as a patch inside foreign chrome. All four now paint with the resolved custom background and fall back to the standard theme when custom colours are off. Appearance settings still do not reach a standalone terminal window; that is tracked separately.
- **A devserver join detaches cleanly when its control input closes.** EOF on non-TTY stdin is now a clean detach, so losing an SSH session or a control terminal can no longer leave healthy watchdog processes orphaned. TTY joins remain Ctrl-C-driven.
- **A chan-desktop window that will not open names the real cause.** The command deck's library flow depends on `window.open`, which returns `null` in every chan-desktop webview, and the failure was reported as a blocked browser popup even though chan-desktop has no popup blocker, sending the user after a setting that does not exist. The message now names it as a known chan-desktop limitation. Opening a library window from chan-desktop is still not supported; that repair needs new capability-gated native commands and is tracked for a later release. Diagnostics landed for it: refused `gateway_csrf_token` calls, which the ACL rejects before any handler runs and which previously left no trace on either side of the bridge, are now recorded in the webview with the origin and window and webview labels it presents and logged once per distinct record, and the desktop logs the `exact_origin` at mint time.
- **The disposable Nix build guest no longer fails on a world-writable temporary directory.** The guest set `/var/tmp` to 0755 before installing its packages, and a systemd tmpfiles pass during that install restored the `q /var/tmp 1777` default, so a newer guest Nix refused to build under it and `make nix-sdme-check` could not harvest a fixed-output hash. The mode is now applied after every tmpfiles pass instead of before.

## [v0.84.0] - 2026-08-05

v0.84.0 adds terminal and editor appearance controls, browser-native audio previews, and graph language detail; makes terminal metadata server-settled and secret masking opt-in; hardens Hybrid Nav collaboration; and adds reproducible Windows and Nix checks in disposable Ubuntu guests.

### Added

- **Terminal and editor appearance settings.** `terminal.font_size` joins `TerminalConfig` in `server.toml` as bounded integer pixels defaulting to `14`, and one captured value feeds ghostty, xterm, and the xterm cell measurement that keeps the two backends on a single cell grid. A renderer captures the value at construction, so a mounted renderer keeps its size and a renderer built later for the same PTY picks up the new one. An optional `editor_font_size` in `preferences.toml` applies live, driving `--chan-editor-body-size` and `--chan-editor-source-size` while inline and block code keep their existing `em` ratios, and `Use theme` clears it. Custom terminal background, foreground, and cursor colours persist as one atomic `terminal_colors` object with automatic or manual dark/light ANSI contrast; automatic resolves by WCAG relative luminance against a fixed `0.179` threshold, and the resolved contrast also drives the terminal surface chrome so padding, scrollbar, find bar, and canvas stay one surface. Standard mode renders exactly as before, the first Custom activation snapshots the currently resolved colours so nothing jumps, and unchecking Custom restores the prior `Inherit` / `Light` / `Dark` result while retaining the payload.

- **Browser-native audio preview, and `cs open` reveals non-text files instead of refusing them.** An existing non-text file opens a File Browser at its parent with the file selected and its inspector open, and raises a viewer when the SPA supports that type; `POST /api/open` inherits the behavior because both callers share `open_path`. `.mp3`, `.wav`, `.aif`, `.aiff`, and `.ogg` gain exact case-insensitive content types, an inline inspector player, and a dedicated viewer. Audio remains binary to `classifyPath`: it is a viewer capability, not a new file or wire kind. Neither surface autoplays, a decode rejection stays local to the media element rather than being recast as an open failure, and every close path tears playback down completely.

- **Hybrid Nav staged editor chips, and a fail-closed collaboration boundary.** Queued new-draft and new-diagram intents render as removable chips in the pane and side tab strip, after real tabs and in queue order, using the existing staged visual language. Each chip is a projection of the queue rather than a synthetic tab, so it never enters the draft layout, session persistence, active-tab selection, or staged-terminal cleanup. A shared layout change that touches pane inventory, nesting, split direction or ratios, tab inventory, order or placement, the active pane, side or tab, or a terminal's authoritative live name or group makes the transaction permanently stale: the focused pane shows `Layout changed. Esc to discard.`, every navigation and mutation is inert, and Escape is the only exit, after which the newest pending layout applies. Editor caret and scroll, inspector state, graph selection, dashboard rotation, terminal output, file content, and appearance preferences do not stale a transaction. A healthy commit applies the layout first, then runs every create request in parallel under all-settled semantics, so one failure cannot cancel siblings, roll back the layout, or orphan a created file; a create whose recorded destination has disappeared opens in the current pane and reports `Target pane disappeared; opened here.`

- **A Windows cross-check for the release checklist.** `make windows-cross-check` compiles and lints the release CLI for `x86_64-pc-windows-gnu` under `RUSTFLAGS="-D warnings"` inside a disposable Ubuntu `sdme` guest that installs its own Rust and MinGW toolchains, so any Linux host reproduces it with only `sdme` present. It uses a dedicated Cargo target directory and never takes the shared workspace lock. It is deliberately not part of `make pre-push`: that gate is host-native and Linux-only, so a green local gate is not evidence about Windows or macOS. The release cycle now requires both this check and the `publish=false` `release.yml` dispatch, which remains the only macOS compile available off a macOS workstation, before a GA tag. The cross-check compiles and lints only; `ci-windows` remains the authority on linking and smoking a Windows binary.

- **Graph language nodes expose delivery and directory detail.** Selecting a language node now shows its file and code totals, COCOMO effort and schedule figures, and a ranked directory breakdown. The first five directories render immediately, the remainder expands on demand, and selecting a directory graphs from that scope. The detail endpoint and graph layer share code-first then path ordering, including a stable `/` label for repository-root files.

- **Nix package checks run in a disposable Ubuntu sdme guest.** `make nix-sdme-check` snapshots indexed working-tree content under `/var/tmp`, mounts it read-only without Git metadata or ignored build products, installs Ubuntu's packaged Nix into a disposable overlay, and runs the existing flake evaluation, package build, and smoke contract against a local store. The only writable host bind is the selected `/var/tmp` result directory, and guest, source snapshot, store, and closure are removed after the result is returned.

### Changed

- **The Rich Prompt hint is an actionable control strip.** The primary button submits the current prompt and switches to cancel while a prompt is in flight. The secondary recall action appears only when this client has a queued prompt it can recover. Existing keyboard shortcuts and queue behavior remain authoritative, and the buttons call the same actions rather than creating a second submission path.

- **Terminal name and group are server-settled, and the session inventory agrees with the tab strip.** The registry is the only uniqueness authority: terminal WebSocket creation, POST and CLI creation, restart with overrides, and live metadata updates share one atomic settlement that normalizes the pair, reserves the name tenant-wide, and returns the complete settled pair even when only one input changed. A rename travels as one proposal over the terminal socket, both controls disable while it is in flight, and the settled result converges through the acknowledgement and the terminal roster, so co-viewing windows and `cs terminal list` describe the same terminal. Name and group are one interior-mutable value and are never read or published as a torn pair. Live metadata is distinct from spawn provenance: the name and group injected into a running PTY stay immutable for that incarnation, `TerminalSessionSummary` and `cs terminal list --json` always carry `spawn_name`, Markdown output always carries a `spawn` column rendering unknown as `-`, and fdstore persists and restores all four values, leaving a legacy manifest's spawn values unknown rather than fabricating them. Every by-name selector matches the settled live name only; neither a prior live name nor a spawn name is an alias. When live and spawn metadata diverge, one consolidated prompt names the stale variables and offers a restart.

- **Terminal secret masking is opt-in by default.** New configurations and configurations that omit `terminal.secret_masking` now resolve to `false`, avoiding the substantial replay cost on large terminal scrollback. An explicit `terminal.secret_masking = true` remains authoritative, and the existing context-menu switch enables or disables masking only for the mounted tab without persisting the choice.

### Fixed

- **Tests no longer inherit Chan terminal state.** The shared test harness clears the ambient `CHAN_*` namespace, installs a per-test `CHAN_HOME` under the test temporary root, and restores the exact prior environment afterward. The open/close integration cases no longer read a running terminal's home or write a devserver home into the source tree, and a tunnel-default assertion cannot render an inherited token in failure output.

### Removed

- **The unshipped Hybrid Nav staged-destructive-action proposal is withdrawn.** It never acquired an accepted action inventory, implementation, or compatibility surface. Destructive operations keep their established immediate action and confirmation flow; Chan does not add a second pending-intent path for the abandoned proposal.

## [v0.83.4] - 2026-08-04

v0.83.4 fixes the gateway-served desktop window regressions reported from live use: every mutating surface 403'd from chan-desktop windows connected through the gateway, and a remote reboot trapped windows in close and reconnect loops. It also restores reattach speed with secret masking on, recovers the Rich Prompt after a failed draft create, and restores keyboard paste on the Ghostty backend.

### Fixed

- **Terminal reattach replay is fast again with secret masking on.** The v0.83.0 masking feature wrapped every parsed write, replay chunks included, in a per-write masker capture and scan; a multi-MiB ring replay arrives as thousands of chunks, so masking turned a ~1.6 s reattach into minutes of main-thread work during which the terminal would not accept input. Replay-window writes now skip their per-write masker capture and scan, and the masker runs one whole-buffer scan once the replay drains; the writes themselves are unchanged, and live writes keep their per-write scan. A 2.1 MiB replay that took over 180 s with masking on now takes 2.8 s (1.4 s with masking off).
- **Desktop gateway windows can mutate again: the CSRF token no longer rides the WebView cookie jar.** The desktop installs `__Host-devserver_csrf` into the WebView cookie store natively, and WebKit attaches it to requests but never surfaces it to `document.cookie`, so the SPA's double-submit mirror sent no `x-chan-csrf` header and the gateway answered every unsafe method with 403: the Computers scope never opened ("This window was not granted library access"), the Rich Prompt mounted without its composer, `cs paste` hung waiting on a reply POST, and session and config writes failed silently. A new origin-scoped `gateway_csrf_token` command returns the live token to the exact `lib-*` window on the minted origin and nothing else; the SPA mirror prefers it and keeps the readable-cookie fallback for browsers, re-reading the token and retrying once on a 403 so mid-session rotation self-heals; and a session publisher installs fresh cookies into the shared store after every re-mint, so open windows no longer drift past the gateway's one-hour session cap.
- **Windows settle across a remote reboot.** Closing a devserver window during an outage now records a pending delete instead of unburying the record, so closed windows no longer respawn on the connecting screen in an unbreakable loop; the delete retries when the feed reconnects (bounded, then a launcher notice) and the suppression lifts only when the authoritative snapshot confirms the record is gone. The suppression is process-local by design, so restarting chan-desktop before the remote delete settles can still let the window come back once. The connecting probe classifies responses instead of accepting any status: gateway 502/503/504 and transport failures now keep the window on the connecting screen instead of navigating it away, and the probe carries the window's session cookies so an authenticated probe is not mistaken for an outage. A pending close-confirmation prompt auto-cancels on the disconnect and reconnect transitions, and the native close path raises and focuses the window before prompting, so the "closing will stop the shell" prompt can no longer strand behind newer windows.
- **The Rich Prompt recovers from a failed draft create.** A failed `POST /api/drafts/new` rejected an unguarded `onMount` await and left the bubble chrome-only forever with no error; the mount now surfaces the failure with a retry that recreates or reloads the draft.
- **Keyboard paste works on the Ghostty backend.** The custom-key wrapper's inverted contract made ghostty-web `preventDefault` the paste chord, suppressing the browser's native paste event on every origin; the chord now resolves a backend-aware result so Ghostty's own KeyV early-return passes the key through, matching xterm.

## [v0.83.3] - 2026-08-03

v0.83.3 removes the retired command-launcher overlay end to end and makes the wall-clock timing tests load-proof. (v0.83.2 was skipped.)

### Removed

- **The command-launcher overlay is gone, and the launcher chords are page-owned everywhere.** The desktop-owned `command-launcher` window was withdrawn before v0.83.0 shipped, but its host, permissions, chord claims, and frontend protocol stayed in the tree, and the native key bridge kept routing Cmd+K / Cmd+Shift+K to it on desktop while every other trigger opened the inline deck. The whole path is deleted: the Tauri host and its eight commands, the overlay capability and permission sets, the `?command=1` overlay mode, the source-submission protocol in both SPAs, and the bridge's launcher chord claims, so the SPA keymap opens the same inline deck on every surface. The transparent window was the only consumer of `macOSPrivateApi`, which is removed with it.

### Fixed

- **Wall-clock timing tests no longer fail under host load.** Two tests measured the host scheduler and could fail a gate run on a contended machine with no defect present. The shutdown-grace test now runs on tokio's paused clock, so its 100 ms bound holds exactly on any host while still catching a grace multiplication at exactly 400 ms virtual. The indexer recovery tests drop their rate ceilings for one 30 s convergence budget sized for real rebuild work; the 750 ms window that read scheduler load as a lost generation is gone, and a genuinely swallowed generation still fails with a clear message.

## [v0.83.1] - 2026-08-03

v0.83.1 makes the desktop render the command deck inline, the way the browser already did, instead of opening a separate Tauri overlay window.

### Fixed

- **The desktop opens the command launcher inline instead of in an overlay window.** `showCommandLauncher` routed Tauri desktop to a transparent, always-on-top `command-launcher` window while the inline deck ran only in the browser, so the two surfaces behaved differently and the overlay could be left on screen with no way to dismiss it. Every surface now renders the same inline deck. Three desktop short-circuits that deferred to the overlay are gone with it: the scoped library snapshot no longer returns early on desktop, its refresh poll no longer skips desktop, and the Computers scope is offered from loaded data rather than asserted from `isTauriDesktop`, so Computers actions resolve on desktop instead of appearing empty.
- **Escape releases a pending command instead of hanging the deck.** `pending` is the one operation kind with no button of its own, so a command left in the blocking "Working..." view could not be dismissed. Escape now drops the blocking view while the command it was waiting on keeps running.

## [v0.83.0] - 2026-08-03

v0.83.0 adds one searchable command launcher rendered inline by the SPA that owns the focused window, closes the gateway security review's remainder, masks secret-shaped values in the terminal, makes Kimi a named submit agent, gates the team spawn poke on terminal readiness, and accepts a lone port as a `cs tunnel` shorthand.

### Added

- **One command launcher across every Chan surface.** A single searchable command deck, rendered inline by the SPA that owns the focused window, replaces a different action set per surface. Authority follows the rendering SPA rather than being handed to the invoking page. Empty-query opens a contextual deck ordering focused tab, pane and window actions before Computers actions; typed search may jump across nested levels while still stopping at every required argument and confirmation.
- **Extensions v1.** A TOML-declared extension runs as a supervised subprocess behind an iframe tab, with host capabilities, declared commands, and a proxied endpoint. Discovery, subprocess supervision, and the tab surface land together; the extension's endpoint and token form their own trust domain rather than inheriting chan's.
- **`cs tunnel <port>` is shorthand for `<port>:<port>`.** A lone port after the bind-address peel is used for both ends. `cs tunnel 0` stays refused because the devserver end would have nothing to dial, and `1.2.3.4:8080` still fails as an invalid desktop port.
- **Kimi is a first-class submit agent.** `SubmitAgent` gains `Kimi` with its own measured chord rather than an alias, the command sniff resolves a bare `kimi` or an absolute launcher path, and the TypeScript mirror moves in lockstep. A team member running Kimi no longer needs `CHAN_AGENT="codex"` to receive a submit chord.
- **Terminal secret masking.** Values whose variable name looks secret are visually masked, driven by two config fields with a Settings surface and a per-tab toggle.

### Changed

- **The team identity poke waits for the member's terminal instead of a fixed grace.** `cs terminal team new` gated each agent's identity poke on a three-second sleep, so a member whose TUI was not yet in control of the PTY never received it: the bytes went to whatever program was foreground, the agent started with an empty compose box, and the round stalled while looking healthy. The poke now waits for the PTY to enter bracketed-paste mode, bounded, and a member that never signals readiness is named in the spawn summary and makes the command exit non-zero.

### Fixed

- **Gateway entry-path failures no longer reveal devserver liveness.** Method, Origin, Content-Type and the bounded one-field form are all validated before the registry is consulted, and every entry-specific 404 uses one JSON shape regardless of `Accept`. Previously two 404 constructors disagreed on whether they honored `Accept`, so an unauthenticated caller could distinguish "exactly one live devserver" from "none or several" by response Content-Type alone.
- **The identity SPA policy admits the avatar it renders.** The Content-Security-Policy blocked the OAuth provider avatar the profile page displays and deliberately never proxies; `img-src` now allows it, and the policy test asserts the literal string so a weakened policy fails.
- **A malformed `terminal.secret_mask_suffixes` entry no longer destroys `server.toml`.** An entry containing a character outside `[A-Za-z0-9_]` failed the whole config parse, the server fell back to defaults in memory, and the next settings write persisted those defaults over every other setting in the file. Invalid entries are now dropped with a warning and duplicates removed.
- **Terminal masking no longer rescans the whole scrollback on every write.** Once scrollback reached its cap, which is the steady state of any long-lived terminal, each PTY write triggered a full-buffer rescan. The matcher was also replaced with a linear scan after the generated pattern was measured backtracking quadratically.

## [v0.82.0] - 2026-08-01

v0.82.0 removes the whole-file read class from every HTTP read path, makes `cs tunnel` deliver every byte it read before closing, stops one failed assertion from aborting the chan-server test binary, makes the terminal engine visible and switchable, and retires the legacy devserver window endpoint.

### Added

- **Terminals report their engine, and the launcher switches it.** Every spawned PTY exports `CHAN_TERMINAL=xterm` or `CHAN_TERMINAL=ghostty`, recording the configured backend at spawn time, in workspace and terminal-only tenants alike; `chan dump-skill` documents it beside the other discovery variables. An existing child keeps the value it started with, while a newly created or restarted child samples the current preference. The terminal context menu opens with a non-interactive `Terminal engine` row that reads the post-load backend, so a session whose ghostty kit failed to load and fell back reports xterm. A Command Launcher entry in the Terminal category states the current value, is searchable by either engine name, and toggles the stored preference for newly opened terminals only.
- **`?download=1` supports range requests.** Binary responses advertise `Accept-Ranges` and a strong size and mtime validator, and answer first-byte, last-byte, and end-clamped ranges with correct 206 framing, so an interrupted large download resumes instead of restarting.
- **Nix ships a headless `chan` package.** The flake exposed only `chan-desktop`, so installing chan through Nix pulled the GTK and WebKit closure onto machines that never render a window. A `chan` output now builds the standalone binary alone, keeping both embedded SPA bundles, and the Cachix job publishes and pins both packages into the one cache. `nix profile install github:fiorix/chan#chan` gets the server; `default` remains `chan-desktop`.
- **Seven empty-pane animations.** Threefold Veil, Striated Current, Lorenz Constellation, Twin Veil Dance, Rippled Duet, Fourteenfold Bloom, and Hexagonal Bloom take the gallery from fourteen entries to twenty-one. Five render through two shared components, and Sixfold Vortex moves onto the same point-drawable path.

### Changed

- **A panic while holding a session or registry mutex no longer aborts the process.** The scene and document session state and registry locks, and the survey turn guard's queue lock, recover a poisoned guard instead of expecting it, so the server continues from whatever state the panicking writer left mid-update. This matches the recovery policy already used across the rest of chan-server. In the test binary it means one failed assertion reports itself as a single failing test rather than killing the run and hiding every other result.

### Fixed

- **Every HTTP read path is bounded.** Plain GETs of images, PDFs, and binaries with no recognized extension now stream through the same fixed-size reader that already backed `?download=1`, so peak resident memory no longer tracks file size: a 3 GiB file with an unrecognized extension serves with 1.7 MiB of resident growth, one extra thread, and one extra file descriptor. Directory downloads write each archive member from a bounded reader sized by its stat, file-browser copies stream into the atomic sink and refuse above their budget without leaving a partial destination or temp file, and incremental indexing stats a file and declines above the threshold before taking the workspace mutation lock, so a large file landing in a watched workspace no longer stalls unrelated renames. The editor's open limit and the indexing threshold are one server-reported value.
- **A transfer can no longer disagree with its declared length.** The representation is frozen from the open-handle stat: a file that grows mid-transfer is truncated to the declared length, and one that shrinks fails the body rather than completing short.
- **`cs tunnel` no longer truncates responses at EOF.** Bytes already read from either TCP endpoint now reach the peer before the data WebSocket closes. The byte pump completes an in-flight send or write instead of cancelling it mid-operation, the devserver drains its queued uplink frames after the splice ends, and the desktop joins its splice and WebSocket shuttle as one cancellation unit. Teardown, refused dials, and desktop disconnect still terminate immediately. The loss was never a size threshold: a 131,072-byte response failed 10 out of 10 attempts with zero bytes received, far below the channel's queued capacity, and a 2 GiB pull that lost up to 524,288 bytes per attempt now completes byte-identical.
- **A bracketed paste is no longer discarded during terminal replay.** The replay-origin filter dropped anything beginning with ESC, which silently included a complete bracketed-paste payload while leaving typed characters unaffected. It now recognizes a complete payload as user input and still suppresses terminal-generated replies, including unknown ones. A separate report of Cmd+V failing in the macOS desktop was not reproducible on Linux and is not addressed by this change.

### Removed

- **The legacy `GET /api/devserver/windows` endpoint is removed.** `GET /api/library/windows` is the only window feed. This supersedes the v0.81.0 note that the endpoint would stay one release as a compatibility adapter; a pre-0.81.0 desktop on Linux or Windows silently loses its Window-menu reopen entries.

## [v0.81.0] - 2026-07-30

v0.81.0 makes systemd devserver terminals survive every restart flavor, brings copy and View parity to images, diagrams, and slides, routes file-browser media gestures to the real viewers, keeps survey cards focused across tab switches, and adds Nix flake and Homebrew tap install paths.

### Added

- **Linux systemd devserver terminals survive restarts.** Terminal PTYs park continuously in systemd's fd store once they belong to a window, so `chan devserver --restart`, bare `systemctl --user restart`, watchdog recovery, and crash recovery all rebuild the same sessions with their ids and window placement intact. Explicit stop and `--restart --force` still terminate sessions through the authenticated drain endpoint before the unit transition.
- **Images, diagrams, and slides share one copy and View surface.** Image previews add pixel Copy PNG and source Copy SVG where applicable, Excalidraw embeds gain Copy SVG, and slide preview/play add hover View plus SVG/PNG copy chrome on the live overlay without changing document rendering or PDF export.
- **File-browser media gestures open the matching viewer.** Double-click or Enter routes images and SVG through the image viewer with same-directory navigation, video through the video viewer, and PDF through the PDF viewer; selection, inspector, and text-file behavior are unchanged.
- **Nix and Homebrew are first-class install paths.** The root flake exposes `chan-desktop` as the default package for x86_64-linux and aarch64-linux with `chan`/`cs` aliases and Nix-owned update behavior, and the `fiorix/homebrew-chan` tap serves a Chan Desktop cask plus a headless `chan` formula.

### Changed

- **The launcher window is named Computers.** Menus, titles, and docs use the one name consistently.
- **Empty-pane animations are more controllable and cheaper.** Arrow-key selection, a speed ladder, enso transitions, off-screen frame-loop suspension, and transient WebKit context recovery land across the catalog.

### Fixed

- **Survey cards keep the keyboard across tab switches.** Returning to a terminal tab with a pending survey focuses the card, not the PTY; option, follow-up, and dismissal keys never leak to the shell, and resolving the card restores terminal focus.
- **Browser dashboard entry passes the exact-Origin gate.** The gateway identity handoff sends `strict-origin` referrer policy so a browser's cross-origin form POST carries the Origin the devserver proxy requires; the CSRF validation itself is unchanged.
- **Closed, persisted devserver windows reopen from the desktop Window menu.** The desktop polls the authoritative library window feed; the legacy `GET /api/devserver/windows` endpoint stays as a one-release compatibility adapter for pre-0.81.0 desktops.

## [v0.80.0] - 2026-07-29

v0.80.0 adds owner-gated reverse TCP tunnels through a connected desktop, seekable video preview over bounded HTTP ranges, and safer terminal-agent delivery; it also brings Ghostty behavior closer to xterm.js and extends the empty-pane animation catalog.

### Added

- **`cs tunnel` forwards a desktop port back to a devserver.** A foreground `cs tunnel [bind:]desktop-port:devserver-port` asks the desktop that owns the invoking terminal window to listen on the desktop machine and relay TCP connections to loopback on the devserver host. Direct and gateway-attached devservers use the same owner-gated tunnel legs, and command lifetime owns teardown. UDP is parsed and refused explicitly; it is not implemented in this release.
- **Video files preview inline and in a fullscreen viewer.** MP4, WebM, and MOV files render with native controls in both file inspectors. `/api/files` serves media through the bounded reader with `Accept-Ranges`, single-range `206` responses, and honest `416` refusals, so playback can seek without buffering the whole file. MP3 gains the server range and content-type path but no audio UI yet.
- **Empty panes offer fourteen selectable animations.** Exponential Echo, Spiral Spokes, Mutual Force Starburst, Recursive Arc Bloom, and Chaotic Halo join the existing catalog, with the same session persistence, navigation, lifecycle, and reduced-motion contract.

### Changed

- **Submitted terminal writes end with exactly one newline before the chord.** The encoding funnel trims trailing newlines and appends one for every non-empty agent submit, while raw terminal writes remain byte-identical. Raw and submitted logical writes are capped at 4,096 UTF-8 bytes and a larger payload is refused rather than truncated; longer content belongs in a file whose path the poke carries.
- **Ghostty matches xterm.js terminal geometry and interaction more closely.** The opt-in backend adopts xterm-style measured cell metrics and continuous box glyphs, preserves scroll position across writes, and maps Shift+Enter to the same line-feed fallback as xterm.js.

### Fixed

- **Reserved usernames are enforced again for every entry.** The gateway's reserved-username list had drifted out of sorted order while its lookup is a binary search, whose result is unspecified on unsorted input, so some reserved names could be claimed as account usernames. The list is sorted again and a test now pins the ordering invariant.
- **Window status stays clear of a right-side file-browser dock.** The fixed status pill follows the live dock width instead of covering browser content, while terminal-only windows ignore persisted dock state.

## [v0.79.2] - 2026-07-28

v0.79.2 adds a library of selectable empty-pane animations, restores focus and physical-key routing across survey and terminal shortcuts, and makes diagram copying explicit and portable across browser and desktop surfaces.

### Added

- **Empty panes offer nine canvas animations.** A completely empty single pane chooses and remembers one of nine named animations, with `<` / `>` navigation and `?` random selection scoped to the focused welcome surface. The shared canvas lifecycle resizes with its pane, reacts to theme changes, and honors reduced-motion preferences.
- **Rendered diagrams expose explicit copy formats.** Mermaid and Mermaid-to-Excalidraw widgets offer separate SVG and PNG actions. PNG copy uses the native desktop clipboard bridge when present and the browser clipboard elsewhere.

### Changed

- **Diagram wheel zoom is four times gentler.** The overlay keeps the existing zoom bounds while applying smaller steps, making trackpad and wheel navigation less abrupt.
- **Decorative animation shortcuts stay below app shortcuts.** Empty-pane animation keys act only after the document-level shortcut path declines the event, and only while the welcome surface remains focused in a completely empty single pane.

### Fixed

- **Survey completion restores the originating terminal focus.** The survey overlay defers its focus claim past terminal refocus races and returns focus to the terminal that opened it.
- **Terminal shortcut escape follows physical-key routing.** Option-mangled and code-based web chords now reach the existing keymap consistently instead of being swallowed by the terminal surface.
- **Mermaid PNG copy works on WebKit.** Clipboard rendering avoids HTML labels that taint WebKit's SVG canvas conversion while leaving the visible diagram unchanged.

## [v0.79.1] - 2026-07-27

v0.79.1 is a fix release for regressions found in the field after v0.79.0: the Linux clipboard no longer loses a copy to its own paste, the ghostty terminal backend stops swallowing the macOS chords and the terminal width it was never entitled to, Windows `cs` runs the `cs` client again, a new terminal's PTY starts at the size it will actually be, and a `cs terminal write` that could not submit says so with its exit status. The command launcher also gains New window and Close window.

### Added

- **The command launcher offers native window lifecycle actions.** Desktop workspace and standalone-terminal launchers now include New window and Close window. New window opens another window for the invoking connection without claiming the host-owned shortcut; Close window shares the existing `Mod+Shift+W` chord. Web launchers remain unchanged.

### Fixed

- **New terminals open their PTY at the measured grid.** Terminal mounts synchronously fit both renderers before dialing, so width-sensitive startup output sees the real pane size instead of wrapping at 80 columns before the first resize.
- **Windows `cs` runs the `cs` client instead of the `chan` CLI.** The bundled console `chan.exe` ignored the `ARGV0=cs` signal written by both Windows shims, so it parsed `cs terminal list` as a `chan` command. The console parser now honors that signal on Windows, which is the only platform whose shims cannot hand a child its `argv[0]`, while retaining the shim's original argv for clap. macOS and Linux are unchanged: `argv[0]` stays authoritative there, so an inherited `ARGV0` cannot steer the alias. This defect dates to the introduction of the bundled console `chan.exe`, not to v0.79.0.
- **Linux clipboard reads keep the selection alive when a representation is absent.** Native text, image, and HTML probes classify unavailable content inside the cached operation, so an image-first automatic paste no longer discards the handle that owns a text selection.
- **Ghostty leaves unclaimed macOS Command chords to AppKit.** A capture listener keeps native window cycling and New Window accelerators out of Ghostty's encoder without suppressing their default, while chan-owned shortcuts and terminal clipboard chords keep their existing behavior.
- **Ghostty terminals use the full available width.** Their fitter no longer reserves 15 pixels for the auto-hiding scrollbar, which is painted over the canvas and consumes no layout space.
- **Ghostty's settings hint matches its lazy loader.** It now identifies the chan server as the engine source, the first ghostty terminal as the load trigger, and xterm.js as the fallback when loading fails.

## [v0.79.0] - 2026-07-26

v0.79.0 makes the chan gateway administrable as a product boundary without database access, collapses the native menubar to the launcher window off macOS, adds an opt-in ghostty-web terminal backend, and makes tab rotation cover both Hybrid sides of a pane.

### Added

- **The gateway is administrable without touching its database.** Users carry explicit enabled, suspended, blocked, and restored states, and a durable per-user connected-devserver limit is enforced across the proxy fleet. Control protocol v2 carries tunnel rows and redacted tenant browser-session rows in one snapshot and one contiguous delta generation, so a generation gap retracts both classes of authority and forces a full resync; tenant-session rows use a random admin UUID independent of the opaque cookie id. Session revocation cannot report complete while a connected command is unconfirmed, controller authority is warming, or a retained disconnected proxy authority is unreachable. An idempotent admin API lets an external account service push durable access policy, with operator use on `chan-gateway-admin` and machine use on the same scoped HTTP contracts. The contracts are generic gateway capabilities: no billing provider, product name, price, deployment topology, or consumer-specific schema is encoded.
- **ghostty-web as an opt-in terminal backend.** The new `terminal.ghostty` server setting (default off, with a Settings checkbox) makes newly opened terminals parse and render through Ghostty's WASM VT engine instead of xterm.js. The wasm and library lazy-load only when the toggle is on, and a failed load falls back to xterm.js. This is deliberately an alternative and never the default: find bar, styled scrollback snapshots, and external link routing stay xterm-only, and `terminal.mouse_capture` keeps working on either parser.

### Changed

- **Off macOS, only the Chan Launcher window carries a native menubar.** The app-wide default menu and the per-window-kind bars (the workspace hamburger mirror, the owned terminal and control shapes, the `wscmd:` and `ws-*` id namespaces) are removed; the launcher bar attaches per window and every other window is born menu-less. The chords those bars owned move into a per-window key bridge, so `Ctrl+Shift+N` opens another window of the invoking window's own connection, `Ctrl+Q` runs the same confirm-then-quit flow as the menu item, and `Ctrl+Shift+T` on a control terminal spawns a standalone terminal instead of toggling a tab it does not have. macOS is untouched: the global menubar still owns every chord there.
- **Account credentials and database roles are separate surfaces.** Identity configuration, packaging, and the kube manifests no longer share one credential surface, and the packaging test scripts gained database-role reconcile and isolation checks.

### Fixed

- **`cs terminal write --submit` reports a submit refusal as failure.** A write still enters the asynchronous queue immediately, but if any selected shell session has no server-derived agent and therefore receives no submit chord, `cs` preserves the full acknowledgement and exits 69 instead of reporting success. Mismatched named agents that the server corrects still exit successfully, and the help points callers to spawn the session with `CHAN_AGENT` set or with the agent as its command.
- **Next and previous tab rotate through the whole pane, not one side of it.** `Mod+Shift+[` and `Mod+Shift+]` (`Alt+Shift+[` / `]` on web) rotate a pane's full ordered tab set, side A in strip order then side B, flipping the visible side when rotation crosses the boundary. Rotation entered from an empty visible side lands on the first tab going forward and the last going back, so the chord is never dead in a state reachable by closing the last tab on the visible side. A pane with tabs on only one side rotates within that side as before.
- **The close shortcut on an empty pane side reveals the tabs instead of only pointing at them.** When the visible side has no tabs but the opposite side does, the pane now flips to the populated side and keeps the side-toggle flash that explains why it stayed open.
- **Two classes of test no longer fail on host load rather than on defects.** The self-write suppression tests take a caller-supplied instant instead of reading the wall clock inside, so a scheduling stall can no longer break a 20ms window; production behavior and every caller are unchanged. Browser check 62 replaced a no-slack 10 Hz coalescing ceiling with the coalescer's structural cap, which a loaded host can only satisfy more easily, and check 60 now skips on an absent launcher bundle instead of failing downstream.

## [v0.78.0] - 2026-07-26

v0.78.0 is a narrow correctness release: external filesystem edits that restore or shrink a file now converge in the open editor, and the Linux desktop clipboard survives a copy while generated supervisors keep pointing at the CLI instead of the GUI.

### Fixed

- **The editor converges on external edits that restore or shrink a file.** The doc- and scene-session echo ring records where each entry came from, so bytes chan merely *read* from disk no longer inherit the 60s replay protection meant for bytes it *wrote*. An external edit returning a file to content the session had already seen — the shape of every undo, revert, and `git checkout`, and of any agent editing through the filesystem rather than the MCP server — was previously classified as chan's own echo and held back; additions were unaffected, so the failure presented as "removals never reach the editor". Written bytes keep the full 60s window, adopted bytes get 1500ms, and the empty-read refusal now requires a recent write of the session's own to blame, so truncating a file chan never wrote converges normally. An external restore now reaches the editor in 28ms rather than 58.6s, and a truncation in 407ms rather than not at all. This closes the root cause that v0.76.0 had only bounded to a 60s window (browser check 57 now asserts prompt convergence; new check 63 covers shrink, restore, add/remove cycles, truncation, and refill).
- **A copy on Linux survives long enough to paste.** X11 and the wlr data-control protocol serve a selection from the owning client, but every clipboard operation created its own handle and dropped it in the same expression, so a `cs copy` owned the selection for microseconds and the paste target kept seeing the previous contents. The six native clipboard operations now share one process-wide handle on Linux, connected on first use and reused, so chan stays a real selection owner; a failed operation discards the handle so a dead X connection cannot poison every later operation. macOS and Windows keep a fresh handle per operation deliberately (NSPasteboard is server-side; opening the OLE clipboard on Windows locks other apps out until it is closed). `arboard` gains `wayland-data-control` on non-macOS unix, so Wayland sessions stop being served through XWayland.
- **The desktop window no longer freezes during a clipboard operation.** The six native clipboard commands ran synchronously on the Tauri invoke thread, and on X11 probing a target the selection owner never answers stalls for seconds — long enough that the window could not render the `cs paste` request card while it waited. Every platform except macOS (where NSPasteboard must be touched from the main thread) now runs them through `spawn_blocking`, with a process-wide mutex preserving the mutual exclusion the single invoke thread used to provide. The wait diagnostics also stop claiming a browser permission prompt is the only possible cause.
- **Generated systemd and launchd supervisors start the CLI, not the GUI.** chan-desktop dispatches the CLI only when invoked through a `chan` name, so a supervisor's executable basename is the personality selector. Distro packages ship `/usr/bin/chan` as a symlink to `chan-desktop`, and `current_exe()` on Linux reports the symlink *target*, so the unit writer persisted `ExecStart=/usr/bin/chan-desktop devserver` — a unit that launches the desktop GUI instead of the devserver (reproduced on Arch with the shipped 0.77.0 binary). Entry-point selection now prefers a `chan`-named `current_exe()`, then a `chan` sibling beside a `chan-desktop` binary, then the CHAN_HOME-aware local `bin/chan` shim, and deliberately does not canonicalize the result. The same resolver feeds the systemd and launchd writers and the `--service=chan` daemon re-exec, which had the same hazard; a desktop binary with no `chan` entry point is now a clear error rather than a supervisor that would launch the GUI.

## [v0.77.0] - 2026-07-25

v0.77.0 makes workspace lifecycle, persistence, and collaboration failures explicit and bounded: reset contention no longer blocks async workers, configuration and state writes serialize durably, hosted tenant shutdown awaits owned tasks, independent same-line edits merge, and a removed workspace root fails closed across the server and UI. The release also puts native desktop, distro, and container builds into the ordinary CI contract.

### Added

- **Workspace-lifecycle end-to-end coverage.** The owner-run scenario pack and browser smoke cover close and `close --remove` during startup, root removal during startup, and destructive root loss while the file browser, graph, and a dirty large editor are active.
- **Cross-platform build gates.** Ordinary CI now builds native Linux, macOS, and Windows desktop packages, direct Linux packages, COPR/PPA sources, both AUR packages, the chan image, and all four gateway images. Pre-push boot-smokes the release devserver and native Linux or macOS desktop package.

### Changed

- **Collaborative session state has one private lifecycle core.** Document and scene sessions share only their identical state and HTTP views; their merge engines, wire protocols, recovery payloads, and domain authority remain separate.
- **Workspace session blobs are opaque.** Workspace open no longer parses or prunes host-owned session JSON, and compatibility-only configuration, route, environment, launcher, and watcher paths are removed.
- **Editor recovery sidecars are coalesced off push acknowledgements.** Accepted document and scene pushes mark recovery pending for the existing flusher tick instead of awaiting recovery serialization and fsyncs before the acknowledgement can drain.
- **Generated desktop chunks have a cooperative 64 KiB contract.** The Rust command limit is pinned to both SPA chunk producers, while the documentation states plainly that Tauri materializes each JSON frame before Rust can reject an oversized chunk.
- **Team terminals yield only for actual queued work.** Generated team bootstraps require a real turn break when input is pending or a just-received burst may still be arriving, but direct an agent with an empty queue and a defined next step to continue instead of stalling.

### Fixed

- **Reset and configuration races are bounded.** Workspace reset returns retryable contention instead of blocking Tokio workers, terminal and devserver persistence use unique durable temporary files, dashboard updates serialize, and revisioned partial preference writes cannot silently lose another window's fields.
- **Hosted shutdown owns its tasks.** Normal shutdown cooperatively joins document, scene, terminal, and reconciliation work to one deadline, then aborts and awaits stragglers before clearing the workspace generation.
- **Independent edits on one line merge.** Bounded Unicode-scalar conflict retries merge non-overlapping inline edits while retaining genuine overlaps for explicit resolution.
- **Resolved collaboration conflicts stay resolved after restart.** Recovered document and scene conflicts collapse to clean when disk matches authority or dirty when disk matches the durable baseline, avoiding a false repeat prompt while preserving the authority's CAS-guarded flush path.
- **Supervisor executable trust stays scoped to chan.** Desired systemd units remain typed instead of passing through installed-text executable-name heuristics, exact desired legacy commands can still migrate, foreign or administrator-edited units remain refused, and an inherited `APPIMAGE` is accepted only for chan-named AppImage basenames.
- **Generated desktop downloads are window-owned and reaped.** Append and finish operations reject handles owned by another window, window destruction drops matching whole sinks, and startup removes only canonical foreign generated-download temporaries older than one hour without recursion.
- **Escaped gitignore negations retain their literal fixed prefix.** Fully consumed escaped path components now narrow traversal through configured exclusions, while wildcards and dangling escapes still stop at the last proven literal prefix.
- **Workspace close wins during startup.** `chan close` and `chan close --remove` cannot be undone by a stale startup completion, and immediate reopen preserves the intended registration semantics.
- **A removed workspace root fails closed.** Existing views converge to an unavailable state, dirty editor buffers remain in memory, and new files, drafts, terminals, graphs, and file browsers fail without recreating the root.

## [v0.76.1] - 2026-07-25

Patch: fix the macOS and Windows release build. No functional change from v0.76.0; the v0.76.0 tag failed to build on those platforms.

### Fixed

- **The macOS and Windows builds compile again.** The Linux-only inotify per-directory watch-registration items (`DirRegistration`, the `WatchCommand::Register` variant, `DirPlan`, `plan_dir`) were flagged as dead code on the macOS and Windows notify backends, which watch recursively and never use them, failing the build under `-D warnings`. They are now gated off non-Linux.

## [v0.76.0] - 2026-07-25

v0.76.0 hardens the devserver rebuild-storm and recovery paths: one `IndexScopePolicy` across walk, index, watch, and report with `.gitignore` honoring and a rebuild generation coordinator; the editor's never-discard write contract (`428`/`409` plus reachable conflict resolution) and session-restart durability that stops a restart flushing stale authority over disk; bounded streaming file transfers on desktop and the terminal download; a workspace recovery-readiness surface on the status routes, the SPA, and `chan workspace status`; and safe systemd unit classification and migration.

### Added

- **Editor sessions survive a server restart without discarding your work.** Held document and scene authorities persist a durable recovery record (baseline, versions, dirty/conflicted state) under the workspace `.chan/editor-sessions/`, written through the canonical bounded atomic writer. On restart the session rehydrates that state before any flush can run, so a restart during an unsaved or conflicted edit never silently overwrites newer disk content with stale authority. A corrupt or incompatible record degrades to a clean open rather than bricking the file.
- **Conflict resolution is reachable in the UI.** A document or scene whose disk diverged from the in-editor authority (a `Conflicted` session) can now be resolved from the SPA — reload from disk or overwrite disk — through a dedicated `/api/session-conflicts/resolve` route, instead of the resolution paths existing only in tests.
- **Recovery readiness is surfaced everywhere.** A `WorkspaceReadiness` (`ready` / `recovering`) status is exposed on `/api/index/status`, `/api/indexing/state`, `/api/preflight`, and `/api/search/content`, and consumed by the SPA and by `chan workspace status`. A query issued while the workspace is recovering returns an explicit *recovering* result rather than a fresh-looking empty one, so an in-progress rebuild can no longer read as "nothing here."
- **Bounded, streaming file transfers on desktop.** chan-desktop downloads and uploads stream through the native layer to/from a temp file with an atomic commit, loopback/gateway origin pinning, redirect refusal, and progress throttled to <=10 Hz — the WebView IPC never copies a whole file. Concurrency is bounded to two downloads and one upload with a visible queue.

### Changed

- **The write path never silently discards.** `PUT /api/files/{path}` is a checked write: a stale `expected_mtime_ns`/`authority_version` returns `428`/`409` with the current version so the client can three-way merge or open the conflict dialog, rather than clobbering a concurrent change. Reads carry the authority version and a `disk_conflicted` flag.
- **One index-scope policy across walk, index, watch, and report.** Walk, indexing, the Linux inotify registration, and the report scanner now share a single `IndexScopePolicy` that layers `.gitignore` honoring (nested, anchored, negation) under the `index_excluded_dirs` overrides, so what is excluded is consistent across every subsystem and generation-versioned when the policy changes.
- **Full-tree rebuilds run through a generation coordinator.** A rebuild trigger that arrives *during* an active rebuild now forces exactly one more pass before the workspace reports ready, and repeated overflow coalesces to the last required generation with no lost trigger — replacing the drop-the-trigger-then-cooldown behavior. The `REBUILD_COOLDOWN` remains a floor under the latch. Directory renames and removals forget the entire affected subtree from the graph and search index.
- **Devserver systemd units are classified before they are rewritten.** An installed unit that matches the current or a known prior chan render is migrated through a safe daemon-reload/restart/rollback path that preserves fdstore ownership; a foreign or admin-edited unit is no longer overwritten silently but reported with an actionable error. A failed migration rollback now discloses that live terminal PTYs were dropped instead of claiming a lossless restore.
- **Terminal single-file downloads stream instead of buffering.** The standalone-terminal download path reads the file through a bounded streaming reader (mirroring the workspace download) rather than loading the whole file into memory.

### Fixed

- **A workspace closed during startup crash-recovery releases its lock promptly.** The owned startup recovery worker's rebuild is now cancellable and is stopped and joined during teardown, so closing or forgetting a workspace while it rebuilds from a crash marker frees the per-workspace flock immediately instead of holding it past the teardown window and making an immediate reopen fail.
- **A large open document stays editable while a session is held.** The editor recovery record is bounded against the file's own write budget (oversized records collapse to a small absence marker) and a recovery-write failure degrades to a warning instead of closing the socket or turning a completed save into a 500.
- **The editor serves fresh content after an external restore.** The doc- and scene-session echo ring parks an unmatched external-restore observation and re-checks it after the ring TTL instead of clearing it, so a file restored on disk out from under an open editor stops surfacing stale content (browser smoke check 57 is ungated).
- **Build-output trees are excluded from walk, index, and watch.** The default `index_excluded_dirs` gains `buck-out`, `.buckos`, `downloads`, `distfiles`, `prebuilt`, `vendor`, and `prelude` (Buck2-class build trees; names remain user-removable), and a config whose list matches the old default exactly is migrated on open — customized lists are untouched. On Linux the watcher no longer registers inotify watches inside excluded subtrees at all (previously every directory was registered and only muted at dispatch), and a directory moved or created into the watched tree now streams its contents immediately via a catch-up scan instead of waiting for the next reconcile. This is the proven kill-switch for the devserver rebuild-storm class (see `team/roadmap/done/devserver-rebuild-storm-and-livelock.md`).
- **Full-tree index rebuilds are storm-damped.** After each rebuild resolves, triggers that arrived *during* it coalesce into a single follow-up and a 30s cooldown spaces consecutive rebuilds out. The level-triggered rebuild triggers (watcher-channel lag, VCS burst threshold, provider errors) could previously sustain back-to-back full-tree rebuilds indefinitely on a busy tree.
- **inotify queue overflow now surfaces instead of going silently stale.** notify delivers overflow as `EventKind::Other`, which the watcher dispatch dropped — missed events with no recovery signal. It is forwarded as a throttled `ProviderError` (the consumers' full-reconcile trigger), at most once per second per watcher.
- **The standalone binary caps async workers and the devserver unit gains a systemd watchdog.** `chan` now runs at most 8 tokio worker threads (the blocking pool does the heavy lifting; 315 workers on the incident box were pure waste). The devserver systemd units (CLI-written and packaged) pin `WatchdogSec=30`, and the server pings `WATCHDOG=1` at half the configured interval, so a seized-but-alive process now fails systemd's liveness check and auto-restarts with a journal trail.
- **The editor tracks OS read-only flips live again.** `chmod` on an open file now drives the locked lamp and the editor's read-only state within a watcher tick: the server stats the live user-write bit onto every `/ws` watch frame and open tabs adopt it. Since v0.67 the doc-session reconciler ignored permission-only changes (no mtime bump) and the banner path skipped attached tabs, so a `chmod 400` never surfaced.
- **Saves of >2 MiB documents reach the workspace's own size check.** `PUT /api/files/{path}` no longer inherits axum's 2 MiB body limit, which rejected every large save with an opaque body error and silently made legacy big files unwritable; the route now allows bodies up to the 50 MiB bytes cap so the deliberate `max(prev_size, 2 MiB)` rule applies. `WriteTooLarge` also maps to an honest 413 instead of a 500.

## [v0.75.0] - 2026-07-24

v0.75.0 replaces the desktop's `chan://` custom-scheme sign-in with an
RFC 8252 loopback redirect plus PKCE, which fixes sign-in on Linux and
Windows and closes the deep-link second-instance gap; adds a consistent
`cs pane` surface for addressing windows, panes, and Hybrid sides, and a
per-terminal mouse-capture toggle; stops shipping the unmaintained
self-built desktop `.deb`/`.rpm`; and lands a round of editor, slides,
terminal, and devserver bug fixes.

### Added

- **`cs pane` addressing.** `cs pane` gains canonical `new`, `focus`,
  `resize`, `equalize`, `swap`, `close`, `close-tab`, `close-all`, and
  `list` commands, and every tab opener (`cs open`, `cs graph`,
  `cs dashboard`, `cs terminal new`, `cs terminal team new|load`) takes
  `--window`, `--pane`, and `--side a|b` to place a tab in an exact
  window, pane, and Hybrid side. `cs pane list` reports both sides of
  every pane. The `split` and `close-pane` forms stay as hidden aliases
  of `new` and `close`.
- **Terminal mouse-capture toggle.** New `terminal.mouse_capture`
  server setting (default on) with a checkbox in Settings, Terminal
  section. Turned off, a full-screen TUI that enables mouse reporting
  no longer captures the pointer: newly opened terminals strip the
  DECSET mouse-enable sequences from program output, so click-drag
  text selection works over the TUI while wheel scrolling, links, and
  the context menu keep working. Default on is byte-for-byte the
  previous behavior.

### Changed

- **Loopback desktop sign-in.** chan-desktop signs in through an RFC
  8252 loopback redirect (`http://127.0.0.1:<port>/auth/callback`) with
  PKCE (S256) instead of the `chan://` custom scheme. This fixes sign-in
  on Linux and Windows, where the OS delivered the `chan://` callback to
  a second process that could not complete it, and needs no system
  scheme registration. The gateway consent page no longer asserts the
  requesting app's identity (a local loopback client cannot be verified)
  and names the local callback port.
- **`cs` tab openers target one exact window.** `cs open`, `cs graph`,
  `cs dashboard`, and `cs terminal new` now queue to the exact target
  window (`--window` or `$CHAN_WINDOW_ID`) and error if that window has
  no live connection, where before the command was broadcast and
  reported success as long as any window was connected.
- **Survey `[F]` is a pure "will follow up later" signal.** The
  follow-up-file machinery is retired: `cs terminal survey` loses
  `--followup-dir`, `--from`, and `--to`, replying `[F]` never writes a
  file, and the blocked survey call now prints `host will follow up
  later` on stdout. `[X]` dismiss (`survey dismissed; no answer`) and
  option replies (the label verbatim) are unchanged, so agents keep the
  three-way branch between an answer, a dismissal, and a follow-up
  coming in a separate prompt.
- **Terminal budgets.** Per-terminal scrollback defaults to 10 MB
  (Settings range 10..50 MB; existing configs above the cap clamp to
  50 on read), and the reattach replay ring doubles to 2 MB so a busy
  agent session reattaches without opening mid-stream.
- **`chan dump-skill` marker guidance.** The skill corpus now tells
  agents that `@pagebreak`/`@today`/`@date` are live-editor typing
  macros and to write the materialized forms (`<hr class="chan-page-
  break">`, a concrete date) when authoring files directly.

### Fixed

- **Editor:** the line after a table is clickable again (block widgets
  use padding, which CodeMirror's height map includes, instead of
  margin, which it excludes).
- **Editor:** an errored mermaid block is click-through to its failing
  line, and ArrowUp no longer escapes above the diagram.
- **Editor:** saving over a slow network no longer raises a phantom
  "external edit" conflict modal (the save funnel uses a sync-progress
  quiet window, and the server token-adopts a byte-identical stale PUT).
- **Slides:** no spacer band above a slide's first heading, and PDF
  export sizes diagrams and images at the preview's layout box.
- **devserver `--join`:** the watchdog rides out a `--restart` or a
  stall, adopting the restarted daemon and re-pinning instead of
  bailing after ~6s, so the desktop no longer needs a manual reconnect.
- **Rich prompt:** pasting an image then pressing the submit chord no
  longer also opens the fullscreen image viewer.

### Removed

- **Self-built desktop `.deb`/`.rpm` release artifacts.** GitHub
  releases ship the AppImage; the `.deb`/`.rpm` channel is the
  maintained COPR/PPA/AUR packages.
- **The `chan://` custom scheme and deep-link plugin.** Loopback sign-in
  replaces them, which also closes the Windows/Linux deep-link
  second-instance gap.

## [v0.74.0] - 2026-07-22

v0.74.0 lands the distributed proxy control plane: the gateway coordinates every devserver-proxy through one authenticated, database-free control service, with cryptographic admission leases, bounded opaque browser sessions, and durable revocation. Around it, `chan open` routes deterministically when several local instances run, `cs terminal write --submit` becomes server-authoritative, the devserver bearer token can be rotated and no longer persists into WebView snapshots, macOS wake stops re-running the control-terminal connect script, and a set of editor fixes restore fenced-heading folds, code-block contrast, the command-launcher focus border, and the diagram flip. Packaging makes the AUR publish check advisory, adds a COPR publication probe, and removes the aarch64 AUR CI validation.

### Added

- **Distributed proxy control plane.** The new database-free
  `devserver-control` service owns the dynamic proxy directory, aggregate
  tunnel view, synchronous fleet admission, command routing, and revocation
  fan-out. Every provisioned proxy holds one authenticated h2 control session,
  publishes signed registry state, and waits for controller admission before
  `HelloAck::Ok`; there is no local fallback. The service ships as a deb,
  systemd unit, OCI image, and Kubernetes workload, with separate admin/health
  and proxy-control listeners.
- **Cryptographic admission and browser authority.** Identity-signed Ed25519
  admission leases bind immutable owner, devserver, registration, and proxy
  identity. Browser entry credentials are 30-second, single-use, body-only,
  Ed25519 assertions bound to the exact node and clean path. Proxies exchange
  them for bounded opaque sessions that are checked per request, expire within
  one hour, and can cancel active HTTP and WebSocket bridges on revocation.
- **Durable denial propagation.** Grant deletion, account block/delete, and PAT
  revocation write their state, audit row, and a generation-fenced revocation
  job in one profile transaction. A bounded worker confirms two post-commit
  fleet cuts around the complete entry-credential quiet window and survives
  profile or controller restarts.
- **Node-specific tenant origins and Desktop sessions.** Every proxy has a
  provisioned stable id and exact public base origin. Identity revalidates the
  signed controller row before minting an entry, and Chan Desktop validates the
  immutable owner/devserver label, installs exact-origin authority, reuses one
  opaque session across windows, refreshes it single-flight before expiry, and
  sends exact WebSocket Origin.
- **Bounded failure semantics.** Control loss stops admission immediately,
  retains existing authority for at most the normal 30-second grace or hard
  45-second convergence deadline, and then atomically suspends session issuance
  and drains tunnels and bridges. The controller retains disconnected authority
  markers for 60 seconds, so a second disconnect cannot create a false revoke
  acknowledgement window. Controller HA remains out of scope.
- **The devserver bearer token can be rotated.** An operator `rotate` verb and a
  live, bearer-gated `POST /api/devserver/rotate-token` route mint a fresh token
  and retire the old one from the next request without a restart, and a
  devserver whose token predates 30 days re-mints it on cold start (so the first
  0.74.0 start rotates once, retiring every pre-0.74.0 token).

### Changed

- **The aggregate `/admin/v1/*` tree moves from devserver-proxy to devserver-control.** identity, profile, and `chan-gateway-admin` now read one coherent fleet view from the controller (`DEVSERVER_ADMIN_URL` / `CHAN_ADMIN_WORKSPACE_URL` default to port 7003), so a management read is either the whole fleet or an explicit upstream failure, never one healthy proxy's partial snapshot. The proxy keeps only its public, tunnel, and health listeners.
- **Public origins are explicit configuration.** `BASE_URL`, `DEVSERVER_PROXY_ORIGIN`, `DEVSERVER_TUNNEL_ORIGIN`, `DEVSERVER_PROXY_BASE_URL`, and `DEVSERVER_PROXY_BASE_URL_TEMPLATE` replace runtime hostname derivation from `CHAN_DOMAIN` / `PUBLIC_SCHEME` and fixed `gw` / `usr` / `devserver` labels; a self-hosted deployment names any origins with the same structural relationship.
- **Devserver grants are binary and shell-equivalent.** Viewer/editor roles are
  removed. Owner and grantee requests carry a fresh per-tunnel assertion bound
  to immutable caller, owner, devserver, and audience; chan-server rejects a
  missing or mismatched assertion before route execution.
- **Browser boundaries are explicit.** Entry exchange uses fixed body-only
  `POST /_chan/entry`; all non-safe methods, including extension methods,
  require the double-submit CSRF value; WebSockets require the exact canonical
  Origin; and credentialed responses are non-cacheable, non-sniffable,
  non-frameable, and no-referrer. Query parameters are never proxy credentials.
- **Gateway auth cookies are renamed to `__Host-` names.**
  `__Host-devserver_gate`, `__Host-devserver_csrf`, and `__Host-id_session`
  replace their prior names; existing browser sessions re-establish at the
  0.74.0 cutover.
- **`cs terminal write --submit` is server-authoritative.** The server derives
  each matched session's agent from its spawn command and `CHAN_AGENT` and
  applies that session's chord, so a mismatched sender guess and a mixed-agent
  `--tab-group` broadcast both submit correctly, and a shell target receives
  plain text; a sender/target mismatch is noted in the ack. `cs terminal list`
  (and `--json`) now reports each session's derived `agent` (`-` for a shell),
  so a sender can discover a target's agent at runtime, and
  `CHAN_SUBMIT_<AGENT>` template overrides are read from the server's
  environment (and its `<config>/chan/submit.toml`), not the writer's.

### Fixed

- **`chan open` routes deterministically when several local instances run.**
  Each devserver takes its own discovery socket under a live-owner flock, an
  `Identify` verb reports which instance is live, and a
  `--devserver[=<port|url>]` selector targets one and refuses rather than
  guessing; routing follows the live instances instead of personality alone, and
  the stale port-8787 collision hint no longer blames a devserver handoff that
  never ran.
- **macOS wake no longer re-runs the devserver connect script on the control
  terminal.** A wake used to re-dial the control terminal and re-run its connect
  script; the wake recycle is now gated off control terminals, and a connect
  script's death marks the connection down with no replacement session, viewport
  clear, or automatic rerun.
- **The devserver bearer token no longer persists into WebView terminal
  snapshots.** Control-terminal scrollback carrying the token is excluded from
  the snapshot written to WebView storage, and any existing snapshot carrying the
  token marker is pruned when the window reloads.
- **Fold chevrons no longer appear beside `#` comments inside fenced code, inline
  code, or frontmatter.** Heading detection now reads the editor syntax tree
  rather than a raw-line regex, so folding a heading above a fenced block no
  longer stops at a fenced `#`, and the bullet and heading formatting chords no
  longer rewrite a fenced `#` line. Indented headings (up to three leading
  spaces) now fold.
- **Fenced code blocks contrast against the page again.** The dark code-block
  background regained a distinct slab (a regression since v0.70.3, where an
  opaque page fill buried it), now spanning the content column with even side
  margins; the dark table header and stripe tokens are matched to the same
  surface.
- **The command launcher's focus-colour command recolours the pane's focus
  border.** Choosing a focus colour from the command launcher now writes the
  highlight colour the border reads, matching the hamburger-menu control, instead
  of updating only the selection and check-mark.
- **A diagram's render flip always rotates forward.** The de-render tumble (on
  the cursor re-entering the source) mirrored the render flip and rotated
  backward; it now continues the same forward rotation.

### Operators

- **New scoped configuration.** devserver-control requires per-proxy
  `DEVSERVER_PROXY_CREDENTIALS`, separate operator/identity/profile admin
  rotation rings, admission verifying keys, and the proxy-base template. Each
  proxy holds only its own `DEVSERVER_PROXY_TOKEN`, entry public-key ring, and
  required internal client credentials. Identity alone holds the entry signing
  key. Shared fleet and admin bearer guidance is removed.
- **Version lockstep is enforced.** All gateway services and proxies must run the exact same package version; the control handshake rejects a mismatch. The five `chan-gateway-*` debs and the four gateway OCI images publish at one immutable tag.
- **Internal transport must be protected.** Cleartext internal URLs and
  listeners are accepted only on parsed loopback addresses or when the
  deployment explicitly declares an authenticated encrypted overlay.
  Kubernetes examples include split Secrets and default-deny NetworkPolicies;
  systemd services use separate identities and readable env files. Ordinary
  CNI isolation or NetworkPolicy alone is not claimed as encryption.
- **Database migration ownership is separate.** A one-shot migration owner runs
  schema changes. Runtime profile and identity roles receive only their
  required table privileges; identity has no direct access to the durable
  control-revocation outbox.
- **Release-asset verification single-sources the required list and requires the
  Windows artifacts.** The verifier derives the required gateway `.deb` set from
  the gateway service list instead of a hardcoded count, now requires the Windows
  CLI zip and NSIS installer, and gains a local `--release-json` mode that can be
  exercised before the tag.
- **aarch64 AUR CI validation is removed.** Its failures were CI-environment
  issues (the ALARM rootfs certificate, then pacman's Landlock download sandbox
  under the nested container), not package defects, so it never became a
  publication gate; the aarch64 PKGBUILD still ships for users to build natively.
  This supersedes the v0.73.0 note that a later release would make AUR
  publication wait for the aarch64 build.

## [v0.73.0] - 2026-07-20

v0.73.0 decouples publishing from the release: the Docker images and every distro package now ship from their own workflow that fans out in parallel after a successful release, so a registry or a distribution can no longer hold up a release or block each other. chan also stops building the CLI `.deb` and `.rpm` that COPR, the Launchpad PPA and the AUR now build for it, batches OpenCode's queued terminal notifications into one turn, and fixes the Command Launcher's dead "Flip pane" row.

### Changed

- **OpenCode reconciles queued terminal notifications into one turn.** When several notifications arrive while OpenCode is busy, they now drain as a single batched submit instead of one message per notification, matching what Claude and Codex already did. Gemini deliberately stays one message at a time: a live sweep on Gemini 0.51 found that a Return arriving close behind inserted text is still converted to Shift+Return, and no gap below the queue's idle threshold left a safe margin for a full-sized batch, so batching it would silently strand input in the compose box.

### Fixed

- **The Command Launcher's "Flip pane" row works.** Choosing "Flip pane" in the Command Launcher, or "Flip" in the File Browser, did nothing at all: the launcher was still counted as the top overlay at the moment it ran the command, so a guard meant to stop pane flips from reordering panes behind an open overlay swallowed the flip instead. The overlay stack is now reconciled the moment an overlay closes rather than one frame later, so a command dispatched from the launcher sees the state the user sees. The ``Ctrl+` `` chord and the A/B pane control were never affected, and the guard still does its job: with Search or a modal open, a flip stays blocked.
- **The Arch AUR packages can publish again.** The post-install verification of the shipped systemd user unit ran without the privileges it needs and failed inside the build container, which blocked the AUR push for both `chan` and `chan-desktop`. The verification now runs with those privileges, so it stays enforced rather than skipped. AUR publication was the only thing affected: the GitHub release, COPR, the PPA, and the Docker images all shipped normally. v0.72.0 never reached the AUR at all, so no user has a stale or broken AUR package.
- **The chan-desktop RPM refuses EL9 with a clear reason.** EPEL Next 9 provides neither `webkit2gtk4.1-devel` nor `libsoup3-devel`, so the desktop shell cannot build there. The spec now fails immediately naming both packages, instead of failing deep inside dependency resolution. Fedora, EL10, and the `chan` CLI package are unaffected.

### Operators

- **Publishing a release can no longer be held up by a registry or a distro.** The release itself is now the tag, the signed artifacts, the GitHub Release, the `/dl` metadata, and the Pages deploy. Everything downstream of it, meaning the Docker Hub images, COPR, the Launchpad PPA, and the AUR, moved into a single `publish-downstream` workflow that fires once the release has succeeded and fans them out in parallel. Each one fails independently and visibly; none of them can fail the release, and none can suppress another. Previously the Docker Hub jobs ran inside the release workflow, so a registry outage turned the whole run red and silently skipped COPR, the PPA, and the AUR with nothing naming Docker as the cause. The two COPR package triggers were also chained in one step, so a failure on `chan` meant `chan-desktop` was never triggered at all; they are now separate jobs.
- **chan no longer publishes its own CLI `.deb` and `.rpm`.** The four `chan-{amd64,arm64}.{deb,rpm}` assets carried no version in their filename and are now built by the distributions themselves: `chan` comes from COPR for Fedora and CentOS Stream, from `ppa:fiorix/chan` for Ubuntu, and from the AUR for Arch and CachyOS. Installing from a distribution gives you package management, signatures and upgrades that a loose file download never did. Nothing else changed: the static binaries, `install.sh`, `chan upgrade`, the AppImage, the macOS `.dmg`, the Windows installer, the Docker images, and the `chan-gateway-*` server packages are all unaffected. On a distribution with no chan package, the static binary and `install.sh` remain the supported path.

- **The Arch aarch64 build runs on every release.** `aur-validate-arm` builds both recipes natively on aarch64 at GA instead of only on manual dispatch. For this release it is observed evidence and does not gate publication, because it has never run end to end; once it has passed, a later release makes AUR publication wait for it.

## [v0.72.0] - 2026-07-20

v0.72.0 adds `chan dump-skill` as an agent-facing manual of chan's whole surface, reconciles queued terminal notifications into one agent turn with a queue depth to observe it, packages chan for CentOS Stream through COPR and for Arch and CachyOS through the AUR, fixes `VERSION=X.Y.Z` installs on Debian and Ubuntu, and makes a distro-packaged chan-desktop refuse self-upgrade up front.

### Added

- **`chan dump-skill` prints an agent-facing manual of chan's whole surface.** One command teaches an agent what chan is and how to drive it: the `cs` command surface, the command launcher and the built-in apps, authoring documents with diagrams and slide decks, the project graph, teams of agents, and devservers. `mkdir -p ~/.claude/skills/chan && chan dump-skill > ~/.claude/skills/chan/SKILL.md` installs it, `--list` prints the topic index, and `--topic <slug>` prints one page. Every section is the live `--help` of a real command, so the manual cannot go stale against the binary printing it; `chan` and `cs` help text is expanded throughout to carry that detail.
- **`cs terminal list --json` reports each session's queue depth.** Every entry carries `queue_depth`, the number of `cs terminal write` and Rich Prompt messages still pending for that session, so a script can tell a busy queue from a drained one without the SPA. The markdown table is unchanged.
- **CentOS Stream 9 and 10 COPR packaging.** The COPR project carries CentOS Stream chroots for `chan` on both releases and for `chan-desktop` on Stream 10; EPEL Next 9 is excluded because it does not provide the required WebKitGTK 4.1/libsoup3 development stack. `make copr-check` rebuilds, installs, and smokes the vendored RPMs in clean CentOS containers on a Linux host, and passes on an x86_64 host for all three supported targets: `chan` on Stream 9 and on Stream 10, and `chan-desktop` on Stream 10. No COPR build has run against these chroots yet, on either architecture.
- **Arch and CachyOS users can install source-built chan packages from the AUR.** The `chan` and `chan-desktop` recipes disable self-upgrade in favor of the AUR helper and publish only after a clean Arch x86_64 container builds, installs, smokes, and namcap-checks both packages. The desktop recipe links against the host WebKitGTK/Mesa stack instead of repackaging the Ubuntu-built AppImage. The recipes also declare aarch64, which builds from the same sources but is not covered by the release gate yet.
- **`CHAN_TERMINAL_INPUT_GAP_MS` tunes the batched Claude body/chord gap.** The server reads it once per process and uses it as the pause between the two PTY writes of a batched Claude delivery, so a new Claude Code release can be re-measured without a rebuild. Values outside 1..800 ms are ignored and the built-in 50 ms applies.

### Changed

- **Queued terminal notifications reconcile in one agent turn.** At an idle opportunity, consecutive `cs terminal write --submit=codex|claude` messages arrive as one framed chronological prompt instead of consuming one full agent turn each. FIFO order, the busy-agent gate, the 100-entry bound, singleton bytes, Rich Prompt turns, raw input, OpenCode, and runtime submit overrides retain their existing boundaries; large Claude batches use a paste-safe body/chord split so the submit key cannot be swallowed. Gemini is unchanged: it is a batch boundary, and its body and Return remain two separately idle-gated queue entries.

### Fixed

- **`VERSION=X.Y.Z` installs work again on Debian and Ubuntu.** The installer's version check used a `[^...]` glob negation, which is a bash extension: under `dash`, which is `/bin/sh` on Debian and Ubuntu and is the shell the documented `curl -fsSL https://chan.app/install.sh | sh` line runs, the test was inverted, so every valid version was refused with "VERSION must be a bare X.Y.Z version." and a garbage value passed. It now uses the POSIX `[!...]` form, which behaves the same across dash, bash, and busybox ash. Installs without `VERSION` never reached the check and were unaffected.
- **A chan-desktop installed from a distro package no longer tries to self-update.** `chan upgrade` on a build from COPR or the PPA failed with an unrelated `desktop upgrade over hand-off is not supported on linux` instead of naming the package manager, and with no chan-desktop running it first launched a desktop window the user did not ask for to reach that same error. It now refuses up front, with no window, and names the manager to update with, exactly as the packaged CLI already did. The refusal is decided before the personality is consulted, so no install path can reach an updater on a packaged build: the desktop updater is a compile-time stub off macOS today, but on a platform where it is real it would download over files the package manager owns. `chan upgrade --check` is refused up front by the same decision instead of being routed into the desktop path, where it failed for an unrelated reason. Builds installed by hand are unchanged.

## [v0.71.0] - 2026-07-19

v0.71.0 makes OpenCode a first-class terminal agent, replaces the desktop's static wildcard gateway grants with authenticated exact-origin native trust, unifies workspace search and graph traversal behind one bounded contract and one agent tool, keeps the last five CLI and desktop versions resolvable for `chan upgrade --version`, and fixes two editor cosmetics.

### Added

- **OpenCode is a first-class terminal agent.** `cs terminal write --submit=opencode`, `CHAN_AGENT=opencode`, `CHAN_SUBMIT_OPENCODE`, Team Work command derivation, and `[opencode]` in `submit.toml` use one bracketed-paste-plus-Return PTY write, including multiline and paste-sized prompts. Gemini keeps its body and Return as two ordered writes.
- **Rich Prompt uses server-reported terminal identity.** Terminal session frames carry an optional spawn-derived submit agent for Claude, Codex, Gemini, and OpenCode; restart and reattach recompute it from the current command and `CHAN_AGENT`. Shells and unknown commands omit it, and the existing keyboard-protocol inference remains the fallback. No agent selector is added to the SPA.

### Changed

- **The desktop grants native access per authenticated exact origin, not a wildcard.** The old static `*.chan.app` / `*.devserver.chan.app` capability is gone; each gateway devserver is trusted only for its exact authenticated origin, derived from the gateway's entry response and persisted per gateway as a `(gateway id, owner, full devserver id)` trust tuple. A shared row warns and asks for consent before its first connect, trust survives a restart, revoke tears down the row's windows, and a sibling, apex, wrong-port, or unrelated origin is refused. The gateway wire and API version are unchanged.
- **Workspace search and graph traversal share one bounded contract.** `cs search`, `chan workspace search`/`graph`, the new `POST /api/search/workspace` route, and the MCP tool surface now go through a single `workspace_search` (the four separate read tools collapse into one), with typed query, from, domain, depth, direction, edge-kind, and limit selectors; `--scope`, `--target`, and `GraphScope` are removed. `/api/graph` output is unchanged.
- **`chan upgrade --version X.Y.Z` resolves older releases.** The `/dl` metadata generator now retains the last five GA versions as per-version CLI and desktop manifests plus a multi-entry `releases.json`, so pinning an older version resolves instead of only `latest`; rc and prerelease tags are filtered out.

### Fixed

- **Light-mode fenced code blocks are visible again.** The light code-block fill sat within a few RGB steps of the page background and read as no fill; it now uses GitHub's Primer gray so the slab is a distinct surface. The dark code block and the sibling editor themes are matched to the same intent.
- **The dark-mode editor selection is readable.** The selection was rendering CodeMirror's hard-coded light-grey base-theme default (a near-white wash under near-white text); it now routes through the app's GitHub-blue selection token, keeping selected text legible.

## [v0.70.3] - 2026-07-18

v0.70.3 is a patch release. It restores the editor's text-selection highlight, which v0.70.2's page-width scrollbar change hid whenever the page-width cap was on (the default), and stops a refused launcher Open from leaving a status pill stuck on the workspace with no way to dismiss it.

### Fixed

- **Selecting text in the editor shows the highlight again.** v0.70.2 painted the page background on CodeMirror's content element, which sits in front of the selection layer drawn behind it, so with the page-width cap on (the 80% default) selected text had no visible highlight at all. The page fill now lives on a layer behind the selection, leaving the content transparent so the selection shows through; the centered page and the off-page shade are unchanged.
- **A refused launcher Open no longer sticks on the workspace forever.** When an "Open" was refused (a path outside the workspace root, a binary target, or no connected window), the error was written to the status pill with no dismiss control and no auto-clear, so it stayed up indefinitely. The refusal is now a dismissable persistent pill, matching every other one-shot error.

## [v0.70.2] - 2026-07-18

v0.70.2 is a patch release. It stops the devserver control terminal from re-running its connect script in a loop, keeps a remote terminal's process alive across a long idle (and clears the mouse-tracking garbage a dead program left behind), renders inline markdown inside table cells, sizes exported Excalidraw diagrams to the slide, seeds the slide-deck zoom_factor, and moves the editor's page-width scrollbar to the window edge.

### Fixed

- **The devserver control terminal no longer loops its connect script.** The terminal-socket reconnect kit (heartbeat, read-deadline, auto-redial) was applied to every terminal, including the desktop's single-shot connect control terminal: after the connect script exited, the socket redialed and the server re-ran the script, and it kept doing so. The control terminal is a local, single-shot runner owned by the desktop exit watcher, so it is now excluded from the kit (no heartbeat, no read or connect deadline, no auto-redial) and runs its script exactly once.
- **A remote terminal left idle keeps its running process, and a dead program no longer leaks mouse tracking.** After a long idle or laptop sleep the same reconnect kit discarded the resumable session id and attached a fresh shell, replacing whatever was running (an agent, an editor); the fresh shell then inherited the dead program's mouse-tracking mode, so moving the mouse printed escape sequences at the prompt until a reload. The resumable id now survives transport failures so the persisted session is reattached instead, and when a genuinely fresh shell does replace a session the terminal resets its input modes first.
- **Bold and other inline markdown render inside table cells.** Table cells showed their literal markers (`**bold**`, inline code, links); each cell now goes through the same inline markdown pipeline the rest of the document uses.
- **Exported slide decks size embedded Excalidraw diagrams to the slide.** An Excalidraw export carries fixed pixel dimensions that the PDF rasterization did not constrain, so diagrams overflowed the page; they now shrink to the slide, matching the on-screen preview, while mermaid diagrams are unaffected.
- **New slide decks seed the default zoom_factor.** The New slide deck template now writes `zoom_factor: 2` alongside `aspect_ratio`, so the default zoom is explicit in the starter frontmatter.
- **The editor's page-width scrollbar sits at the window edge.** With a reduced page width the vertical scrollbar sat at the narrowed page's right edge and the off-page margins were not scrollable; the scrollbar now sits at the window edge and the whole off-page area scrolls.

## [v0.70.1] - 2026-07-17

v0.70.1 is a patch release focused on tunneled (gateway) devservers: uploads and PDF export work through the proxy, closed windows stay closed, rows show the machine's OS logo and a real name, tunnel-mode devservers stop colliding on port 8787, gateways can be renamed, and `cs` help no longer says `cs shell`.

### Added

- **Name your tunneled devserver.** `chan devserver --tunnel-token ... --tunnel-devserver-name <name>` names the roster row in the launcher and on the gateway dashboard; without the flag the machine's hostname is used. Previously the row showed the PAT label or a 12-hex token hash. Names are trimmed and capped at 64 bytes; two devservers of one account announcing the same name get `-2`/`-3` suffixes, and reconnects keep their suffix stable. Old clients and old gateways are both unaffected: the name rides an additive field on the tunnel hello, no protocol bump.
- **Rename gateways.** The pencil on a Gateways-screen card renames the gateway; the label survives restarts and the Computers rows' "via <gateway>" text follows. The URL stays immutable (remove and re-add to change the origin).

### Fixed

- **Uploads through a gateway no longer answer 403 forbidden.** The SPA's multipart upload and file-replace requests (drag-drop, `cs upload`, the export write-back) now mirror the gateway CSRF cookie like every other mutation; downloads were never affected. Local (non-gateway) devservers are untouched.
- **`cs export` works through the tunnel**, riding the upload fix. Its errors also name the actual requirement now: an open workspace window does the rendering, and the terminal running `cs` does not count as one.
- **Closed windows of tunneled devservers stay closed.** For gateway-rostered devservers, every close gesture (red-dot Close, closing the last tab, `cs terminal close`) destroyed the native window without ever sending the server-side discard, so the window feed immediately reopened it as a new window. The close path now resolves the owning connection through the window feed and deletes the record through the gateway; a feed frame arriving mid-close can no longer flash the window back open; and if the delete fails the launcher shows a notice instead of silently reopening the window. Local and raw-URL devservers were never affected.
- **Tunneled devservers show the OS logo** instead of the globe after connect: the desktop reads the devserver's OS self-report through the tunnel when connecting a rostered row.
- **Tunnel-mode devservers no longer collide on port 8787.** Under systemd, a tunnel devserver with no explicit `--port` now binds an OS-assigned port; nothing depends on the number (same-host `chan open` hands off over the local socket and gateway traffic rides the tunnel). An explicit `--port` binds exactly that port, and a bind failure is now loud: the journal names the address and prints the collision hint instead of a silent generic error. Non-tunnel devservers and `chan open` keep the 8787 default.
- **The chan-devserver container recipe installs `adduser`.** Provisioning on minimal Ubuntu images no longer fails at the sudo-group step.
- **`cs --help` renders `cs <cmd>`, not `cs shell <cmd>`.** The `cs` symlink now parses through the same parser chan-desktop uses, so every help screen reads naturally; dispatch, exit codes, and explicit `chan shell` usage are unchanged (`cs` additionally accepts the global `-v`).

### Operators

- identity/profile: a devserver redial that announces a name recreates its registry row through the standard upsert, so a swept row comes back labeled on the next dial (previously it stayed gone until the next grant create or mint). Owner-scoped label dedup is serialized server-side (advisory lock), and announced names are sanitized before persistence: control, zero-width, and bidi-override characters are stripped on top of the trim and 64-byte cap.
- The tunnel systemd unit pins an explicit `--tunnel-devserver-name` via `Environment=` with `%` escaped; client-side normalization maps control characters in names to spaces. Flagless tunnel units journal `binding 127.0.0.1:0` followed by the assigned port, and `chan devserver --restart`/`--join` resolve the running service's actual port from its recorded state.
- e2e: `gateway-zone.sh` gains `upload` (CSRF-mirrored multipart through the proxy) and `windowclose` (proxy DELETE removes the record) scenarios, and the core flow asserts same-name dedup across two tunnels.

## [v0.70.0] - 2026-07-17

v0.70.0 makes gateways first-class in chan-desktop: add a gateway by URL, sign in once for your account, and every devserver you own or that is shared with you appears in the launcher live - connect, open windows, and use the full command vocabulary even on self-hosted gateways. A new Gateways screen flips out of the Computers list, notification bubbles replace the error banner, and terminal tabs on gateway-backed devservers no longer go dead after idling.

### Added

- **First-class gateways in chan-desktop.** The Computers title flips to a new Gateways screen: add a gateway by URL, Connect to sign in once for your account, and the gateway's devservers - yours and the ones shared with you - appear under Computers automatically, appearing, disappearing, and flipping online state within seconds (rosters poll every 10s with ETag, so a quiet gateway costs almost nothing). Rows show "via <gateway>"; connect and disconnect work per row exactly like plain devservers. Disconnecting a gateway closes its devserver windows and greys its rows; removing it also drops the entry (your sign-in stays in the system keyring). Bulk select covers gateways too (deleted last, after their rows). The old flow - a gateway URL pasted into the Add devserver form, picking ONE devserver at sign-in - is gone; existing picked rows migrate into gateway entries automatically at first startup.
- **Launcher notification bubbles.** Corner bubbles (styled after the workspace notices) replace the launcher's error banner: each names its source (gateway, devserver, or the desktop), expands on click to the full message, and dismisses. Gateway life-cycle events narrate there - sign-in required, sign-in stored, gateway unreachable, devserver offline, a too-old gateway, the migration summary.
- **`chan open <gateway-url>` registers the gateway.** Opening a gateway URL against a running desktop converts it into a gateway entry (visible on the Gateways screen immediately) instead of a failed devserver dial; plain devserver URLs behave exactly as before. No CLI changes - old CLIs work unchanged, and the desktop answers the handoff at the same speed.

### Changed

- **One sign-in per gateway account.** The gateway consent page authorizes your account - "chan-desktop will get access to your account on this gateway: your devservers and devservers shared with you." - with no per-devserver pick. Existing desktop sign-ins keep working for already-connected rows, but cannot list the account roster: the first gateway Connect after upgrading asks you to sign in once more, then everything rides the account token.
- **Full command vocabulary on self-hosted gateways.** Windows served from ANY gateway's proxy origin now get the same IPC grants as `*.devserver.chan.app` windows (upload/download, all clipboard commands, zoom chords, open-in-browser): the desktop mints a runtime capability at first gateway connect, scoped to exactly that gateway's proxy wildcard. Already-open windows gain the grant live, no reload. One caveat, by Tauri design: a removed gateway's grant persists until the app exits (grants cannot be un-minted at runtime).
- **New terminal from a standalone terminal window.** The pane menu in a standalone terminal window now offers New terminal (Cmd+T), matching the workspace window's menu.

### Fixed

- **Terminal tabs on gateway-backed devservers no longer go dead after idle.** Two layers conspired: the gateway's WebSocket bridge cut any connection quiet in ONE direction for 300s (a terminal streaming output still died 300s after the last keystroke), and the terminal socket was the only one with neither a heartbeat nor reconnect - a dead tab stayed dead until a full reload. The terminal socket now heartbeats (20s ping, 45s read-deadline) and reconnects with capped backoff into the SAME session - scrollback preserved, no reload; the bridge cuts only when BOTH directions are idle and always sends a real Close frame, so the browser notices promptly instead of holding a zombie socket. Doc and scene sync sockets gain the same bridge protection and faster heal on tunnel redials.
- **Cmd+Shift+S no longer opens a dead Search overlay in a standalone terminal window.** Search needs a workspace, so the chord is now inert in a terminal window, matching every other search entry point.

### Operators

- Identity: new PAT scope `desktop.account` (must be requested alone; `tunnel` and `desktop.connect` remain for shipped clients). New roster endpoint `GET /desktop/v1/devservers` (Bearer PAT, `desktop.account`): owned + shared devservers with live online state, `ETag`/`If-None-Match` 304, 401 only for a dead token or wrong scope (clients cascade), 502 when profile or proxy is degraded (clients keep the last-known roster; the endpoint never serves a degraded all-offline 200). Roster reads bump `last_used_at` but skip the per-read audit row. Discovery advertises `roster_url` (additive; `api_version` stays 1). The entry mint accepts `desktop.connect` OR `desktop.account`.
- devserver-proxy: the bridged-WebSocket idle cut is now both-directions-idle (default 300s) and announces itself with a WS Close frame to both halves; idle cuts log at info.
- e2e: `gateway-zone.sh` gains a browser-free `scenario_roster`; the consent-page browser scenario rides the account flow (no picker).
- A PAT mint (operator `POST /admin/v1/tokens` and the SPA) now registers a devserver row only when the token carries the `tunnel` scope, matching the OAuth authorize flow - a non-tunnel PAT (for example `desktop.account`) no longer creates an offline, never-dialable phantom row. Default-scope mints (`tunnel`) still register as before.

## [v0.69.1] - 2026-07-16

v0.69.1 lets a tunnel-mode devserver restart gracefully under systemd (fd-preserving, like the local path already did) and switches the chan-devserver container image to a rootless, PPA-free chan install.

### Added

- **`chan devserver --restart` works in tunnel mode under systemd.** Setting `CHAN_TUNNEL_TOKEN` (env or `--tunnel-token`) with `--service=systemd` now configures the service in tunnel mode instead of being refused: the generated unit carries the PAT via `Environment=` (written 0600) and dials the gateway via `--tunnel-url`, reusing the first-run endpoint on a plain restart and refreshing it on `--force`. Restart preserves live PTYs across the bounce through the systemd fd store, exactly as the non-tunnel path does; under systemd the tunnel devserver also binds its loopback management API (127.0.0.1:8787) so the fd-park handshake can reach it. launchd still refuses tunnel mode (its plist would persist the token 0644).

### Changed

- **The chan-devserver container image installs chan per-user, without the PPA.** `chan-devserver.sdme` no longer enables `ppa:fiorix/chan` or bakes the `chan` package into the rootfs; `chan-devserver-provision` installs the released `chan` as the target user via `https://chan.app/install.sh` into `~/.local/bin` (so the user can `chan upgrade` without root), honoring `http(s)_proxy` for networks behind an outbound proxy. The systemd user unit runs the absolute `~/.local/bin/chan`.

## [v0.69.0] - 2026-07-15

v0.69.0 makes chan-desktop's gateway devserver windows first-class (working upload/download/clipboard/chords, honest reconnect feedback after sleep), unhangs `cs paste` everywhere with a visible in-window paste card, adds a global Open command to the launcher, makes launcher machine cards collapsible with durable state, and prunes long-offline devservers from the gateway registry.

### Added

- **Open from the command launcher.** A global Open command pops a path dialog with the same autocomplete as New File/Dir; Enter runs exact `cs open` semantics (directory opens the file browser, text opens the editor, a copy-link-to-graph URL opens the graph tab, a missing path is created and opened with the dialog saying so up front, binary refuses with an error in the top-right pill). Typing `Open <path>` directly in the launcher input works too, and Esc from the dialog returns focus to wherever you were. Backed by `POST /api/open`, which rides the same server dispatch as `cs open`. Hidden in standalone terminal windows.
- **Collapsible machine cards in chan-launcher.** "This machine" and every devserver card carry a window-count toggle (control terminal + standalone terminals + windows of running workspaces) left of the Terminal button; collapsed cards show just the header row. The state survives page reloads and full chan-desktop restarts (config-backed on desktop).
- **Gateway devserver registry cleanup.** profile-service sweeps devservers that have been offline longer than `DEVSERVER_RETENTION_MINUTES` (default 15; `0` disables), marking liveness from the proxy's tunnel snapshot each minute and never deleting on a tick whose snapshot fetch failed. Deleting a row drops its label and shares; a re-granted or redialing devserver reappears cleanly.

### Changed

- **`cs paste` / `cs copy` report a clipboard timeout as exit 124** (like `cs terminal survey`) with a message naming the likely browser permission prompt; after ~2s of waiting the CLI prints a one-line notice instead of sitting silent.
- **One word: "devserver".** All labels, docs, site copy, and comments now use "devserver(s)"; the launcher reads "Add devserver" and "This machine & devservers".
- **A held workspace window now counts as server activity.** The window watcher sends a liveness ping every 20s, so socket-activated `chan --timeout` instances no longer idle-exit while any window holds the watch socket.

### Fixed

- **chan-desktop gateway devserver windows regain the full command vocabulary.** Windows served from `https://*.devserver.chan.app` had no Tauri IPC grants, so `cs upload` died with an ACL toast, `cs download`'s save step and PDF-export save were dead, all six clipboard commands fell back to browser prompts, and the reload/zoom/devtools chords did nothing. They now carry the same grants as their loopback twins (deliberately: the tunnel origin serves your own PAT-backed devserver). File drag-in stays excluded by design, and an origin-aware ACL parity test now fails the build if a command ships without reach on any window class. Self-hosted gateways on other domains remain uncovered for now.
- **`cs paste` no longer hangs.** When a browser parks the clipboard read on a permission prompt, the window shows a chan-owned card ("cs paste is waiting for this window's clipboard") with Paste and Cancel: Paste completes the read inside a real click (one prompt at most, no more double-prompt denials), Cancel unblocks the CLI immediately, and the server's 30s timeout is now typed and self-explanatory. Image/HTML clipboard commands degrade to the same web path instead of surfacing raw ACL errors.
- **Sleeping the laptop no longer strands gateway devserver windows.** No layer sent keepalives, so post-sleep sockets were half-open zombies: windows froze while the launcher stayed green. The watcher socket now runs a 20s ping / 45s read-deadline plus a wall-clock wake detector, so stuck windows flip to the existing Reconnecting overlay (Reconnect / Abandon) within a minute of wake; terminals recycle their PTY sockets without losing scrollback; and a devserver whose feeds stay dark turns its launcher dot red with a "Disconnect lost connection" button instead of lying green.

### Operators

- New optional profile-service env `DEVSERVER_RETENTION_MINUTES` (absent = 15, `0` = disabled). The sweeper only runs when `DEVSERVER_ADMIN_TOKEN` / `DEVSERVER_ADMIN_URL` are configured on profile-service; note a sweep deletes the row's shares and label permanently (the item's intent; re-grant recreates the row).
- Scripts wrapping `cs paste` / `cs copy`: timeout is now exit 124, not 1.
- Front proxies must not send a `Permissions-Policy` header denying `clipboard-read` on the devserver wildcard host (the paste card needs it in plain browsers).
- Desktops 0.69+ grant native IPC (picker, Downloads writes, OS clipboard) to windows on `https://*.devserver.chan.app`; if you terminate that wildcard somewhere unusual, review before rolling.

## [v0.68.0] - 2026-07-15

v0.68.0 brings multiple devservers per gateway account with a sign-in picker, a one-time-code desktop sign-in handoff, Export to PDF through the Inspector and `cs export`, live-collaborative Excalidraw boards, an operator token mint, and retry-idempotent PPA publishing.

### Added

- **Multiple devservers per gateway account.** A user can keep up to `MAX_DEVSERVERS_PER_USER` live devservers (default 100; `0` removes the cap; the legacy `MAX_WORKSPACES_PER_USER` name is still honored). Each devserver is reachable at its own `{user}--{disc}.devserver` host (the disc is the first 12 hex chars of the devserver id); the bare `{user}.` host keeps working, resolving through the credential when several are live. Share links accept a `?d=` selector and the dashboard copies per-devserver links. The desktop sign-in consent page lists your devservers and the ones shared with you; the pick is recorded and every desktop connect targets exactly that devserver, with a clear re-pick path when a grant is revoked. Usernames may no longer contain `--` (reserved as the host separator).
- **Export to PDF.** Markdown documents and slide decks export to PDF from the file Inspector and from the command line: `cs export <path> [--format pdf] [--out <path>]` renders in a connected workspace window and writes the file into the workspace. Output matches what the editor renders (mermaid and excalidraw diagrams, images, themes); documents paginate onto portrait A4 with page-break support, decks land one slide per landscape A4 page. No browser print dialog or platform print API is involved.
- **Excalidraw boards are live-collaborative.** Boards open into the same shared-session model the editor uses: everyone converges on the same scene through element-level last-writer-wins, peers' pointers show live, tabs carry the same presence badges, and saves/conflicts behave like the editor's. Source-mode edits and external file writes fold into a live session instead of conflicting with it.
- **`chan-gateway-admin token create <email> --scope tunnel`.** Mints a PAT for a user directly through the new identity operator surface (gated by `IDENTITY_ADMIN_TOKEN`); the secret prints exactly once.
- **Close pane from the pane menu.** The pane hamburger menu ends with a separator and a Close pane row, matching the command launcher entry.

### Changed

- **Desktop sign-in hands off a one-time code instead of the token secret.** The `chan://` callback fragment now carries a single-use, 120-second redemption code; chan-desktop redeems it over HTTPS for the token. The secret never sits in the handoff page. BREAKING: desktops older than 0.68 cannot sign in against a 0.68 gateway and must upgrade.

### Fixed

- **Live sessions no longer trust a lying filesystem.** The doc and scene session reconcilers identified their own save echoes by mtime alone and trusted a single read enough to replace a live session wholesale; on filesystems that re-stamp mtime after an async upload or serve stale/empty read-after-write (Google Drive FUSE clients), a session's own save came back as an "external edit" that blanked every attached editor and could persist the blank to disk. Sessions now recognize their own recent content by hash, corroborate suspicious reads (empty, or divergent while edits are unflushed) with a second observation before folding them in, heal a refused lying read by re-flushing the live content, and serialize flush/reconcile IO per session (also fixing a filesystem-independent race that could revert mid-save typing).
- **distros-publish re-runs are safe after a transient Launchpad failure.** The PPA path skips series Launchpad already accepted (asked via the Launchpad API) and retries the rest with bounded backoff, so re-running the workflow after an FTP 550 no longer needs a manual local rebuild and never re-uploads a duplicate. An sftp upload method is plumbed behind an optional `LAUNCHPAD_SSH_PRIVATE_KEY` secret.

### Operators

Rollout notes for the gateway deploy (prod agents: read before rolling this version):

- BEFORE deploy: `SELECT username FROM users WHERE username LIKE '%--%'` must return no rows; `--` is now reserved as the devserver host separator (new signups already reject it).
- `MAX_DEVSERVERS_PER_USER` replaces `MAX_WORKSPACES_PER_USER` (legacy name still honored when the new one is unset). The unset default changed from unlimited to 100; set `0` to remove the cap. Packaged env templates ship the new name.
- New optional env `IDENTITY_ADMIN_TOKEN` enables `POST /admin/v1/tokens` (operator PAT mint, used by `chan-gateway-admin token create`); unset = surface answers 404.
- Desktops older than 0.68 cannot sign in against a 0.68 gateway (one-time-code handoff); upgrade desktops with or before the gateway.
- Optional CI secret `LAUNCHPAD_SSH_PRIVATE_KEY` switches PPA uploads from ftp to sftp; without it the new skip/retry logic still applies over ftp.

## [v0.67.3] - 2026-07-13

v0.67.3 stops gateway devserver windows from reload-looping so their shells finally attach, and quiets two boot-time 404s on terminal windows.

### Fixed

- **Gateway devserver windows hold steady and shells attach.** Every window-feed push re-minted the short-lived gateway entry credential into the window's launch identity, so each push renavigated every open devserver window: the page reloaded, the reload changed window state, the change pushed the feed, and the loop sustained itself before a terminal could attach. Navigation credentials are now minted only when a window actually opens, retargets, or reloads, and a re-mint no longer counts as a change. The open path also closes several lifecycle races: a window closed or disconnected during a slow mint stays closed, transient mint failures retry on a bounded cadence, and Cmd+R on a devserver window resolves a fresh entry URL instead of landing on the bare origin.
- **Terminal windows no longer log two 404s at boot.** Terminal-only windows skip the workspace-onboarding preflight poll and the screensaver-state load; the slim terminal tenant has no workspace and never served either endpoint.

## [v0.67.2] - 2026-07-12

v0.67.2 makes gateway devserver windows actually open in chan-desktop and keeps the devserver window feed alive through per-window failures.

### Fixed

- **Gateway devserver windows open natively.** chan-desktop built each window's gateway entry path with a doubled leading slash, which id.chan.app correctly rejected; the failed mint then silently tore down the devserver window feed, so clicking a terminal or workspace under a connected devserver created the window remotely but never opened it on the desktop, and the launcher's window list went stale. The entry path is now normalized, one window's failed entry mint no longer takes the whole feed down (that window is held back and named in a warning instead), an identity outage no longer closes windows that are already open, and a dead feed now logs a rate-limited warning instead of looping invisibly at debug level.

## [v0.67.1] - 2026-07-12

v0.67.1 fixes the chan-desktop gateway sign-in that Chrome's CSP blocked at the Authorize click, restyles the id.chan.app consent flow to match the site, and teaches bare `cs session self` to report who you are.

### Added

- **`cs session self` shows who you are.** Bare invocation (previously a usage error) reports your window, effective name, role, status, whether you hold the leader slot, and your gateway identity when one exists, rendered as a field table; `--json [--pretty]` emits the raw record. `--name` and `--reset` behave as before, and the wire shape is unchanged, so mixed client/server versions degrade cleanly.

### Fixed

- **Desktop OAuth sign-in completes in Chrome.** The consent page's `form-action` CSP blocked the redirect to `chan://auth/callback`, so clicking Authorize did nothing. The confirm POST now answers with a handoff page (auto-continue plus an "Open chan-desktop" fallback link, and a note that the tab can be closed) that carries the callback outside any form redirect chain; deny and blocked outcomes ride the same page. The fix is server-side: existing desktops work as soon as the gateway deploys.
- **No spurious sign-in error after the handoff.** Re-clicking the handoff page's link after sign-in already completed used to banner "no sign-in in progress" over a successful sign-in; duplicate callbacks are now ignored.

### Changed

- **id.chan.app consent and handoff pages match the site.** Both server-rendered pages share the SPA's dark card look (chan mark, brand-orange primary action) instead of the previous unstyled light page.

## [v0.67.0] - 2026-07-11

v0.67.0 brings live co-editing with named peer cursors to shared files, makes co-viewed windows converge live, gives every session participant a name, and narrates gateway devserver sign-in and connect failures in the launcher.

### Added

- **Live co-editing.** Opening the same file in two clients (a second window, a gateway browser session, or a split pane) now edits one shared document: keystrokes converge live through a per-document server authority instead of last-save-wins, the dirty dot means only "keystrokes not yet confirmed", and saving becomes a flush the server acknowledges, so the conflict modal never appears while attached. External writes (an agent's `echo >>`, a `git checkout`) merge into open editors in place of the "changed on disk" banner, `/api/files` reads and writes on an open document stay coherent with what editors see, and undo only ever rewinds your own edits. Editable text files under 2 MiB in source or WYSIWYG mode attach; read-only tabs follow along without sending. When the channel is unavailable (an old server, a network drop past a short grace) the editor falls back to the classic autosave and conflict detection with a valid token, and localStorage `chan.docsync=0` opts a browser out entirely.
- **Peer cursors with names.** Every collaborator's caret and selection render live in the editor, each in a stable per-person color with a name flag that fades when idle, and file tabs grow a count pill while others hold the same file open. Names resolve from the session roster, and a peer's split panes read as one person, not two.
- **Live layout sync for co-viewed windows.** Two clients holding the same window id (a desktop window plus a gateway browser session, or two tabs sharing a `?w=` URL) now converge within about a second: pane splits, closes, and resizes, tab opens, closes, and moves, A/B side flips, hybrid themes, and terminal titles apply in place without a reload. Unsaved editors survive a peer closing that tab (the tab returns to the peer on the next save), terminals reattach to the same PTY by session id instead of respawning, and each client keeps its own focus, caret, and scroll. The server broadcasts a `session_changed` frame after every session blob write; receivers refetch and reconcile structurally, so convergence needs no op stream.
- **Session participants always have a name.** `cs session list` and the session roster never render an empty name cell: participants arriving through the gateway tunnel show `Display Name <email>` as resolved by the gateway when their entry was minted, and every participant gets a generated default name that is stable across reloads. An explicit `cs session self --name` still wins; the new `cs session self --reset` clears the override back to the identity or default; empty names are rejected and accepted names are trimmed and capped.
- **Gateway sign-in narration in the launcher.** Connecting a devserver through a pasted gateway URL now marks the row "Waiting for sign-in in your browser..." while OAuth runs, and failures explain themselves instead of showing nothing: sign-in denied, cancelled, or timed out; signed in but no devserver registered; or a registered devserver that is offline, named by label. A revoked token self-heals into a fresh sign-in instead of a dead end. The desktop entry endpoint's 404 body carries machine-readable reasons; mixed old/new desktop and gateway versions degrade to the previous generic message.

### Fixed

- **Terminal find works.** Cmd+F on a focused desktop terminal opens the find bar, and matches highlight on every surface; the search addon previously threw on its first decoration and the desktop find chord never reached the terminal.

## [v0.66.1] - 2026-07-08

v0.66.1 hardens the devserver lifecycle around control terminals, sockets, and restored terminals, queues terminal surveys, and lands a round of editor, launcher, and pane polish including slide decks and diagram copy.

### Added

- **Apps in the pane hamburger.** The pane hamburger menu carries the app-spawn rows (terminal, file browser, graph, draft, diagram, slide deck, dashboard, team), alphabetical, showing assigned shortcuts, between the navigation items and the focus-border colours; workspace windows only.
- **New slide deck.** A new Apps command creates a draft pre-seeded with the slides frontmatter, opening with the caret on the first slide heading; `POST /api/drafts/new` accepts `{"kind":"slides"}`.
- **Copy on rendered diagrams.** Fenced mermaid and mermaid-to-excalidraw blocks and inline `.excalidraw` embeds gain a Copy action that puts the rendered diagram on the clipboard as PNG (native image IPC on desktop); dark editors copy the light render.
- **A macOS chord for group broadcast.** Cmd+Shift+I on the macOS desktop toggles broadcast select-all for the focused terminal's group; other surfaces bind it through shortcut assignment.

### Changed

- **The empty pane sheds the workspace-path label.** The path no longer renders under the chan mark, and the mark hides on short panes to give the waves room, reappearing when the pane grows. The pane carries no actions of its own; the Apps rows live in the hamburger.
- **Terminal surveys queue per target.** A second survey addressed to the same tab now waits its turn instead of replacing the visible one and starving its caller into a timeout; an overflowing target (100 open or waiting) is refused with an explicit queue-full error.
- **The devserver form tip is shorter.** It keeps only the foreground guidance with a plain `ssh -N` example.

### Fixed

- **The rich prompt survives tab switches.** The prompt stays mounted like the terminal it overlays, and its caret and bubble height persist per terminal across tab switches, window switches, and reloads instead of resetting to the start of the line. A background prompt no longer steals keyboard focus when a delivery completes.
- **Excalidraw embeds get View, and Edit shows the source.** Inline `.excalidraw` embeds now offer the same View action as mermaid diagrams, opening the pan/zoom overlay on the rendered SVG. Edit reveals the `![](...)` source markdown; the raster image bubble no longer opens over it with a broken preview.
- **Control-terminal script exits now resolve the connection deterministically.** A connect script that exits cleanly right after establishing the connection (the daemonizing `chan devserver --service=chan` handshake, within a 10s grace of registration) auto-closes its control terminal and keeps the connection, with no down-mark and no reconnect block. Any script exit after that stops the connection: a clean exit (a forwarded ^C through ssh/lima transports) runs the full disconnect flow, and a failing exit stops the connection and closes the windows but keeps the terminal open so the failure can be read. Previously a healthy connect stranded a "process exited" terminal, and a post-connect script death could leave the connection registered with no control terminal at all. A clean-exit script whose devserver never answers still fails only after the full connect dial budget.
- **Reconnect and Abandon act even while the connect script runs.** Both kill the running script first; Abandon then runs the disconnect flow, and Reconnect runs the disconnect flow followed by a fresh connect. Reconnect previously no-opped while the stale connection was still registered.
- **`cs` survives a devserver restart.** A devserver binds control sockets at a stable per-library path that a restarted instance rebinds, so `$CHAN_CONTROL_SOCKET` in already-open shells keeps working instead of failing with a stale-socket error. Shells opened under earlier versions still carry the old per-pid path until respawned.
- **Restored terminals close cleanly after a devserver restart.** Exiting a shell that survived a restart through the systemd fd store no longer prints `terminal read failed: I/O error (os error 5)`, and the exit reports without a fabricated code 1 (the real status of a reparented shell is unknowable).
- **The editor tab menu draws a single separator** between Page width and Copy path to file; the page-width row's own bottom border no longer doubles the line. The Delete row also drops its misleading Backspace shortcut hint (no such binding exists while an editor tab is focused).
- **A failed excalidraw embed is no longer a trap.** `![](missing.excalidraw)` and render failures show an error face that is clickable: the click reveals the source markdown for fixing, matching how broken raster images behave.
- **The command launcher no longer fires on a no-match Enter.** A query matching no command rests unhighlighted, so Enter does nothing until you arrow into the catalog or click a row.
- **Standalone servers stop probing the focus-colour websocket.** The pane focus-border colour watch only subscribes on desktop surfaces, ending the 404 retry churn a plain `chan open` logged on every boot.

## [v0.66.0] - 2026-07-07

v0.66.0 turns the release candidate into the signed desktop and service release. Settings gains stronger focus handling, pane flips and empty-pane waves are polished, launcher startup and devserver recovery stay responsive, macOS update restarts move into the launcher, Windows ships signed installer artifacts, and `chan devserver --service=chan` becomes the portable background daemon backend.

### Added

- **A launcher update-ready dialog for chan-desktop.** macOS desktop updater installs now emit `desktop-update-ready` to launcher windows with the downloaded version, and the launcher shows an in-window restart dialog. Restart is driven through the narrow `restart_desktop_after_update` app command and a launcher-scoped capability instead of granting broad process restart permissions to remote content.
- **A portable `--service=chan` background daemon.** `chan devserver --service=chan` and `--service=chan --start` now spawn a detached `__devserver-daemon` child, redirect stdout/stderr to the existing devserver log path, wait for pidfile plus health readiness, and return idempotently. `--join` starts the daemon if needed and then attaches as a health watchdog until interrupted; `--stop`, `--status`, and `--restart` manage the same daemon. Tunnel tokens are passed to the child through the environment only.
- **Editor tab menus expose file actions.** The editor tab menu now offers Copy path to file, Delete, and Duplicate between Page width and Close.
- **Windows release packages are Authenticode-signed.** The release workflow signs the CLI exe, desktop exe, and NSIS installer through SSL.com eSigner and verifies signatures before uploading `release-windows`.

### Changed

- **Settings participates in focus and keyboard navigation.** Opening Settings focuses the overlay, its section list uses roving keyboard navigation, and closing Settings pulses focus back to the active Terminal or Editor tab.
- **Pane side flips keep one visual rotation direction.** Moving A to B and then B to A now completes the same full rotation instead of reversing the previous half flip.
- **The empty-pane dotted surface fills the bottom field.** Empty panes pin the dotted wave to the bottom edge during resize, with the visible horizon starting at the top of the bottom region beneath the workspace path.
- **Launcher startup opens the window feed before registry restoration.** New Terminal and other local window operations can respond while workspace/devserver lists are still loading.
- **Reconnect and Abandon expose recovery state.** Devserver disconnect overlays disable duplicate clicks while Reconnect or Abandon is pending and show IPC/ACL errors inline instead of silently leaving the overlay unchanged.

### Fixed

- **Reconnect and Abandon resolve devserver windows through one cached lookup.** Loopback and tunnel workspace windows now use the same window-label-to-devserver mapping, including cached library ids after the live watcher snapshot is hidden or retired.

### Removed

- **Desktop self-upgrade remains macOS-only.** Windows and Linux desktop self-upgrade paths return clear unsupported errors; Linux AppImage self-upgrade is not claimed without signed updater payload/feed validation.

## [v0.65.0] - 2026-07-06

The command launcher becomes configurable. A new Settings surface renders a web form over each chan-library's configuration, every command's keyboard shortcut is reassignable per operating system, and the launcher itself is redesigned as a centered spotlight. Reload and Open Inspector join the launcher, and a batch of editor, graph, pane, and workspace fixes land. Now that shortcuts are reassignable, the opinionated default chords are trimmed to a minimal set, and Settings becomes the sole interactive configuration surface.

### Added

- **A Settings configuration surface.** Opening "Settings" from the command launcher brings up a web form over the per-library configuration, grouped into Appearance (with a per-surface body theme), Editor, Terminal (with a font choice), Files & search, and Keyboard Shortcuts. Each change saves as you make it and reflects live in every open window. A devserver's own configuration is editable the same way from its window.
- **A per-workspace "This workspace" tab.** Opening Settings from a workspace adds a "This workspace" tab (absent from the launcher and workspace-less windows) with that workspace's own controls: index status and rebuild, semantic search and its embedding model, excluded directories, chan-reports, the metadata archive, and screen lock. The device-wide sections stay per-machine.
- **Assign your own keyboard shortcuts.** Every command in the launcher is now rebindable: click its chord to capture a new one, with conflict detection against the rest of the keymap and reset-to-default. Shortcuts are stored per operating system (web, macOS, Linux, Windows), so the set you configure in chan-desktop applies locally and to every devserver you open from it, while a browser client uses the web set. A Keyboard Shortcuts section in Settings edits any OS's chord for any command.
- **Reload and Open Inspector in the launcher.** The WebView reload and the DevTools inspector, previously only in the right-click menu, are now commands in the launcher (Open Inspector on chan-desktop).
- **Jump to a dashboard slide.** New launcher commands jump straight to Workspace status, Indexing status, or About chan.
- **A/B pane sides.** Panes now have side A and side B tab sets, with commands to send the active tab between sides and a side glyph that flips between them.
- **`cs open` accepts graph links.** Passing a `chan://graph?...` URL to `cs open` opens a new graph tab through the same parser the editor uses for graph links.

### Changed

- **The command launcher is a centered spotlight.** The palette opens as a centered capsule that lifts as you type, over a dark scrim so the workspace behind stays readable. Its search row shows a command-prompt cue and reads "Command", and each result row carries a per-category icon.
- **The launcher keeps the full catalog visible.** It stays empty until you type; then the best matches surface in a Results group while the rest of the commands stay browsable below, grouped by category with the active surface pinned first, so nothing is hidden.
- **The launcher opens in a terminal-only window.** Cmd+K and the launcher command now work in a terminal-only window.
- **The launcher's tab commands split into Apps and Tabs.** New terminal, team, draft, graph, file browser, dashboard, and diagram group under "Apps"; the tab operations (Close tab, Reopen closed tab, Next and Previous tab) group under "Tabs". Next and Previous tab now appear in the launcher too.
- **The empty single pane shows the workspace path.** A single empty pane shows the workspace's absolute path (not just its name), with no action buttons. Open the command launcher from the pane menu's Commands item.
- **The pane menu has "Hybrid Nav"**, directly under Commands.
- **A config file edited outside chan refreshes open windows.** Editing a configuration file directly, or through `chan config set`, now refreshes any open window without a reload.
- **Default keyboard shortcuts are trimmed to a minimal set.** With shortcuts now reassignable, the opinionated spawn, navigation, and pane / tab chords (New draft, Graph, Dashboard, File browser, Team Work, and the pane split / nav / close / kill chords) no longer ship a built-in default; bind the keys you want in Settings > Keyboard Shortcuts. The non-negotiables stay: Settings (Cmd/Ctrl+,), Search (Cmd+Shift+S on macOS, Ctrl+Alt+S elsewhere), the Cmd+K launcher, and Close tab (now Cmd+W on macOS, with Ctrl+D everywhere as an alternate). The universal conventions stay too (copy, paste, find, editor bold and italic, delete file, Esc). A few kept commands rebind: Close window to Cmd+Shift+W, New terminal to Cmd+T (Ctrl+Shift+T off macOS), Reopen closed tab to Cmd+Shift+T (Ctrl+Alt+Shift+T off macOS), and Rich Prompt to Cmd+Shift+P (Ctrl+Shift+P off macOS). On chan-desktop the native menu accelerators follow the same chords (off macOS, New Terminal is Ctrl+Shift+T and Close Window closes the window on Ctrl+Shift+W).
- **Back-of-pane configuration duplicates are removed.** The panes still flip and OK returns to the front, but Editor, Terminal, and File Browser backs are shell-only. Graph keeps its read-only colour legend, and Dashboard keeps the slot navigator plus the Workspace recent-workspaces list. Settings is the only interactive configuration surface.
- **Pane flipping uses a stronger 3D card effect.** A/B side flips now use the pane's shape to choose the flip axis, and tab labels fade only when the label does not fit the tab title space.
- **The desktop reconnect follow-up is deferred.** The rc3/rc4 smoke accepted the current reconnect behavior, so this closeout does not change the reconnect path.

### Fixed

- **A stuck "PTY did not report CWD" notification.** It could linger with no way to dismiss it; it is now dismissable, as is the editor's "copy failed" notification. The copy-path and new-file commands are offered only where a working directory is available.
- **"Copy path to $CWD" now copies.** The command focuses the terminal and writes through the desktop clipboard, copying the absolute working directory.
- **Enter after pasting an image into a list continues the list** instead of breaking out of it.
- **Copying an editor image copies its markdown.** Cmd+C, the context-menu Copy, and the hover copy icon now put the image's markdown on the clipboard, so it pastes and re-renders.
- **Reopening the last tab after deleting a draft opens a fresh draft** instead of trying to reopen the just-deleted file.
- **A stale full-line selection highlight** after repeated word-select-then-undo in the editor (chan-desktop).
- **The pane menu could open partly off-screen** when a pane transform was mid-animation; it now stays within the window.
- **Graph directory scopes keep their spine edges.** Directory-scoped graphs keep ancestor directories visible, so selected files stay connected to the visible directory tree.
- **Graph expansion keeps the target in view.** Launcher and graph inspector expansion paths preserve viewport framing when they open or expand a focused node.
- **Close shortcuts explain hidden-side blockers.** Ctrl+D, Cmd+W, and Cmd+Shift+W keep the pane/window open when the visible side is empty but the other side still has tabs, and the A/B button flashes amber to show what blocked the close.

### Security

- **Hardened devserver access over the tunnel.** Writes to a tunneled devserver carry a double-submit CSRF token, origin and session checks are tightened, the local IPC sockets are created with 0600 permissions, and chan-desktop pins the gateway's identity assertion.

## [v0.64.0] - 2026-07-05

A Cmd+K command launcher lists, filters, and runs every UI action; New diagram seeds an Excalidraw board like a draft; the tab right-click menus shed everything the launcher now owns; and the Inspector's hanging Export-to-PDF is gone.

### Added

- **A Cmd+K command launcher.** A Spotlight-style palette (Cmd+K on macOS; Ctrl+Alt+K on the web and Linux / Windows, so a focused terminal keeps plain Ctrl+K) lists every UI action grouped by category, filtered to what the current window and active tab can do, with each command's current chord shown beside it. Sections and rows sort alphabetically with the active tab's surface pinned first. Type to fuzzy-match over title and keywords, arrow to move, Enter to run, Esc to close; it opens from a focused terminal too. Chords are read-only for now.
- **New diagram.** Creates a seeded Excalidraw board the way New draft creates a note: a draft directory holding a `<name>.excalidraw` you can draw on, promote to a location on close, or discard. Reachable from the command launcher.

### Changed

- **Tab right-click menus keep only what belongs beside the surface.** The terminal, editor, graph, and file browser tab menus now show their surface controls (group broadcast, page width, graph depth and filters, the file browser dock toggles) plus Close; every other action they used to list is reachable from the command launcher instead.
- **The launcher titles the machine list "Computers" and the local block "This machine."** The top bar reads "Computers" over "This machine & devservers", and the local machine block header reads "This machine".

### Fixed

- **A workspace held open by another machine shows as locked in the launcher.** The launcher probes the workspace writer lock and, when a live foreign holder has it (another machine, or another process on the same one), shows a lock icon with the toggle disabled and the reason on hover instead of offering a control that can only fail. Its library view stays in sync with live devserver state.

### Removed

- **Export to PDF, everywhere.** The Inspector "Export to PDF" action and its print engine are gone on both web and desktop. On chan-desktop the native macOS export could hang the shell indefinitely, and the feature was inconsistent across web, macOS, and other desktop OSes. The PDF viewer is a separate feature and stays: opening a `.pdf` still works.

## [v0.63.0] - 2026-07-03

The Rich Prompt composer moves onto the main editor, a devserver whose control script dies keeps a readable terminal and reconnects on demand, and a prerelease tag can no longer push a release candidate onto GA installs.

### Added

- **Reconnect a stuck devserver from its workspace window.** When a devserver's control connection drops, each of its workspace windows shows a reconnecting overlay with a Reconnect button beside Abandon (chan-desktop). Reconnect closes the dead control terminal and re-runs the connection, the same flow the launcher's Connect drives; Abandon gives up on the connection.

### Changed

- **The Rich Prompt composer is the main editor.** Cmd+Shift+P now composes in the same WYSIWYG editor as the rest of chan, so a prompt gets the full editor: inline image rendering, list and markup editing, and the editor's keymap. A pasted image renders inline while you compose and is delivered to the agent as an absolute on-disk path, so the agent reads it regardless of its working directory.
- **A dead control script leaves a readable terminal instead of a vanished connection.** When a devserver's control script exits (the remote drops, the script returns, Ctrl+C), chan marks the connection down but keeps the control terminal open at "process exited" so you can read why it died; the devserver's launcher identity dot turns red and its control row keeps a slow-flashing eye for attention, the launcher stops offering that devserver's workspace and window rows so a click cannot land on a dead connection, and the workspace windows show a reconnecting overlay. The devserver stays un-reconnectable until you close that control terminal (read the reason, then Ctrl+D / Cmd+W), after which it is ready to connect again. Reconnecting never happens on its own; use the launcher's Connect or the overlay's Reconnect.
- **A survey resolved in one window clears it in the others.** Answering, cancelling, or letting a survey time out now closes it in the other windows of its tab group, and an unrelated Rich Prompt composer open at the time is left untouched.
- **Splitting a pane has a direct keyboard shortcut on the web.** Split right is Ctrl+Alt+/ and split bottom is Ctrl+Alt+? in the browser launcher (chan-desktop keeps Cmd+/ and Cmd+Shift+/), so a web session splits panes from the keyboard instead of only through Hybrid Nav.
- **An empty pane shows a dotted backdrop.** The welcome mark and spawn buttons in an empty pane now sit over a subtle dotted surface that follows the light and dark theme, draws at a low frame rate, pauses when the window is hidden, and renders a static frame under reduced motion.
- **A prerelease tag no longer updates the GA self-upgrade pointer.** Publishing a prerelease (a `-rc` tag) ships its build as GitHub Release assets but leaves `/dl/cli/latest.json` and the desktop-updater manifest on the current GA version, so a release candidate cannot auto-upgrade GA installs; only a GA tag moves the pointer.

### Fixed

- **The launcher's Focus and show/hide act on a control terminal directly.** They resolve a control terminal's native window by its own label instead of routing through a composed id that could silently no-op, so the buttons act or report an error rather than doing nothing.
- **List Tab and Shift-Tab step between real indent columns.** Tab on a list line nested it by a blind two spaces, which under an ordered marker landed in a dead band where the item parsed as a lazy paragraph and lost its list rendering until a second press. Tab now nests onto the previous sibling's content column and Shift-Tab pops to the nearest shallower list line, one level per press, across every marker family and multi-line selections, and one press heals a line already stuck in the dead band.
- **A control script that dies mid-connect fails fast with its own reason.** The launcher's Connect no longer spins for the full come-up budget and then reports a misleading "did not come up in time" when the control script exits during connect; the wait aborts within one backoff of the script exiting, and the control terminal stays at "process exited" with the real reason.

## [v0.62.0] - 2026-07-03

Polish and cleanup: one alert surface and one connecting surface (both theme-aware), the wysiwyg list-typing regression fixed, launcher parity on web and gateway with a shared theme, and a stack of smaller refinements. No new surfaces.

### Added

- **Copy a doc with its images between windows.** Copying a selection that holds workspace image refs now carries the images: chan writes both the exact markdown (plain text, byte-identical to before for text-only copies) and a self-contained HTML payload with each image inlined as a data: URI. Pasting into another window or workspace recreates the files next to the destination doc with widths, alt text, and alignment preserved; a same-workspace paste into another folder rebases the refs with zero re-uploads; pasting into a plain-text target yields the raw markdown, and pasting into Google Docs or Mail carries text plus images.

### Changed

- **`chan devserver --service` now defaults to `auto`, resolving the backend per-OS at runtime.** With an action verb (`--start`/`--stop`/`--restart`/`--status`/`--join`), auto supervises under systemd on Linux, launchd on macOS, and the self-managed `chan` daemon on Windows, so `chan devserver --join` picks the right manager with no `--service=` flag. With no action verb it runs the plain foreground server, so a bare `chan devserver` still works on every host, including an unrecognized OS. An action verb that cannot resolve a manager (an unrecognized OS, or a Linux box with no `/run/systemd/system`) fails with a clear message pointing at `--service=chan`, and the explicit `--service=none/chan/systemd/launchd` values behave exactly as before.
- **The workspace-root inspector labels match the directory inspector.** The root node's action row now reads Open / Upload file here / Download tarball / New terminal here / Graph from here in both the graph and the file browser, matching a directory's inspector exactly. The actions are unchanged: upload still lands at the root, download still produces the root tarball, and the terminal still opens at the root.
- **Red-dot window close asks first.** The OS close button on a live workspace, terminal, or devserver window now prompts Hide / Close / Cancel before acting, instead of hiding the window and popping an after-the-fact "this window is hidden" notice. An empty window (no tabs) closes straight away and leaves no row behind; a red-dot while the window is reconnecting closes directly; Hide keeps the window's tabs and terminals warm and reopenable from the Window menu; Close discards them and destroys the window. On the web, closing the browser tab keeps sessions and the close-window command clears all tabs. The old hidden-window notice and its machinery are removed.
- **A headless devserver's local web launcher is fully usable.** `chan devserver` now serves the mutable `devserver` launcher surface on its loopback bind: the real Power toggle (mount/unmount a workspace) and self-managed browser windows, instead of the read-only surface it emitted before. The gateway tunnel stays read-only from the same server: a credential-stripped tunnel request is refused registry mutation and served the read-only surface, so a grantee can never flip the owner's workspaces. The bridgeless launcher window rows also mirror the show/hide state, a self-managed surface gets a leader-gated Eye toggle wired to the `/visibility` web op, and the read-only surface shows a static hidden indicator beside the connection dot.
- **The reconnecting overlay reads like the desktop connecting screen.** When the watcher connection drops, the full-app overlay now shows a live elapsed timer and an "attempt N" counter alongside the spinner, so a reconnect reads as active progress the same way the desktop connecting screen does. The desktop connecting screen follows the launcher theme, and a desktop devserver window's Abandon still tears down the connection.
- **The desktop hidden-window notice is themed and readable.** Closing a window to the tray shows a notice that now follows the launcher's light/dark theme and the window's library accent colour, and prints the window's name on its own line (long glyph-heavy names ellipsize) instead of quoting the whole title inside a sentence. The notice window is parameterized (title, body, theme, accent, buttons) so it can carry future prompts, and the About window follows the launcher theme too.
- **The launcher theme drives local standalone terminals.** On chan-desktop, flipping the launcher's light/dark toggle now retitles every open local standalone terminal window live and boots a newly opened one to match, persisted in the desktop config. Workspace windows keep their own per-device Appearance setting, and a devserver-attached or remote terminal is unaffected (its host has no local theme). A terminal with no launcher choice set follows the OS appearance as before.
- **`cs` workspace commands refuse clearly on a standalone terminal.** `cs session`, `cs graph`, `cs search`, and `cs terminal team` (including `--script`) now refuse from a standalone terminal window with a consistent "only available in a workspace window" message, instead of `cs session` silently succeeding against a session it cannot lead and `cs terminal team --script` emitting a bootstrap it cannot run. A stale `$CHAN_CONTROL_SOCKET` (the chan window or server that spawned the terminal has exited, common after a devserver restart) is reported in plain words instead of a raw connect trace.
- **Opening a slides file reveals the Outline.** A markdown file that declares `kind: slides` in its `chan:` frontmatter block opens with the Outline panel already showing, where the Preview and Present controls live. It fires only on a first open, so closing the Outline and reloading keeps it closed, and a plain markdown file is unaffected.

### Fixed

- **Dismissing a confirm dialog returns focus to the terminal.** The in-app confirm modal parks focus on its OK button at open and never restores it, so after Esc, Cancel, or an outside click the caret fell to the page body and typing went nowhere until a click. `uiConfirm` now captures the pre-modal focus target and `resolveConfirm` restores it on both accept and cancel, so the close, restart, delete, rename, and draft-discard prompts all return the caret to their invoking surface with no click.
- **Slide play mode goes truly fullscreen in chan-desktop.** WKWebView disables the HTML element Fullscreen API, so playing a slides file opened the player in-window instead of edge-to-edge. The player now drives the native window through Tauri's built-in window fullscreen command on desktop and keeps the browser fullscreen path on the web, so Cmd+Shift+Enter fills the screen and Escape restores the window. The slide backdrop is also fully opaque now, so the presenter surface reads as one clean stage instead of showing the editor's tab bar and pane divider bleeding through as a two-tone seam.
- **Mention nodes graph from here.** A `@@mention` in the graph inspector now offers "Graph from here" whether or not it resolves to a contact note: a resolved mention opens the contact lens, an unresolved one opens the mention lens scoped to `mention:@@Name`. Clicking a mention's kind chip now lands a mention scope instead of a bogus tag scope. Tag behavior is unchanged.
- **Excalidraw whiteboard tabs no longer leak their zoom and undo controls over other tabs.** An inactive canvas tab now hides its board with `display: none` instead of relying on the ancestor's `visibility: hidden`, which WKWebView ignores for the composited Excalidraw footer island under the flip-card's `preserve-3d` context. The board re-measures cleanly on switch-back, and the fix stays scoped to canvas tabs so editor and terminal keep-alive is unchanged.
- **The inspector kind bubble matches the graph node color.** The graph paints file nodes by extension (a `.rs` source node is blue) while the inspector bubble colored by the coarser server kind, so a blue source node opened an orange "text" bubble, and `.txt` and `.rs` (both wire kind `text`) could not be told apart by a token swap. The bubble now shares the canvas's extension classifier: source files read blue, `.txt` and `.md` orange, images and PDFs purple, other files grey, contacts yellow, and the workspace root chip matches the root node. The chip label still reads the file's kind; only the color follows the extension.
- **Restarting the desktop restores the workspaces that were on.** At quit the desktop snapshots the mounted workspace set as on, then tears each workspace down, and the teardown unconditionally recorded every workspace off in the on/off overlay. Teardown blocks up to 5 seconds per workspace, so whether a workspace survived to the next boot depended on how far teardown got before the process died. The shutdown-time close now preserves the overlay, so the on-set snapshotted before teardown survives and the next boot re-serves exactly the workspaces that were on. Interactive toggle-off, `chan close`, and workspace removal still record off as before.
- **Session leadership is origin-scoped: every local window is a leader, only remote sessions follow.** Session role was keyed to per-window join order, so the first window of a workspace led and every later window on the same machine read follower, including two standalone terminals or two windows of one workspace on one desktop. Role is now derived from the connection's origin over the existing tunnel-vs-loopback seam: a `/ws` that arrived local (the desktop's loopback bind, or an `ssh -L` forward to a devserver) reads leader, and only a genuinely remote gateway or browser session reads follower. The single designated-owner slot that handover routing and the launcher window gate consume stays one window but is elected local-first, so a real remote-only session still keeps a working owner and handover target. The status-bar role badge now shows only when a roster is genuinely split, so a sole-user all-local session stays quiet and the badge returns the moment a gateway browser joins.
- **Mermaid diagrams in an excalidraw fence render at a sane size.** A `mermaid-to-excalidraw` fence laid its diagram out about 1.5x larger than the same source in a plain mermaid fence, because the excalidraw conversion re-renders at a larger font with hand-drawn stroke padding. The exported SVG is now scaled back down to match. The hover View overlay still opens the diagram at full size and zooms crisply, and a user-authored `.excalidraw` file embed is unaffected.
- **A stuck status error can be dismissed.** The one-shot create, rename, upload, and paste errors that surface in the top-right status pill had no way to clear, so a single failure sat there until another status overwrote it. Persistent errors now carry a close button. The unified New File or Directory dialog also rejects an unknown file extension inline, mirroring New File, instead of round-tripping to a server error that then stuck in the pill.
- **Markdown lists render again below a `---` line, and while you type.** A document whose first line is `---` with no closing fence no longer collapses the whole parse into one empty block, so the horizontal rule, headings, lists, and task lists below it all style correctly. Bullet (`-`, `*`, `+`), ordered, and task markers behave identically. The wysiwyg decorations also refresh the moment the background parse finishes, and the decoration walk now forces the parse through the visible range before it runs, so a list you just formed (a `- ` marker added to a line, a lazy continuation) decorates immediately instead of lingering as a raw marker until an unrelated edit or click. On chan-desktop specifically, hyphen and ordered markers now render through the same replace widget the `*` / `+` glyphs use, so typing `- ` or `1. ` flows the item immediately in WKWebView instead of only after a scroll or another keystroke (WKWebView deferred the repaint of the old class-only marker decoration; Chrome and WebView2 were unaffected either way).

## [v0.61.0] - 2026-07-02

Interactive Excalidraw whiteboard tabs and markdown slide preview in the workspace app, plus desktop-PWA and leader/follower session integration for the launcher and multi-window sessions.

### Added

- **Interactive Excalidraw whiteboard tabs.** An `.excalidraw` file opens as an editable [Excalidraw](https://excalidraw.com) board in the workspace app, alongside the markdown, JSON, and CSV renderers. Draw on the canvas and it autosaves like any file tab; Mod+E flips between the board and its raw scene JSON. Session restore reopens the board, the 409 conflict dialog and the changed-on-disk banner apply unchanged, a theme flip re-themes the live canvas, and Ctrl+D duplicates on the board instead of closing the tab. Excalidraw and its React runtime are dynamic-imported, so the board stays out of the eager editor bundle. Creating a board works too: `.excalidraw` joins the editable-text set the workspace write gate accepts.
- **Markdown slide preview.** A markdown file that declares `kind: slides` in a `chan:` frontmatter block presents as slides. Pages split on `@pagebreak` (or an `<hr class="chan-page-break">`), and the frontmatter tunes the slide `aspect_ratio` (16:9 or 4:3) and `zoom_factor`. Preview and present flows render each page theme-aware with keyboard navigation, page-width and zoom controls, and media alignment, and Mermaid and Excalidraw diagrams (including read-only Excalidraw images) render inside the slides. The current slide and preview mode persist per tab across reloads, and the file outline groups its headings by slide page.
- **Installable launcher PWA.** The launcher serves a web app manifest at `/manifest.webmanifest` (root scope) with maskable app icons and a themed titlebar, so it installs as an app from the fixed-port devserver loopback and the https gateway origin. There is no service worker, and the workspace-app shell carries no manifest link, so an installed app captures the launcher and not any single workspace.
- **Leader/follower session windows.** A self-managed launcher (devserver or PWA) opens its own in-app browser windows and gates window creation on per-tenant leadership: the window that leads a workspace manages that workspace's windows, and a follower launcher sees the create controls disabled. The workspace status bar shows this window's session role whenever more than one window shares a session. When the leader closes or hides a window, that window shows a "closed by the leader" or "hidden by the leader" overlay instead of sitting stale.
- **Desktop "Open in Browser".** A Window-menu item opens the focused workspace window in the system browser through a browser-affinity window record, so chan-desktop never opens a native twin for it.

### Changed

- **Launcher capabilities are split by serving surface.** A `chan-launcher-surface` descriptor (desktop, devserver, or readonly) replaces the single read-only boolean and splits registry mutation, the desktop bridge, and self-managed windows, so a bridgeless local devserver is fully usable instead of forced read-only. Desktop and gateway surfaces behave exactly as before.
- **`/ws` sends a session roster snapshot on connect.** Every socket, tagged or untagged, receives the current roster the moment it connects, fixing a reload overlap where a reconnecting window sat on an empty roster until an unrelated change. A window's session role is now correct immediately after a reload.
- **Window mint, close, and visibility are leader-gated per tenant.** On a self-managed surface, only a tenant's leader (or a leaderless tenant) may mint, delete, or change the visibility of a window, and a mismatching claim against a live leader is refused. This is honest-client enforcement, not a security boundary: the acting window id is client-claimed behind the shared launcher bearer, so it double-enforces a UI affordance rather than establishing trust. The desktop launcher, which sends no acting id, is never blocked.
- **Browser-minted windows stay in the browser.** Each window record carries a client origin, native or browser, and chan-desktop's watcher opens only native records, so a window minted from a browser never gets a native twin (on both the local and the devserver watcher).

### Fixed

- **The excalidraw fence renderer self-hosts its fonts.** The `mermaid-to-excalidraw` diagram renderer fetched its label fonts from the esm.sh CDN at render time, so diagram text degraded silently offline and on chan-desktop. The fonts now ship in the bundle and load locally, composed prefix-aware for served workspaces and desktop windows. The 12.7 MB CJK family is excluded, so CJK boards still fall back to the CDN.
- **A follower window no longer deletes the session's layout.** On the web, a follower emptying or unloading its view no longer removes the session's persisted layout blob, which belongs to the leader. A solo web window and every desktop window still manage their own.

## [v0.60.0] - 2026-07-02

The axum 0.8 migration release: both Cargo workspaces (the root workspace behind chan-server, chan-library, and the tunnel crates, plus the gateway services) move from axum 0.7.9 to 0.8.9, carrying tower-sessions 0.14, tokio-tungstenite 0.29, and a dead-dependency drop with them. Behavior is preserved and pinned by routing tests on both framework versions. The `v0.60.0-rc1` smoke surfaced one bug, fixed here: `chan upgrade` now understands prerelease versions.

### Changed

- **The root workspace serves on axum 0.8.** The HTTP/WebSocket framework under chan-server, chan-library, and the tunnel crates moves from axum 0.7.9 to 0.8.9; the 0.7 line no longer receives bug or security fixes. Route matching, the launcher root fallback, workspace-prefix dispatch, and wildcard captures behave exactly as before, now pinned by routing tests; WebSocket text/binary frames are bytes-backed internally, which drops a per-send allocation on two terminal control payloads. One edge sharpens: the terminal restart route still restarts with defaults on a bodyless request, but a request that declares a Content-Type now rejects with a 4xx (415 non-JSON type, 400 malformed JSON, 422 mismatched shape) instead of silently restarting with defaults (no shipped caller sends any of those). The unused tower_governor dependency is dropped from chan-tunnel-server, clearing the last axum 0.7 subtree from the lockfile.
- **Gateway services move to axum 0.8.** The `gateway/` workspace (identity, profile, devserver-proxy) now builds on axum 0.8, with tower-sessions 0.14, tower-sessions-sqlx-store 0.15, and tokio-tungstenite 0.29. Route templates use the axum 0.8 `{param}` syntax, and the devserver-proxy WebSocket bridge translates text frames and close reasons between axum's and tungstenite's `Utf8Bytes` wrappers. tower-sessions stops at 0.14 because no released sqlx-store pairs with 0.15; tokio-tungstenite matches axum 0.8's internal minor so the gateway's direct dep adds no second tungstenite. Session and auth behavior are unchanged.

### Fixed

- **`chan upgrade` understands prerelease versions.** `X.Y.Z-pre` now validates and orders correctly: a prerelease is newer than every lower release and older than its own release triple, with `rcN` ranking numerically (`rc2` before `rc10`). Previously a client hard-errored on prerelease metadata ("release version patch component must be numeric") while an rc was the latest release, and an rc install could not parse its own version, so it would never have offered the next upgrade. `chan upgrade --version X.Y.Z-pre` is accepted too.

## [v0.59.1] - 2026-07-01

A patch release clearing the v0.59.0 chan-desktop known limitation: a `mermaid-to-excalidraw` diagram that uses a `subgraph` now renders as excalidraw on desktop, not just in the browser. It also reverts the v0.59.0 launcher column alignment in favor of a left icon column, and swaps the remote window-title glyph to an up-right arrow.

### Fixed

- **Excalidraw diagrams with a `subgraph` now render as excalidraw everywhere.** A `mermaid-to-excalidraw` flowchart containing a `subgraph` failed to convert (logging `SubGraph element not found`) and left an error or a rasterized image in place of the diagram — the v0.59.0 chan-desktop known limitation. The root cause was a bug in `@excalidraw/mermaid-to-excalidraw`: mermaid 11 renders subgraph cluster elements with a render-id prefix (`id="diagN-Machine"`), but the library looked them up by exact id (`[id='Machine']`) instead of the prefix-tolerant match its node/edge lookups use, so the cluster was never found. Patched via `patch-package`, so subgraph flowcharts now convert to real excalidraw shapes in both the browser and chan-desktop. As an added safety net the excalidraw block also degrades to the plain `mermaid` renderer if a conversion ever fails on otherwise-valid mermaid source, so a diagram always shows and only genuinely broken source surfaces its error.
- **Launcher devserver identity reads as a left icon column.** Each devserver now leads its two rows with an icon — the Globe kind mark on the name row, the OS mark directly under it on the `host:port` row — so they align as one left column; the OS mark moves off the name row and the connected status dot stays on it. This also reverts the v0.59.0 `--rail-step` button-column alignment, so launcher button groups return to their per-element spacing and the "Library" title sits flush-left again.
- **chan-desktop remote windows use an up-right-arrow title glyph.** Remote/devserver window and terminal titles now use ↗ instead of ⊕, which rendered as a plus in the macOS title-bar font; the glyph stays monochrome line-art. The launcher's Globe and the local-window glyphs are unchanged.

## [v0.59.0] - 2026-07-01

A broad feature release: a `mermaid-to-excalidraw` diagram renderer, graph focus and lens fixes with an indexing placeholder, an actionable indexing dashboard, the `chan devserver --service` action-verb reshape, editor list and directory-link fixes, `cs copy` / `cs paste` clipboard bridging, a semantic-search opt-out that never embeds when off, and chan-desktop window-geometry, glyph, and clipboard fixes.

### Added

- **Smart list-row paste.** Pasting a copied list row into a continued list item now merges into that bullet instead of leaving a double marker, matching the existing rich-paste behavior for chan-to-chan plain-text copies.
- **Excalidraw diagram renderer.** A fenced ```` ```mermaid-to-excalidraw ```` block renders as an [excalidraw](https://github.com/excalidraw/mermaid-to-excalidraw) scene in the editor, alongside the existing `mermaid` renderer and sharing its whole lifecycle: cursor-out flip-in, a hover "View" pan/zoom overlay (always presented on a light panel so a dark-theme diagram stays visible), light/dark theming, failing-line error accents, and keep-alive across tab switches. Both fences run through one diagram widget now; excalidraw and its React runtime are dynamic-imported, so they stay out of the eager editor bundle. On chan-desktop, a mermaid-to-excalidraw diagram that uses a subgraph does not render in this release (it renders in the browser); a known limitation tracked for 0.59.1.
- **`cs copy` / `cs paste` clipboard bridge.** New `cs copy` and `cs paste` commands bridge the embedded terminal's stdin/stdout to the system clipboard for text, images, and HTML, on both the web UI and chan-desktop. For example, `cs paste > file.png` writes a pasted image to a file, and `cs copy < file.png` puts an image on the clipboard to paste elsewhere; when the clipboard holds both an image and text, the image wins.

### Fixed

- **Supervised devservers honor `CHAN_HOME`.** `chan devserver --service=systemd`/`--service=launchd` bake `CHAN_HOME` into the generated unit `Environment=` and plist `EnvironmentVariables`, so the supervised service and the supervisor share the same isolated `~/.chan` and the bearer-token handshake resolves under isolation.
- **Semantic search off means no embeddings.** With semantic search disabled, chan no longer computes or stores embeddings just because a model is cached on disk; the workspace opt-in is the only input to indexing. Turning semantic search off bins the existing vector store (keyword/BM25 search is unaffected), and turning it back on rebuilds embeddings from scratch.
- **Directory links open the file browser.** A markdown link to a directory now renders as a valid directory link and opens the file browser at that folder, instead of showing as broken and rejecting the click with a "not a text file" notification.
- **List continuation lines hang-indent, and ordered lists align with bullets.** Wrapped continuation lines of a list item now hang under the item text across every list type and nesting depth (tasks included), and ordered (numbered) lists indent to the same width as bullet and hyphen lists.
- **`@@mention` / `#tag` / contact graph lenses keep every surfaced document's semantic edges.** A "Graph from here" on an `@@mention` (or a tag or contact) surfaces each document that references the seed together with every one of that document's own `@@mention` / `#tag` / language edges, so a co-referenced handle no longer drops out of the view.
- **Crisp diagram zoom overlay.** The hover "View" pan/zoom overlay for `mermaid` and `mermaid-to-excalidraw` diagrams stays sharp at every zoom level. Zoom now resizes the SVG so the browser re-rasterizes the vector at each step instead of GPU-scaling a cached bitmap, which blurred strokes and text and could read soft even at 1x on HiDPI; panning still rides a compositor transform. An excalidraw diagram that bakes a mermaid subgraph to an embedded raster stays limited by that source image.
- **Desktop windows keep their size across hide/show on a second monitor.** chan-desktop stores and restores window position and size in logical points instead of physical pixels, so hiding a window on a secondary display and showing it again keeps its size (it previously shrank, and shrank further on each repeat).
- **Launcher column alignment.** The launcher's action-button columns and the identity column line up.
- **Image and rich-text clipboard work on chan-desktop.** The desktop clipboard image and HTML IPC commands that `cs copy` / `cs paste` use are granted in the app permission set, so image and HTML copy/paste work on chan-desktop instead of being denied at runtime.

### Changed

- **`cs open` from a standalone terminal points at `chan open`.** Running `cs open PATH` in a standalone terminal (which has no workspace to open a path into) now prints friendly guidance to run `chan open PATH` to load it as a workspace window, instead of the generic "needs a workspace" refusal. The standalone-vs-workspace command gate is now a single pure, unit-tested decision, and `cs upload` / `cs download` keep working from both a standalone terminal and inside a workspace.
- **`chan devserver --service` uses explicit action verbs.** `--service=none` (the default) runs in the foreground with no supervision; `--service=chan` is the foreground self-managed daemon; `--service=systemd`/`--service=launchd` are detached background services that each require one of `--start` (write/enable/start, then return), `--stop` (stop and disable, so it does not return on boot or login), `--restart` (bounce, then return), `--status`, or `--join` (bring it up and stay attached, blocking on health). A bare `--service=systemd`/`--service=launchd` with no verb is rejected, and there is no per-OS auto-pick. Connect scripts use `--service=systemd --join`.
- **Opening a workspace graph focuses the workspace root.** The main-window Graph shortcut, and every other non-lens graph open, lands with the root workspace node selected and its inspector open, so focus-on-select spotlights the root and its first-degree neighbourhood. This matches the lens opens (file / directory / `@@mention` / `#tag` / contact / language), which already open focused on their own node. A manual click still re-selects.
- **An empty markdown graph reads "data being indexed, hang tight...".** A markdown-scope graph with no nodes shows "data being indexed, hang tight...", since an empty semantic graph most often means the index has not populated yet rather than a truly empty workspace.
- **Selecting a graph node lights its full path to the workspace root.** Clicking a directory, file, contact, symlink, or media node now spotlights and labels its entire containment spine, every ancestor directory up to the root, not just the immediate parent, so the path home reads at a glance. Tag, mention, and language nodes carry no containment edge, so their focus is unchanged.

## [v0.58.0] - 2026-06-30

A reconnect polish release: Linux systemd restarts preserve live terminal replay more reliably, and chan-desktop retargets already-open devserver windows after token rotation.

### Changed

- **Launcher disconnected copy is shorter.** Disconnected devserver sections now show `Not connected.` instead of the longer terminal/workspace loading prompt.

### Fixed

- **Systemd fdstore devserver restarts preserve terminal replay state.** Restart manifests now carry a bounded replay tail alongside each stored PTY fd, restored PTY fds keep read/write access, and live terminal reconnects resume from the in-memory xterm cursor, avoiding false `terminal replay missed N bytes` banners and post-restore `Bad file descriptor` writes.
- **Chan Desktop reconnects existing devserver windows after token rotation.** The native window watcher refreshes already-open devserver webviews when their tenant launch token changes, and Cmd+R rebuilds watched devserver windows from the current feed instead of reloading a stale `?t=` URL.

## [v0.57.0] - 2026-06-30

A devserver correctness release: Linux systemd restarts can preserve live PTYs through fdstore, and `chan close` keeps the devserver launcher state in sync immediately.

### Added

- **Linux systemd devserver restarts preserve live terminal PTYs.** `chan devserver --service=systemd --restart` asks the running devserver to store live PTY masters in systemd fdstore, writes a bounded restart manifest, restarts the user unit, and restores matching sessions into the replacement devserver.
- **`chan-systemd` owns the systemd notify/fdstore boundary.** The new crate wraps `READY=1`, inherited named fd adoption, fdstore add/remove, and `FDPOLL=0` PTY storage behind Linux-only APIs.

### Changed

- **The systemd devserver unit now uses notify readiness and fdstore capacity.** Generated user units include `Type=notify`, `NotifyAccess=main`, `FileDescriptorStoreMax=512`, and `KillMode=process`, so restarts have an observable ready point and PTY masters survive the process handoff.
- **Systemd restart preservation fails closed.** If live PTYs exist but fdstore preparation fails, `--restart` aborts and prints the reason; `--force` keeps the previous destructive restart behavior. Startup restore logs restored/skipped counts, removes consumed fdstore entries, and reaps standalone terminal rows whose PTYs could not be restored safely.
- **Systemd fdstore handoff waits for supervisor acknowledgement.** Restart preparation now sends a systemd notify barrier after uploading PTY fds and writing the manifest; if systemd does not confirm the fdstore state, chan removes the uploaded fds and aborts the preserving restart.
- **Inherited systemd descriptors get stronger process validation.** When systemd supplies `LISTEN_PIDFDID`, chan verifies it against its own pidfd inode before adopting inherited fds, and still clears all activation environment variables before continuing.
- **Devserver connection tokens can be stored or explicitly cleared.** A stored write-only token can authenticate a script-backed devserver connection after the script opens the transport, and editing a devserver with an empty `?token=` clears the stored token.

### Fixed

- **`chan close` reports devserver workspaces off immediately.** Closing a devserver-served workspace through the control socket now makes the management list show `on:false`, `status:"stopped"`, and an empty token instead of leaking the stale in-memory on/token state.
- **`chan close --remove` drops devserver workspace rows immediately.** Removing a served workspace through the control socket no longer lets the devserver's stale workspace map re-grow a removed row into the launcher feed.
- **Launcher workspace actions follow real backend state.** Desktop refreshes a connected devserver's workspace cache after toggle/forget actions, and the launcher disables "new window" while a workspace is not actually running, avoiding queued windows for stopped workspaces.
- **Non-Linux release builds keep the fdstore API quiet.** The fdstore implementation is isolated behind Linux and unsupported modules, so Windows and macOS builds see no Linux-only imports or dead fdstore helper code.

## [v0.56.4] - 2026-06-29

A patch release for wide Markdown table containment in the rendered editor.

### Fixed

- **Wide Markdown tables no longer widen the whole document.** Rendered tables keep their own horizontal scroll area, while normal prose before and after the table still wraps at the configured page-width cap.
- **Page-width capped Markdown keeps its document shape.** A table with long columns no longer pushes CodeMirror's content width past the centered page, avoiding document-level horizontal scrolling and clipped paragraph text.

## [v0.56.3] - 2026-06-29

A patch release for Markdown list alignment and pane shortcut hint correctness.

### Changed

- **Markdown list markers now share one theme contract.** GitHub, Google Docs, and Microsoft Word editor themes use the same bullet glyphs, task checkbox sizing, marker column, and spacing tokens, so marker alignment no longer drifts by theme font.
- **Pane menu shortcut hints come from the shortcut registry.** The pane hamburger now shows only shortcuts wired for the current platform: web keeps split-pane hints blank and shows `Alt+[` / `Alt+]` pane navigation, while native keeps the direct `Cmd/Ctrl` pane chords.

### Fixed

- **Bullet, hyphen, ordered, and task-list markers align consistently.** The WYSIWYG editor renders bullet glyphs, literal hyphens, ordered markers, and task checkboxes through the shared marker column while preserving clickable task checkboxes and the source Markdown.
- **Nested list indentation is reduced to the intended visual depth.** Nested lists now add a 2x default offset instead of the too-wide 4x experiment.
- **Web no longer advertises native-only split shortcuts.** The browser build does not bind `Cmd+/` or `Ctrl+/` for split panes, so the pane menu no longer claims that shortcut while CodeMirror owns it for comment toggling inside the editor.

## [v0.56.2] - 2026-06-29

A patch release for editor list rendering and workspace lifecycle correctness.

### Changed

- **Workspace lifecycle state is owner-side and typed.** Local desktop and devserver workspaces now surface `starting`, `closing`, `removing`, `running`, `stopped`, and `error` from the serving owner so launcher reloads keep the correct row state.
- **Launcher rows lock during owner transitions.** Workspace power/remove controls now spin and stay disabled during `starting`, `closing`, and `removing`; devserver rows also preserve backend `connecting` state across reloads.

### Fixed

- **Markdown list guide bars were removed.** WYSIWYG/source list rendering no longer emits list-guide decorations or CSS hooks, avoiding the misaligned vertical bars entirely.
- **First-level list text aligns with normal prose.** Bullet, ordered, and task-list markers hang left while the item text starts at the same margin as paragraph text.
- **Close/remove refusal is consistent.** Local, devserver, CLI, desktop handoff, and control-socket close/remove paths now return the shared `{"error":"live_terminals","active_terminals":N}` body and leave live workspaces running and visible until forced.
- **Server-hidden devserver windows reopen from launcher rows.** Desktop now resolves bare window ids against the connected devserver feed before falling back to local labels.

## [v0.56.1] - 2026-06-29

A patch release for devserver control-terminal lifecycle correctness, launcher hover polish, and split desktop package targets.

### Changed

- **Script-backed control terminals own the devserver connection state.** A foreground control script that exits now marks the devserver disconnected whether it exits 0, fails, receives Ctrl-C / SIGINT, receives SIGTERM, or reports an unknown exit state.
- **Control-terminal exit attention is sticky until the user acts.** A terminated script leaves the retained control row flashing in the launcher, with `disconnected...` copy and an eye action so the user can inspect or re-run it.
- **Launcher hover motion belongs to machine cards.** Whole machine cards keep the hover wobble; buttons and workspace cards now rely on color/background affordances instead of nested motion.
- **Desktop package targets are split by platform.** macOS and Windows desktop packaging now use separate Tauri config paths, so Windows NSIS settings no longer affect macOS builds.

### Fixed

- **Closing a disconnected control terminal reaps the launcher row.** If the user closes the already-disconnected control terminal window, the desktop now removes the stale control row instead of leaving it flashing forever.
- **Concurrent control connects cannot overwrite newer runs.** Stale connect attempts are generation-checked, so an old control process cannot replace the active prefix or emit disconnect attention for a newer connection.

### Notes

- Validation: local focused cargo and launcher tests, macOS package build, the non-publishing macOS RC artifact, and host smoke of the RC DMG.

## [v0.56.0] - 2026-06-28

### Added

- **Devserver service status reports the managed command.** `chan devserver --service --status` now shows the command behind the managed service, and `--restart` preserves the bound address and port across the service handoff.
- **Marketing footer and install layout refreshed.** The download/install footer actions are split more clearly, swap order where needed, and fit the mobile layout without crowding.

### Changed

- **Gateway gate/admin/public-host env vars renamed `WORKSPACE_*` -> `DEVSERVER_*`.** The devserver-proxy contract shared by identity, profile, and devserver-proxy is now `DEVSERVER_GATE_SECRET`, `DEVSERVER_ADMIN_TOKEN`, `DEVSERVER_ADMIN_URL`, `DEVSERVER_PUBLIC_SCHEME`, and `DEVSERVER_PUBLIC_PORT` (formerly `WORKSPACE_*`), matching the `devserver.<domain>` hostnames the services already derive. Self-hosters must rename these in their `/etc/chan-gateway/*.env` files (and any orchestration/secrets) before deploying -- the services require the new names. The `configure.sh` generator and the bundled `.env` templates emit the new names; the admin CLI's `CHAN_ADMIN_WORKSPACE_URL` is unchanged.

### Fixed

- **Mermaid diagrams render normally again.** The click-to-zoom view was removed after host validation showed it regressed the diagram experience.
- **List-line selection no longer bleeds into the gutter.** Selecting list items at nested depths keeps the highlight aligned with the text instead of extending past the marker.
- **Cmd+E preserves the editor caret.** Toggling between rendered Markdown and source mode maps the current caret into the target mode instead of jumping away.
- **Rich-prompt image paste sends a bare absolute drafts path.** Pasted images are written to drafts and inserted as the same bare absolute path shown in the prompt and delivered to the terminal, without Markdown image syntax or width hints.
- **Windows serving lookups normalize verbatim paths.** `chan ps`, `chan close`, and related workspace lookup paths handle `\\?\`-prefixed Windows paths consistently.
- **`cs open` focuses a newly created empty file.** Opening a new path from a terminal moves focus into the editor instead of leaving it in the terminal.
- **Graph from here always opens a fresh graph tab.** Repeated file-scoped graph opens no longer reuse or overwrite an existing graph tab unexpectedly.
- **Devserver disconnect and Abandon lifecycle tightened.** A disconnected devserver clears its workspace windows, Retry/Abandon can reach the desktop Abandon path, and the launcher leaves the control terminal for re-run instead of reaping it.

## [v0.55.0] - 2026-06-28

An editor-polish and devserver-hardening round: mermaid diagrams zoom, devservers show their OS, local workspaces take a display name, wide tables stay readable, pasted image paths resolve from the terminal, plus a batch of editor and Windows fixes.

### Added

- **Mermaid diagrams zoom.** Clicking a rendered mermaid diagram opens a pan-and-zoom view with keyboard control (`+`/`-`/`0`, arrow keys and WASD to pan, wheel to zoom, Escape to close), on both the web app and chan-desktop.
- **Devservers show their operating system.** A devserver self-reports its OS (and Linux distribution where available); the launcher shows an OS icon on the local machine card and on each remote devserver.
- **Name a local workspace.** Adding a local workspace in the launcher accepts an optional display name, shown in place of the folder name.

### Changed

- **Wide tables stay readable.** A table wider than the editor now scrolls horizontally instead of wrapping every cell character-by-character, in both the editor and the rendered/printed output.
- **Pasted image paths resolve from the terminal's directory.** An image pasted into the rich prompt is delivered as a path relative to the terminal's working directory (an absolute on-disk path when that directory is unknown or outside the workspace), so the receiving agent resolves it; the composer preview still shows the image.

### Fixed

- **Ordered lists renumber on a mid-list insert.** Inserting an item in the middle of a numbered list -- including a loose, blank-line-separated list -- renumbers the rest instead of leaving a duplicate number.
- **List-line selection no longer bleeds into the left margin.** Selecting a list line highlights just the line instead of overflowing past the marker into the margin.
- **The model download reports a clear error behind a broken proxy.** When a proxy environment variable is set but unusable, the devserver's model download fails with an actionable error instead of silently. Standard `HTTP(S)_PROXY` / `ALL_PROXY` / SOCKS proxies already worked; `NO_PROXY` and https-scheme proxies are documented as unsupported for the model download.
- **Windows `chan open` and `chan ps`.** `chan open` on Windows no longer prints the stale-port error toast -- the devserver persists its bound port and the local on-toggle is best-effort -- and `chan ps` resolves a server's PID and kind under the `\\?\` verbatim path prefix.

### Notes

- Self-hosting docs and the Kubernetes manifests now point at the container images published to Docker Hub in v0.54.0; the project's internal dev-log was reorganized into a repo-root `team/` release-history layout.
- Validation: a non-publishing cross-OS dry-run build plus on-device smoke testing of the editor, the launcher OS icon, the model download, and Windows.

## [v0.54.0] - 2026-06-27

A feature round: the chan-desktop launcher reorganized machine-first, container images published from the release, in-place editing of inline-code file links, the ambient status notification moved clear of the terminal prompt, and `chan open` taught to serve where its shell actually runs.

### Added

- **Releases publish container images to Docker Hub.** Alongside the CLI and desktop artifacts, the release now builds and pushes multi-arch (amd64 + arm64) images for `chan` and the three gateway services -- `chan-gateway-identity`, `chan-gateway-profile`, and `chan-gateway-devserver-proxy` -- under the `fiorix` namespace, all public. Each release gets an immutable `X.Y.Z` tag; `latest` tracks the newest GA release only, and prerelease `-rc` tags push immutable images without moving `latest`. The path is exercised on a non-publishing dry-run build that builds every image without a registry.
- **Re-point an inline-code file link in place.** Typing inside an inline `` `path` `` link that resolves to a real workspace file opens a file picker to change its target without leaving the line, re-rendering as a link on commit. (The detect-and-open half shipped in v0.53.0.)

### Changed

- **The chan-desktop launcher is organized machine-first.** The local machine and each devserver are equal top-level blocks. Each block opens its own terminals and lists windows control-terminal-first, then standalone terminals, then per-workspace windows nested inside their workspace; the old flat window feed is gone. Adding a workspace and adding a devserver are now separate actions, the bulk-selection checkboxes reveal on a Select toggle (Gmail-style) with a docked bulk bar, workspace cards lift on hover, and a devserver whose control process disconnects shows an inline "reconnecting" flash instead of a modal.
- **The ambient status notification sits in the top-right.** It moved from the bottom-left, where it overlapped the terminal prompt, to the top-right with its collapse control on the right; transfer notifications now stack downward beneath it. The session-handover and survey overlays are unchanged.
- **`chan open` routes by where its shell is running.** `chan open <path>` now detects whether its shell belongs to chan-desktop or a devserver and serves there by default -- standalone when it can detect neither -- instead of always trying the desktop handoff first. The existing `--standalone` plus the new `--desktop` / `--devserver` force a target; `--devserver` from inside a devserver is refused (no nested devservers). When a workspace is already held (for example by a local devserver), the standalone path now points you at `--devserver`. This fixes a devserver shell whose `chan open` opened on chan-desktop instead of the devserver it runs on.

### Notes

- Prerelease `-rc` tags now publish as GitHub prereleases (previously a `-rc` tag published as a full release); the moving `latest` image tag and the GitHub "latest release" stay GA-only.
- Validation: a non-publishing cross-OS dry-run build (which also builds the container images) plus on-device smoke testing of the launcher and the editor.

## [v0.53.1] - 2026-06-27

A patch release: the Windows `chan ps` server-kind column, terminal clipboard copy over OSC 52 in chan-desktop, and a markdown editor link whose label contains brackets.

### Fixed

- **`chan ps` shows the serving process kind on Windows.** The BY column resolved a holder's control socket only as a Unix temp-dir `.sock` file, so on Windows -- where the control socket is a `\\.\pipe\` named pipe -- the probe missed and the column printed the literal word `served`. It now enumerates the named-pipe namespace by pid and shows the real kind, falling back to `-` (never the bare word `served`) when the kind cannot be probed. The same probe restores `chan close` / `chan workspace rm` teardown over the wire on Windows.
- **The terminal honors OSC 52 clipboard copies.** Text an agent copies via the OSC 52 escape (for example Claude Code's copy) now lands in the system clipboard -- through the native clipboard in chan-desktop and `navigator.clipboard` in the browser -- instead of being silently dropped. The query form is a no-op, so clipboard contents are never echoed back to the terminal.
- **A markdown link whose label contains balanced brackets renders as a link.** `[[foo] bar](path)` (and the image form `![[foo] bar](img)`) now render as a clickable link instead of plain text, resolving the v0.53.0 known limitation; an upstream `@lezer/markdown` shortcut-reference rule had been swallowing the outer link, and the inner-bracket escape workaround is no longer needed.

### Notes

- Validated on a non-publishing cross-OS dry-run build plus on-device smoke testing (Windows `chan ps`, desktop OSC 52 copy on Windows and macOS, and the editor link in the browser).

## [v0.53.0] - 2026-06-26

The first feature round since the unification: multi-client session presence, a self-managed cross-platform devserver daemon, terminal scrollback resume on reload, editor cursor persistence and inline-file links, and a regrouped chan-desktop launcher -- plus six rolled-forward v0.52.0-rc2 fixes and a `chan serve` terminology rename.

### Added

- **Session presence: leader and followers.** Multiple browser / chan-desktop / API clients in one workspace now collaborate. The first client to connect is the session leader; `cs session list` shows the participants, the leader, and each one's live / disconnecting / disconnected / gone status. `cs session self --name=` renames you, `cs session handover` requests leadership from the live leader (who gets an accept/reject prompt), and `cs session takeover --force` seizes it; when a leader goes away the longest-connected live participant is promoted automatically.
- **`chan devserver --service` is a self-managed cross-platform daemon.** `--service` takes a backend (`none` picks the best for the OS, or `chan` / `systemd` / `launchd`). The `chan` backend runs a single-instance foreground daemon on Linux, macOS, and Windows -- a pidfile + flock with stale-process takeover, `--status` / `--stop` / `--restart` / `--force`, and a `-v` listing of every related file. Reattaching to an already-running server is a health-check watchdog (it no longer follows journald / launchd logs), and a relocated binary still relaunches.
- **The terminal resumes scrollback on reload.** Instead of replaying the whole server-side ring on every reattach, the client caches a screen snapshot plus a byte cursor in localStorage and asks the server only for the delta since it last saw, guarded by a per-session generation so a restart refreshes cleanly.
- **The editor remembers your cursor per file.** Reopening a file restores the caret and scroll position; a large file streaming in parks the caret at the top until it finishes; the saved position is dropped when the file disappears. An explicit open still lands at the top.
- **Inline code that names a local file becomes a link.** When an inline `` `code` `` span resolves to a real workspace file, it renders as a clickable link you open with Cmd/Ctrl-click.
- **`cs terminal list` traces window -> pane -> tab.** Each terminal shows its owning window, pane, and tab (blank when unknown).

### Changed

- **The chan-desktop launcher is a "Library" tree.** Workspaces and devservers regroup under one tree with per-row controls and a host label you click to copy. On/off spinners settle correctly and resync against the server on a dropped feed or on re-show, with no dangling or out-of-state rows; a devserver's control terminal flashes its EYE button when its process exits.
- **Empty editable files are discarded on close.** Opening a file, clearing it, and closing the tab deletes the empty file instead of saving it.
- **`chan serve` is now `chan open` (a local workspace) and `chan devserver` (the tunnel).** The command was renamed; documentation and messages follow.

### Fixed

- **`chan close` / `chan workspace rm` hands off to a running chan-desktop** so the desktop's view stays in sync.
- **The disconnect/retry overlay** no longer swallows cmd+backtick window cycling, and Abandon disconnects the devserver cleanly.
- **An explicit open lands the cursor at the top** instead of a stale position.
- **The link autocomplete inside `[](url)` offers the link itself first.**
- **The black bar at the bottom of the terminal is gone.**
- **chan-desktop startup restores only the workspaces that are actually mounted** (one closed out-of-band is not resurrected).

### Notes

- Validated by a non-publishing cross-OS dry-run build (Linux / macOS / Windows CLI and desktop, including the macOS sign/notarize path) plus on-device smoke testing.
- Known limitation: a markdown link whose label contains balanced brackets (`[[foo] bar](path)`) renders as plain text (an upstream `@lezer/markdown` limitation); escape the inner brackets as a workaround.

## [v0.52.0] - 2026-06-26

A repository-structure unification -- the frontend consolidates into a single `./web` npm workspace, build and deploy tooling moves under `./packaging`, and the crate layer gets a naming, docs, and dependency-hygiene pass -- plus a round of window and terminal lifecycle fixes.

### Changed

- **One `./web` npm workspace.** The workspace app, launcher, gateway identity SPA, shared chrome, and marketing site are now members of a single `./web` monorepo (`@chan/{workspace-app,launcher,profile,web-shared,marketing}`) with one lockfile and a shared design system. The embedded bundles and the `/dl` release-download contract are byte-stable.
- **One `./packaging` tree.** Docker, Kubernetes, Linux packaging, desktop packaging, sdme, and gateway packaging consolidate under `./packaging`. Every Makefile target and CI job name is unchanged.
- **Crate hygiene.** Shared dependencies centralize in `[workspace.dependencies]`, app-internal crates are marked `publish = false`, three crates gain a `design.md`, and the product is described consistently as an AI-native IDE.

### Fixed

- **Dead and offline windows are removable again.** `cs window rm` (and clearing an offline devserver row) now routes through the library's authoritative window discard -- it drops the persisted registry row, ends the window's terminal sessions, and deletes their saved layout -- so a dead window no longer reappears on the next `cs window list` or after a restart. Removing a window that still has live terminal shells is refused unless `--force` is passed, and `cs window rm` no longer blocks on a desktop confirm dialog.
- **`cs window rm` can remove a connected devserver's window from a local terminal**, not only from one of that devserver's own terminals.
- **`cs terminal list` shows each terminal's owning window**, its kind (standalone-terminal / workspace / control / orphaned), and whether that window is alive or offline.
- **A window's titlebar number matches `cs window list`.** Watcher-opened windows now title themselves from the library's persisted ordinal (the `#` column) instead of a desktop-local counter, so the titlebar `Window N` and the registry no longer drift.

### Notes

- The unification restructures sources only -- the rust-embed bundle paths and the `/dl` release-download contract are byte-stable. The window and terminal lifecycle items under **Fixed** are the release's only behavior changes.

## [v0.51.0] - 2026-06-25

Windows desktop support graduates from a CI-only artifact to a published download:
the release now ships an (unsigned) Windows desktop installer and a standalone
Windows CLI, the terminal defaults to the user's own shell instead of requiring
Git BASH, and `chan open` integrates with a running devserver over a named pipe.

### Added

- **The Windows desktop installer and CLI are published downloads.** The release
  builds and uploads `Chan_<version>_x64-setup.exe` (NSIS desktop installer) and
  `chan-x86_64-pc-windows-msvc.zip` (standalone CLI), and the install page lists
  both. The installer is **unsigned** for now, so Windows SmartScreen may warn on
  first run; Authenticode signing is tracked for a later release. The Windows build
  is best-effort: a failure does not block the Linux and macOS release.
- **`chan devserver --service`** unifies the previous `--systemd` / `--launchd`
  flags into one cross-platform flag, with a Windows service backend.
- **Windows named-pipe devserver discovery.** `chan open` finds and registers into
  an already-running devserver over a named pipe, matching the unix-socket behavior.
- **The chan-desktop launcher window remembers its size and position** across
  restarts (per monitor, like the editor window) and opens at a more compact default.

### Changed

- **The Windows terminal defaults to the user's shell** (PowerShell / cmd, with a
  `CHAN_SHELL` override) instead of requiring Git BASH; the in-app "install Git for
  Windows" gate is removed.

### Fixed

- **`chan open` hands off to a running chan-desktop** from the bundled console
  `chan.exe`, so opening a path from the CLI focuses the existing window instead of
  starting a second server.
- **chan-server forces process exit on Windows** when the graceful-shutdown deadline
  lapses, so a lingering task can no longer keep the process alive.
- **`cs open <path>` moves the cursor to the opened editor** instead of leaving it in
  the terminal that ran the command.
- **The desktop "Window Hidden" notice mark follows the theme** -- a fixed dark logo
  that had become invisible on the dark dialog.

## [v0.50.0] - 2026-06-25

A terminal-interaction, reload-state, and CLI-ergonomics bug-sweep with desktop
window-geometry restore: copy works in full-screen TUIs, htop survives a reload,
files open with a usable caret, pane sizes and inspector widths persist across
reload, per-Hybrid terminal themes stop resetting, `cs terminal survey` gains a
timeout, team setup gains a `--brief`, and chan-desktop restores window size and
position per monitor.

### Added

- **`cs terminal survey --timeout=<secs>`** (default 600). On elapse the survey is
  cancelled and the command exits **124** (GNU `timeout` convention) with an
  elapsed-seconds message on stderr (stdout stays clean for `$(...)` capture) -- a
  distinct timed-out outcome, not an inferred dropped connection.
- **`cs terminal team new --brief <file>`** (and a Cmd+P team-dialog field) folds a
  brief verbatim into the generated `bootstrap.md`, so it survives a normal `new`.
- **chan-desktop restores window size and position per monitor.** Each window's
  geometry is captured on hide/close and restored on reopen, keyed by a monitor
  signature with a per-machine LRU; a monitor-layout mismatch restores size only,
  clamped on-screen. Desktop-only; the browser keeps its URL-hash layout restore.
  Known issue: on a secondary/external display, repeated hide/show can
  progressively shrink the window; a fix is tracked for a later release.

### Fixed

- **Copy works in full-screen TUIs.** Holding **Shift** now forces a native terminal
  selection while a TUI holds mouse tracking (e.g. the Claude TUI), so drag-to-select
  and copy work instead of the drag being forwarded to the program.
- **htop arrows and the mouse wheel survive a reload.** After a full SPA reload that
  reattaches to a live PTY, the terminal re-asserts the full private-mode set (DECCKM
  cursor-keys + mouse), not just the alt-screen, so cursor keys and the wheel work
  again.
- **The control-terminal banner** prints the bare command instead of a `running: `
  prefix, so the command's own output begins on the next line.
- **Files open with a usable caret.** A file opened via `cs open` or the File Browser
  (no initial selection) now places the caret at the document start and focuses the
  editor, matching the Draft path.
- **The `system` theme resolves to dark when the OS appearance is undeterminable**
  (e.g. headless linux, where neither prefers-color-scheme query matches), on both
  the app and the launcher.
- **Pane sizes persist across reload, including empty panes** -- a divider drag now
  schedules a layout save.
- **File-Browser inspector width persists across reload**, routed through the same
  per-tab state the editor inspector already uses.
- **A per-Hybrid terminal light/dark override no longer resets on reload.** Global
  config writes are now serialized, so a concurrent autosave can no longer clobber a
  just-saved theme override.

## [v0.49.0] - 2026-06-24

A UI-responsiveness, desktop-presentation, and packaging release: the chan-launcher
now drives its on/off and connect spinners from real backend lifecycle state instead
of a fixed optimistic timer, turning a workspace on during boot no longer false-errors,
the desktop "Window Hidden" notice is centered, every local window title shows the home
glyph, `cs upload` works from a tunnel window, and chan plus the gateway services now
ship as container images with Kubernetes manifests.

### Added

- **Container images and Kubernetes manifests.** Multi-stage Dockerfiles for the `chan`
  binary and the gateway services (identity, profile, devserver-proxy) under `docker/`,
  plus `kube/` manifests for the gateway stack (Deployments, Services, ConfigMap, Secret,
  Postgres, and an sdme single-pod variant). Validated under sdme: images build, the
  gateway services answer `/healthz`, and a headless-browser upload lands.
- **`cmd+r` / `ctrl+r` reloads the launcher window** in chan-desktop.

### Changed

- **The launcher drives its spinners from real backend status.** Workspace and devserver
  toggles reflect the backend lifecycle -- workspace `stopped | starting | running |
  error` and devserver `disconnected | connecting | connected` -- instead of a fixed 45s
  optimistic timer. A toggle spins while its workspace is starting and is disabled
  mid-transition, an errored mount surfaces its reason on the row, and a devserver
  disconnect clears the connect spinner with no manual reload.
- **The "Window Hidden" notice is centered.** chan-desktop replaces the native
  left-aligned alert with a custom centered notice (icon, title, text, and OK button).
- **Every local window title shows the home glyph (🏠).** The desktop-monitor glyph for
  paths outside `$HOME` is gone; all local windows show 🏠 and remote/devserver windows
  keep the globe (🌐).
- **`cs upload` works from a tunnel window.** chan-desktop grants `pick_upload_files` to
  tunnel (devserver) windows, so uploading a file over an ssh tunnel opens the picker
  instead of failing with an ACL error.

### Fixed

- **Turning a workspace on during boot no longer false-errors.** A turn-on for a
  workspace that this chan process is already mounting (or has mounted) is idempotent;
  the "another process is locking the workspace" error now fires only for a genuinely
  foreign lock holder, not for chan's own in-flight mount during boot-restore.

## [v0.48.0] - 2026-06-24

A devserver / launcher window-lifecycle, identity, and presentation release: the
per-library pane focus-border colour now actually persists and reaches every window
of a chan-library (a root-cause fix), same-basename workspaces coexist, the control
terminal echoes the command it runs, a new `CHAN_HOME` isolates a chan instance, and
a batch of presentation + hygiene fixes -- several carried over from v0.47.0.

### Added

- **`CHAN_HOME` environment variable.** Point chan at a different home directory --
  config, workspace registry, devserver tree, window/terminal state -- without
  changing `$HOME` (e.g. `CHAN_HOME=/tmp/scratch chan …` for a fully isolated
  instance). When it is set, chan-desktop also installs its `chan`/`cs` shims under
  `CHAN_HOME/.local/bin`.
- **The control terminal echoes its command.** A script-based devserver's control
  terminal prints `running: <command>` before it runs, so the connect command is
  visible.

### Changed

- **Devserver windows use a 🌐 globe icon** -- in window titles and the launcher feed
  -- replacing the old outbox-tray / arrow glyph.
- **The shell is never hardcoded.** Terminals and the macOS PATH-harvest resolve the
  user's configured shell uniformly (`$SHELL` → passwd entry → `/bin/sh`); the old
  `/bin/sh` / `/bin/zsh` fallbacks are gone.
- **Two workspaces with the same folder name can be open at once.** A workspace's
  mount prefix is now `/{name}-{hash}` (a short hash of its canonical path), so
  `foo/notes` and `bar/notes` no longer collide.
- The launcher's *Workspaces* and *Devservers* rows align their labels left, matching
  *Open windows*.

### Fixed

- **Per-library pane focus-border colour now persists and propagates.** Setting a
  pane's focus colour persists for the chan-library, and a newly-opened window (local
  or devserver, terminal or workspace) shows it. Previously the change never
  persisted -- the request was misrouted under the window's tenant prefix and 404'd --
  so new windows fell back to the default blue.
- **Pasted rich-prompt images resolve for the receiving agent.** An image pasted into
  the rich prompt is delivered as a workspace-rooted path, so the agent finds it at
  its working directory instead of 404ing.
- **Terminals no longer blank under a full-screen TUI** (e.g. claude code). The
  reattach reply-gating that could stall and drop live cursor/device-status replies
  was removed (at the cost of an occasional historical reply echoing at the prompt).
- A **script-based devserver disconnects immediately** when its control script exits:
  no lingering "connected", the control row leaves the feed, and the re-run / abandon
  prompt appears.
- The launcher's **control-closed survey fires again** -- the remote-served launcher
  was missing the `core:event` listen permission.
- Same-name workspaces no longer **crash the launcher** with a duplicate-key error.
- `chan open` on a port a devserver already holds (`:8787`) prints an **actionable
  message** instead of a raw `EADDRINUSE`.
- A **standalone terminal window leaves the feed** when its shell exits while
  detached, instead of lingering as a ghost.
- A devserver's **Control terminal groups under its devserver** in *Open windows*,
  not under a blank header.
- Clicking the **eye on a just-closed window** is a clean no-op -- no console errors.

## [v0.47.0] - 2026-06-23

A devserver / launcher lifecycle release: `chan devserver` gains tunnel-only and
supervised-service controls, the devserver control terminal is unified onto
chan-library's window model (fixing several connect/feed bugs at the root),
per-window visibility now persists and is mirrored on connect, and the per-library
focus-border colour propagates live across all windows of a library.

### Added

- **`chan devserver` tunnel-only mode.** When a tunnel token is present, the
  devserver no longer binds a local TCP listener by default (the gateway is the
  surface). `CHAN_DEVSERVER_LISTEN=0/1` overrides; tunnel-off + `LISTEN=0` is a clear
  error. Added `--stop` / `--restart` for supervised (`--launchd` / `--systemd`)
  devservers (`--restart` starts a stopped service).
- **Per-window visibility persists.** A window hidden in one session stays hidden on
  reconnect and across a chan-desktop restart; the launcher mirrors the persisted
  layout instead of re-opening every window.
- **Live per-library focus-border colour.** Setting the focus colour on any pane now
  updates every open window of that chan-library live, and new windows inherit it.

### Changed

- **The devserver control terminal is now a first-class chan-library window** (unified
  onto the window registry instead of a desktop-synthesized record): it appears in the
  launcher's "Open windows" on connect and is reaped when its process exits.
- The "Open windows" panel shows hidden windows inline with an eye toggle (no separate
  section).
- Removed the dead Tauri devserver CRUD commands; the launcher manages devservers over
  HTTP.

### Fixed

- The devserver group / Control terminal now appears on a fresh (zero-window) connect
  and survives a reload -- previously missing until a second window was minted.
- Control-terminal process exit surfaces the **re-run / edit / abandon** prompt again,
  flips the devserver to disconnected when it is actually unreachable, and removes the
  closed terminal from the feed.
- A devserver stays connected when its setup-style connect script exits cleanly (a
  benign exit no longer flips it to disconnected).
- New windows no longer come up with the default focus-border colour when a per-library
  colour is set.
- Closed workspace windows no longer re-open on chan-desktop restart.

## [v0.46.0] - 2026-06-23

A launcher-polish and fix release on top of the v0.45.0 desktop release: the
workspace launcher gains unified bulk management for served workspaces, per-window
focus / show-hide controls, in-flight spinners, and a dismissable error banner;
editor and graph navigation are fixed; and desktop upload, native dialogs, the
devserver connection, and the app icon are hardened.

### Added

- **Launcher -- per-window Focus and Show/Hide controls.** Each "Open windows" row
  now has a **Focus** button (raise + focus the window, un-hiding it if buried) and
  an **Eye / Eye-off** show-hide toggle, replacing the single click-to-toggle dot.
- **Launcher -- in-flight spinners.** Turning a workspace on/off and connecting or
  disconnecting a devserver now show a spinner while the action runs; the spinner
  **survives a launcher reload** and reconciles to the latest state.
- **Launcher -- served workspaces are managed like local ones.** A served
  (devserver-mounted) workspace row gets a select checkbox and feeds **one** global
  bulk bar spanning local + served + devserver selections, with an ordered
  cross-kind Remove (forget served → remove devservers → remove local).

### Changed

- **Launcher -- the top-level open-terminal button uses the SquareTerminal icon.**
- **Graph -- "Open" on a file node opens the editor** (matching the File Browser);
  directory nodes still open the File Browser.
- **App icon -- the enso is no longer over-zoomed**, re-rendered with its original
  cream-paper margin (colours unchanged).

### Fixed

- **Editor -- a `[[wiki-link]]` to a resolvable note no longer shows a false
  "document not found."** The link target is resolved to its real file before
  opening; genuinely broken links still surface the banner.
- **Editor -- reopening a closed File Browser tab (Cmd+Shift+T) restores its
  expanded directories** (and selection, scroll, and workspace toggle).
- **Launcher -- the error/warning banner can be dismissed** (an [X] button) without
  reloading.
- **Launcher -- `chan open <url>` shows the new devserver immediately**, with no
  manual reload.
- **Desktop -- `cs upload` opens a native file picker** on macOS, so uploads work
  from a desktop terminal (the web file input is blocked by WKWebView; download was
  unaffected).
- **Desktop (macOS) -- native confirm dialogs honor Return-to-default** -- "Quit
  Chan?", Remove window, transfer-in-progress, and update-ready all respond to
  Return on the blue default button.
- **Desktop -- the devserver connection no longer leaks file descriptors.** The
  desktop built a fresh HTTP client per poll (~22 leaked connections/minute) until
  the devserver hit its 1024-fd cap and died (~40 min); it now reuses one client.
- **Manual -- the intro bullet list renders correctly** (a missing blank line had
  folded the bullets into the preceding paragraph).

## [v0.45.0] - 2026-06-23

The desktop release. It finishes the launcher on the **desktop / WKWebView** surface the v0.44.0 headless
gate couldn't reach, then -- across follow-on rounds driven directly by desktop hand-smoke -- builds out the
full **devserver-in-the-launcher** experience and hardens the window lifecycle. A connected devserver's
windows, served workspaces, and control terminal now appear in the launcher; the focus-border colour
persists per chan-library (one for the local library, one per devserver); the launcher rows are redesigned
with icon buttons + bulk actions; turning a workspace off preserves its window layout for restore on
turn-on (only Forget purges); and the desktop show/hide, reconnect, and live-terminal-off paths are fixed.
Alongside: desktop auto-update on launch, standalone-terminal `cs upload`/`cs download`, a new app icon,
graph-navigation refinements, a reworked marketing homepage with the docs consolidated into the manual, and
a devserver-reality docs pass.

### Added

- **Desktop auto-update on launch.** chan-desktop checks for an update in the background at startup and
  prompts to install (honors `CHAN_UPDATE_CHECK=0`) -- a directly-booted desktop now self-updates instead
  of only updating via an explicit `chan upgrade`.
- **Devserver Connect from the launcher.** The launcher's Connect button now dials a configured devserver
  (runs its connect command in a control terminal and connects), enabled on the desktop surface and inert
  in a plain browser.
- **New-Workspace folder picker.** A native **Browse…** button opens an OS folder dialog to fill the
  workspace path (the text field stays the fallback, and the only path in a browser).
- **Standalone-terminal `cs upload` / `cs download`.** Library-level transfers from a standalone terminal
  (no workspace): cwd-anchored, shell-uid reach, with read/write pre-flight checks that fail fast and
  leave no partial artifact. `<path>` is required (`.` = current dir); a directory downloads as a
  streamed tarball, and a cancelled download leaves nothing behind. Workspace transfers stay bounded to
  the workspace root.
- **Transfer close-guard for connected-devserver windows.** Closing a connected devserver's window
  mid-transfer prompts Keep open vs Cancel -- the in-flight signal now rides the windows feed.
- **New desktop app icon** -- a black enso on cream paper.
- **Devserver windows + served workspaces in the launcher.** A connected devserver's standalone terminal,
  control terminal, and workspace windows now appear in the launcher's Open-windows (and the native Window
  menu), and its `chan open` workspaces appear in the launcher list -- grouped under the devserver, with
  their on/off/Forget routed to it. Built on a devserver-feed source merged into the window feed +
  per-workspace cache, plus disconnect / New-Terminal / open-workspace bridge ops.
- **Control terminal in the launcher.** A connected devserver's control terminal shows **first** in its
  window group (labelled "Control terminal"), with an optional **"Auto-hide control terminal on success"**
  on the connect form so it tucks away once the connection is up.
- **Per-library focus-border colour.** The pane focus-border colour now persists per chan-library -- set it
  once and every standalone terminal and workspace window of that library uses it; the local library and
  each devserver each keep their own (file-backed, surviving reconnect/restart). Set from the pane's
  focus-border menu.
- **Launcher row redesign + bulk actions.** Workspace and devserver rows use icon buttons (New window /
  On-Off; New terminal / Edit / Connect-Disconnect), with multi-select bulk **Turn on / Turn off / Remove**.
  Edit opens read-only while a devserver is connected.
- **Turn-off confirm for live terminals.** Turning off a workspace that still has live terminals now prompts
  with the live-terminal count and offers to force it off -- for both devserver and local workspaces.

### Changed

- **Launcher live-refresh.** The desktop launcher's workspace list updates live as you `chan open` a
  workspace or turn one on/off -- no manual reload.
- **Open-windows rows are show/hide toggles.** Clicking an Open-windows entry shows or hides its window
  (the whole row, not just the dot).
- **Graph "still indexing" state.** While the workspace index is building, the graph tab shows
  "graph temporarily unavailable while indexing the workspace" instead of "no markdown files in this
  workspace yet", and the graph repopulates automatically once indexing finishes.
- **Uploads use the transfer bubble everywhere.** The replace-file upload now reports through the transfer
  bubble; the upload status-bar text is retired (v0.44.0 retired the download bar only).
- **File-browser inspector Open.** Opens odd-extension plaintext files (matching the tree's content-peek)
  instead of offering Download.
- **Tunnel-publish docs corrected to the `chan devserver` reality** across the README, manual, marketing,
  and the tunnel-crate docs; the "anonymous public tunnel" section is removed (publishing is always
  authenticated).
- **Devserver form is Host + Port.** The add/edit devserver dialog takes a host and a port (the URL is
  formed for you) instead of a single URL field; the optional token and connect command stay.
- **Graph shortcut is `Cmd+Shift+M`** (Linux/Windows `Ctrl+Shift+M`) -- restored after a mistaken retirement;
  it opens a Graph tab in the current window and shows on the Graph tile. `Cmd+Shift+G` stays Find-previous;
  the hybrid-nav alias is `Mod+. M`.
- **Graph navigation.** "Graph from here" and the inspector's "Open" each open a **new tab** (no in-place
  re-root), and the graph now renders the filesystem skeleton immediately and layers semantic edges in as
  the index settles (instead of showing "unavailable" until the index is ready).
- **README reduced to a minimal pointer** (download from chan.app or build with the Makefile).
- **Marketing homepage reworked and the docs consolidated into the manual** -- a leaner home page, with the
  product documentation living under the manual (refreshed screenshots).

### Fixed

- **Launcher on-state on the desktop.** A desktop-served workspace now correctly shows as on (it showed
  "Turn on" despite being served); the launcher resolves a workspace's on-state and its on/off/remove
  actions by the workspace's canonical root, not the slug prefix the desktop never mounted at.
- **Turned-off workspaces no longer leave stale windows in the launcher** -- and turn-on restores them.
  Turning a workspace off removes its windows from the launcher but **preserves their layout** (panes/tabs);
  turning it back on restores the same windows (the terminals restart). Only **Forget** purges the layout.
  Holds for both local and devserver workspaces (a devserver workspace's windows no longer resurrect on
  disconnect→reconnect).
- **Devserver window show/hide from the launcher dot no longer hangs.** Hiding a devserver standalone
  terminal, control terminal, or workspace window via its dot updates the dot correctly, and clicking the
  greyed dot **shows it back** (previously it could be hidden but not reopened except via the Window menu).
  The OS close button updates the dot too.
- **Control terminal appears on devserver reconnect** without needing to open a second terminal.
- **Directory download progress no longer shows `NaN%`** -- a streamed directory download (no Content-Length)
  renders an indeterminate progress on the desktop, matching the browser.

## [v0.44.0] - 2026-06-22

A round that makes the launcher a true view of the real library on the desktop, finishes the
`chan serve`/`unserve` → `chan open`/`close` verb migration, and turns `cs upload`/`cs download` into a
visible, cancellable, reload-surviving surface. The launcher's registry CRUD -- workspaces **and**
devservers -- flipped off the in-memory mock onto the live `/api/library/*` client, so the desktop
launcher lists the user's real `~/.chan` workspaces and configured devservers instead of a hardcoded
fake set.

### Added

- **Launcher reflects reality.** The web-launcher registry CRUD flipped from the in-memory mock to the
  live HTTP client; the desktop loopback lists/mutates the real workspaces + devservers.
- **Live devserver registry.** `GET/POST /api/library/devservers` + `PUT/DELETE /:id`, backed by a
  `DevserverRegistry` bridge over the desktop config (token write-only -- `has_token` reported, never
  echoed); empty + 404-mutation on the headless/gateway surface.
- **Per-row Open / Turn on.** A workspace row's pill is now **Open** (mint a new workspace window) when on,
  **Turn on** when off; read-only surfaces keep the static pill.
- **Transfer progress bubble for `cs upload`/`cs download`** -- a prominent, cancellable surface (reusing
  the download-progress idiom), survives a window reload (in-flight restores as *interrupted*, never a
  frozen bar; download offers Retry, upload Dismiss), with a terminal-style **window close-guard**
  (closing a window mid-transfer prompts hold / cancel).
- **`cs open` + the file browser open any plaintext file.** `cs open {path}` opens any existing plaintext
  file (content peek, not extension) and creates a nonexistent path as plaintext; the file browser peeks
  content before refusing, matching the same gate.

### Changed

- **`chan serve`/`unserve` → `chan open`/`close`** (verbs + polymorphic target: a path opens/serves a local
  workspace with the existing desktop/devserver handoff; a `scheme://host` URL registers a devserver).
- **Devserver form takes one full URL** (scheme included), not Host + Port -- the forward hook for the
  devserver-proxy dial; the desktop defaults the port from the scheme.
- **Window-bury notice simplified** (no em dash).

### Fixed

- **Rich-prompt ArrowUp recall** no longer leaves the composer stuck read-only on a queued message (the
  un-grey is folded into the dispatch + focus deferred, matching the delivered path).
- **`chan close --remove` unregisters from a running devserver** (config + overlay + launcher, durable
  across a `persist_state`); a plain `chan close` now persists the workspace's off-state.

## [v0.43.0] - 2026-06-22

A round centred on **one launcher, three surfaces**: the `web-launcher` SPA is served at `/` by the
`chan-library` `WorkspaceHost` root fallback and reached identically on the desktop loopback, a
`chan devserver`, and the gateway-proxied root through the existing transparent proxy -- the native
desktop `main.js` launcher was retired. Alongside it, the v0.42.0-reported "indexing stalls" turned out
to be a slow (not broken, not a regression) single-tail-flush cold embed that *looked* frozen; it now
commits progress incrementally and runs faster on macOS. Plus the editor / team / window-close
carryover and `cs upload`/`cs download`.

### Added

- **Web-launcher unification across all three surfaces.** chan-server embeds `web-launcher/dist`
  (`serve_launcher`) + serves `/api/library/{workspaces,windows}`, installed on the `chan-library`
  `WorkspaceHost` root fallback; the desktop loads the same SPA from its embedded loopback. Per-surface
  auth: full workspace mutation on the loopback, read-only over the gateway/tunnel.
- **Gateway "Open whole devserver."** An owner-only `GET /s/:owner` mints an entry token and forwards the
  browser to the devserver root (launcher) through devserver-proxy; the gateway renders nothing.
- **`cs upload` / `cs download`** raise the Inspector upload/download UI from a workspace terminal.
- **Team-setup dialog survives a window reload** (the in-progress config persists).

### Changed

- **Embeddings cold reindex commits incrementally** -- progress advances live and partial results are
  searchable mid-run, instead of one tail flush that looked frozen.
- **Apple Accelerate CPU BLAS** for embeddings on macOS (~1.5–2× faster cold reindex; target-gated, no
  Linux/musl impact).
- **Editor source toggle** gated to renderable files (`.md`/`.json`/`.csv`), Ctrl+E on Linux/Windows;
  `web/EDITOR.md` refreshed to the shipped `@today`/`@date` macros.
- **Window-close notice** simplified; **empty-workspace copy** reframed as a project directory + inline
  Open-terminal.

### Notes

- Windows Authenticode signing remains out (certs pending). The launcher devservers-list bridge, grantee
  mutation over the gateway (a signed proxy role header), and the launcher drag-drop folder-add gesture
  are deferred to a future round.

## [v0.42.0] - 2026-06-22

A round centred on **"opening a chan-library behaves identically whether it is local or remote."**
The library now owns the open rules -- first open mints exactly one terminal (and never again),
workspace on/off and terminal-window persistence live in one place -- so chan-desktop and a headless
`chan devserver` inherit one definition. Alongside it, the chan.app gateway migrated to a
**per-devserver** model: a user's devserver is a first-class entity reached through an
always-authenticated, segment-preserving reverse-proxy over a per-devserver tunnel.

### Added

- **Open a chan-library identically, local or remote.** The first time a library is opened with an
  empty window set it mints exactly one terminal and records that it has done so; close that terminal
  and reopen the library and it comes back with none. This rule now lives in the library itself, so
  the desktop's local library and a connected `chan devserver` behave the same -- replacing the
  desktop's per-boot "always a shell" floor and the per-connection bootstrap flag.
- **Per-devserver sharing on chan.app.** A user's devserver is a first-class entity with a stable id;
  the identity dashboard's **Devservers** page manages it and email-based **sharing grants**
  (viewer/editor), and per-workspace share links hand an authenticated browser straight to the
  devserver. (Opening the *whole* devserver as a launcher is deferred -- see below.)
- **Library-aware drag-and-drop scope.** Tab and pane drags carry a structured
  `(library_id, container, workspace)` scope, so a terminal or workspace tab only drops within its own
  library and workspace -- consistent local and remote.

### Changed

- **The gateway is now a per-devserver, always-authenticated reverse-proxy.** Renamed
  `workspace-proxy → devserver-proxy` and `workspace-gate → devserver-gate`; tunnel registration is
  keyed on the token-resolved `devserver_id`, the tunnel always authenticates, and the proxy forwards
  the full request path unchanged to the devserver's own router (it renders nothing itself).
- **New Terminal and Cmd+Shift+N on a devserver window** mint through the focused window's library -- a
  proper library terminal on the shared terminal tenant -- instead of a local/legacy isolated terminal.
- **Workspace on/off and terminal-window persistence are unified** into one library-owned shape, so a
  restart comes back serving exactly what was on, local and devserver alike.

### Fixed

- Intra-window pane drag-and-drop, which broke under the new library-aware scope: the scope rode a
  DataTransfer MIME *type* and WebKit mangled the `:` / `|`, so even same-window drops were rejected.
  The scope token is now hex-encoded and byte-stable.
- The rich-prompt composer becoming un-typeable after a queued message drained: the clear now
  re-enables editing in the same transaction and refocuses on a microtask.
- Terminal query-reply garbage (`…R` / `…c`, cursor-position and device-attribute replies) printed at
  the prompt after a Cmd+R reattach: the replay window that suppresses replies to historical queries
  now ends when the replayed ring has drained, not when the `ready` frame arrives.
- Devserver tenant root: `/{slug}/` now serves (trailing slash canonicalized).
- Cross-window tab-drag scope now keys on workspace identity rather than the window label.

### Removed

- The dead per-label devserver terminal subsystem -- `POST /api/devserver/terminals` and its handlers,
  `PersistedTerminal` persistence, and the Window-menu terminal-reopen path -- superseded by library
  terminals on the shared tenant.
- The tunnel's `public` wire field and the dead per-workspace public-router path; the tunnel is always
  authenticated.

## [v0.41.0] - 2026-06-21

A round centred on the window lifecycle: a single library window registry now owns every window
(local and devserver), and a window watcher reconciles native windows against its live feed -- so
windows mint, persist, reconnect, reload, and restore their layout from one source of truth.
On top of that: live cross-window settings sync, dashboard config moved out of the search index,
broader reload-survival, and an async/perf pass.

### Added

- **Live cross-window settings sync.** Changing a setting in one window of a workspace -- theme,
  fonts, pane widths, the page-width slider, overlay-maximize -- now applies in every other open
  window of that workspace immediately, without a reload. A Settings save broadcasts a
  `config_changed` frame on the workspace's event bus and each window re-reads and reflects it.
- **Web launcher: Gmail-style multi-select + bulk actions.** Select one or more workspace rows to
  reveal a bulk-action bar -- Turn On, Turn Off, Delete -- that loops the single-workspace op over the
  selection and reports partial failures. Delete is bulk-only behind a confirm; the per-row On/Off
  pill stays the quick single toggle.
- **Web launcher: Open terminal.** A top-bar button that mints a fresh local terminal window.
- `cs terminal close --tab-name <n> | --tab-group <g>`: tear down terminal sessions by name or
  group -- the explicit teardown partner to `cs terminal restart` / `new`. Closing a session frees
  its tab name; `--tab-group` tears down a whole group (e.g. a finished team) in one call.
- Confirm-before-off for a workspace with live terminals: turning a workspace off when it still has
  running terminals now prompts ("N terminals still running -- turn off anyway?") and only unmounts
  on confirm, instead of silently killing the shells. Enforced server-side so the desktop, `cs`, and
  the launcher all get the guard.

### Changed

- **The window lifecycle is driven by a window watcher against a library window registry.** A single
  per-library registry is the authoritative window set (it mints opaque window ids, assigns
  "Window N" ordinals, composes titles, and persists the set to disk). The desktop opens, closes,
  and restores native windows by reconciling against that set's live feed, for both local windows
  and a connected `chan devserver` -- replacing the per-surface imperative open/close paths. Standalone
  terminals are now first-class library windows under the same lifecycle, so they mint, persist, and
  reopen like workspace windows. `cs window list` reads the same set, so `cs`, the launcher, the HTTP
  API, and the desktop never disagree.
- The dashboard / overlay config (screensaver toggle, timeout, theme, pin, and the report /
  semantic-search opt-ins) is no longer stored inside the search index config -- it moves to a
  per-workspace `dashboard.toml`, so a search reindex or a vector wipe can no longer reset it.
  Existing workspaces migrate their toggles in place on first open.
- `cs-link-dismissed`, the page-width ratio, and overlay-maximize are now per-library server
  preferences instead of browser-local storage, so they travel with the library and stay consistent
  across clients (and sync live across windows).

### Fixed

- **Reload-survival of the full layout.** A window reloads back to its exact prior state -- a
  standalone terminal, a terminal-only or empty-split layout, and a Hybrid pane flip (with its
  per-Hybrid theme) all now persist and restore, where before they reset on reload, off/on, or a
  desktop relaunch. (Terminal panes come back with fresh shells; the layout is preserved.)
- **Transparent re-attach of a restarted terminal.** `cs terminal restart` now re-attaches the tab
  to the relaunched session in place -- the shell swaps under a live socket and the tab stays -- instead
  of dropping the tab and leaving a live-backend / dead-frontend ghost.
- A killed terminal session is reaped from the registry so it stops appearing in `cs terminal list`
  and frees its tab name, so re-spawning under that name no longer collides and comes up renamed.
- **Rich-prompt queuing.** The composer no longer locks read-only after a submit: it clears and stays
  editable so you can queue messages back to back, ArrowUp recalls the last queued message to edit,
  and Esc dequeues it (or abandons the current draft). A failed send restores the text for retry.
- macOS GUI launch (Finder / Dock / Spotlight) now resolves the user's real interactive shell PATH
  before the embedded server starts, so `~/.local/bin`, Homebrew, and custom dirs are visible -- fixing
  the false "create the `cs` alias" card under the restricted launchd PATH. The resolution is bounded
  with a ~3s timeout so a pathological shell rc can't hang app launch.
- Cmd+R (and the devtools / zoom chords) are no longer dead on a devserver window: the desktop
  key-bridge only swallows a keystroke when its IPC is actually present, otherwise the event falls
  through to the SPA's own reload handler.
- The editor hang-recovery buffer is now namespaced per workspace, so two workspaces with a file at
  the same relative path (e.g. `README.md`) can no longer restore one's unsaved content into the other.
- The onboarding nudge ("enable semantic search + reports") now shows only on a workspace's first
  boot -- gated on whether the workspace has any indexed content or an optional layer enabled -- instead
  of on every boot in a fresh WebView.
- Performance / async hardening: PTY spawn and the `lsof` cwd probes run off the terminal-registry
  lock (and off the async runtime), so a terminal launch or a multi-session `cs term list` no longer
  stalls every other terminal op; preference writes are serialized through one in-flight chain so
  near-simultaneous setting flips can't clobber each other; and a workspace-off no longer blocks the
  desktop runtime waiting on the lock release.

## [v0.40.0] - 2026-06-19

Making the `chan devserver` window + terminal lifecycle actually work end to end -- reconnect,
window cleanup, and the file-descriptor leak -- plus the devserver serving the host library, a CLI
reorganisation, and the deferred Windows/graph items.

### Added

- `chan ps`: show which registered workspaces are currently being served, and by what -- a standalone
  `chan serve`, chan-desktop, or a `chan devserver`.
- Menu-reopen of closed devserver windows: a connected devserver's closed-but-saved windows appear in
  the chan-desktop Window menu and reopen to their live terminal / saved workspace layout.
- The chan-llm MCP server is now reachable on Windows (the bridge runs over the cross-platform
  control-socket transport).
- Windows writer-lock: a contender can now reclaim a lock from a leaked file handle left by a
  provably-dead holder.

### Fixed

- Reconnecting to a `chan devserver` (from chan-desktop or a browser tab) now **re-attaches to the
  live terminal sessions** instead of restarting them: standalone-terminal shells and a workspace's
  terminals come back with their processes still running and scrollback intact -- not fresh shells.
- The devserver **file-descriptor leak** (EMFILE on a long-running devserver) is fixed at its root: a
  terminal session now lives exactly as long as its window is *saved*, so a discarded window's
  sessions are reaped immediately and busy detached sessions no longer leak descriptors across
  reconnect churn. (Deeper than the v0.39.0 tantivy-watcher fix, which did not cover a steady devserver.)
- Window cleanup is now explicit: closing a window with ^W / ^D / Ctrl+Shift+W, and empty windows,
  **discard** the window (gone from `cs window list`); only **burying** a window (the OS close button
  while connected, or a window with content) saves and hides it.
- The control-terminal dialog now fires on a **connected-phase exit** -- the connect script returning
  on its own or via Ctrl-C -- and on Cmd+W while it is still running, not only during connecting.
- `chan devserver` now **serves the host library**: it lists every workspace `chan workspace ls`
  shows (each on/off-able), instead of coming up empty and chan-desktop hanging on "Loading…".
- fs-graph paged-resume pages no longer carry parent-less `contains` edges (an internal correctness
  fix; the paged graph now matches the unpaged one page-for-page).

### Changed

- CLI: registry and content operations are grouped under a `chan workspace <…>` subcommand --
  `chan add` → `chan workspace add`, `chan list` → `chan workspace ls`, `chan remove` →
  `chan workspace rm`, and `index` / `reports` / `search` / `graph` / `status` / `metadata` /
  `contacts` likewise. The top level keeps `serve`, `unserve`, `ps`, `devserver`, `shell`, `config`,
  `upgrade`, and `completions`. (Pre-release: the old flat forms are removed, not aliased.)
- The `chan` tagline is now "an AI-native workspace for your Markdown notes and projects."
- "Forget" on a devserver workspace now removes it from the host library (the same as
  `chan workspace rm`, binning its trash) -- one destructive Forget across the CLI, chan-desktop, and
  the devserver, since the host library is the single source of truth.

## [v0.39.1] - 2026-06-18

A patch for three issues found smoke-testing the v0.39.0 `chan devserver` connect flow.

### Fixed

- Connecting to a remote devserver no longer fails with `HTTP 415 Unsupported Media Type`. The
  connect flow's first terminal is now created as a first-class persisted, per-tenant terminal (like
  every other devserver terminal), so it also re-surfaces on reconnect. This also fixes Cmd+Shift+N
  on a focused devserver terminal silently falling back to the launcher.
- The control terminal now surfaces the abandon / edit / retry dialog on every close or exit while
  connecting -- Ctrl-C, Ctrl-W, or the close button -- not only when the connect script fails. Choosing
  abandon disconnects and resets the launcher back to "Connect" instead of leaving it stuck on
  "connecting".
- Connect-failure error message: the missing period before "Its control terminal is still open …" is
  restored.

## [v0.39.0] - 2026-06-18

A hardening round on the `chan devserver` + chan-desktop surface: workspace lifecycle, lock
correctness, and standalone-terminal persistence.

### Added

- Devserver workspaces now have an on/off toggle: unload a remote workspace (releasing its writer
  lock) without forgetting it, then toggle it back on -- from the chan-desktop launcher. The off/on
  state persists across a devserver restart.
- `chan unserve <path>`: tear down a running `chan serve` for a workspace from the command line (the
  CLI counterpart to the desktop on/off), releasing the writer lock so the workspace can be re-served
  or removed.
- `chan remove <path>` now unserves a running serve first, then forgets everything about the
  workspace -- index, graph, sessions, tokens, report, registry entry, and the whole
  `~/.chan/workspaces/<key>/` metadata directory -- so it never fails with "workspace locked" on a
  live serve.
- Self-upgrade download progress: a text meter (percent, size, elapsed, ETA) in the terminal and a
  progress bar in chan-desktop.
- Standalone terminal persistence at the launcher: a devserver's terminal windows and their pane/tab
  layout come back when chan-desktop reconnects or the devserver restarts -- reconnecting to the live
  shells while the devserver is still up, or fresh shells with the saved layout after a restart.
  `cs window list` and the Window menu reflect them.

### Fixed

- Workspace lock correctness: the writer lock now records the holder's pid, path, and start time, and
  a contender reclaims the lock only from a provably-dead holder instead of failing. Fixes rapid
  Open / On / Off clicking in chan-desktop wedging a workspace as "locked" with no live process.
- Devserver file-descriptor leak (EMFILE) on a long-running multi-workspace devserver: the redundant
  tantivy commit-watcher (a second inotify watcher per workspace) is gone, so the descriptor count
  stays bounded across mount/unmount and reconnect churn.
- Control / standalone terminal behaviour in chan-desktop: the control terminal opens and stays open
  on connect (no auto-hide or flashing), is a true singleton (no replicated Terminal 1/2/3), and the
  empty standalone-terminal window no longer shows a flashing floating button.
- Failing connect script: closing a failing control terminal now surfaces a re-run / disconnect
  survey and tears down cleanly instead of leaving the launcher stuck on "connecting" with an empty
  window.
- An empty devserver (zero workspaces) now loads on connect and across a restart.
- Graph: in a directory scope, every file node now anchors to its folder spine, so cross-tree files
  (link / mention / tag targets from elsewhere in the workspace) no longer render loose.

## [v0.38.1] - 2026-06-18

### Added

- `chan devserver --launchd` (macOS): supervise the devserver under a per-user launchd LaunchAgent (`app.chan.devserver`) so it survives the launching shell; re-running re-attaches to the live agent. The macOS counterpart to `--systemd`. It outlives the GUI login session but not a full logout (launchd has no per-user linger without a root LaunchDaemon); stop it with `launchctl bootout gui/$(id -u)/app.chan.devserver`.

### Fixed

- Editor: opening a Markdown file with Windows (CRLF) line endings no longer freezes the editor in a reactive render loop. CodeMirror normalizes the document to LF internally, so the external-value sync now compares and writes against the same normalization; previously a `\r\n` file never matched the live (LF) document, re-dispatching on every reactive pass until Svelte tripped its update-depth guard.
- `chan devserver --systemd`: a fresh start now surfaces the bearer token to the controlling terminal even when the invoking user cannot read the systemd journal (a uid below `SYS_UID_MAX`, or a user outside the `systemd-journal`/`adm` groups) -- the supervisor emits the `CHAN_DEVSERVER_TOKEN=` marker directly from the persisted config rather than relying on the journal follow, and keeps supervising (or fails loud) instead of quitting when the journal stream ends.

## [v0.38.0] - 2026-06-17

### Added

- `chan devserver`: one process hosts many workspaces behind a single port. Register workspaces into it with `chan serve PATH` (each registers and exits instead of binding its own port, so one process owns each workspace). chan-desktop connects to a devserver and lists its workspaces in their own launcher group, with a New Terminal button that opens standalone terminals on the devserver.
- `chan devserver --systemd` (Linux): run the devserver under a `chan-devserver.service` systemd user service so it survives the launching shell and logout; re-running re-attaches to the live service. Reach it from chan-desktop at `localhost` via a host-network lima VM or sdme container, or forward it from a remote box with `ssh -L`. A new Devserver page in the manual covers the workflow.

### Changed

- `chan serve` now requires an explicit workspace path. Running it with no path exits with an error asking you to pass one, instead of falling back to a default workspace.
- New workspaces open with no docked file browser -- just the empty pane -- across the web app, chan-desktop, and devserver workspaces.
- A devserver's launcher section mirrors the local-workspace controls: a single Connect button with an Edit/Forget menu that becomes Disconnect plus a New Terminal button once connected; adding a devserver auto-connects it.
- Per-devserver standalone terminals behave like local ones -- Cmd+Shift+N opens another terminal on the same devserver, and terminal tabs drag and drop between that devserver's windows. Control terminals stay isolated from both.
- Connecting to a scripted devserver reads its token from the connect-script's `CHAN_DEVSERVER_TOKEN=` output on every connect (including a `--systemd` re-attach), so reconnecting after a dropped connection or a devserver restart is seamless.

### Fixed

- Editor: pasting an image leaves the cursor just past the image instead of jumping to the next line.
- Editor: backspacing near an inline image no longer deletes the whole image; deletion is directional, matching a normal text editor.
- A failed scripted-devserver connect now offers retry / edit / abandon instead of getting stuck on "Connecting", and closing a control-terminal tab surveys the same way instead of leaving a broken window.
- Disconnecting or forgetting a scripted devserver stops its connect script instead of leaving the process running, and quitting chan-desktop reaps a connected devserver's script.
- Editing a devserver's port and reconnecting works without sticking on "Connecting"; New-workspace dialog validation errors render inside the dialog rather than behind it.
- `chan devserver` shuts down promptly on SIGINT and SIGTERM with a hard deadline (matching `chan serve`) and writes its config durably; `chan devserver --port 0` reports the actual bound port.

### Removed

- The default-workspace concept is gone from the standalone CLI and server too (chan-desktop dropped it in v0.37.0): no `~/Documents/Chan` / `$XDG_DATA_HOME/chan/default` fallback, no per-machine default-workspace setting, and the Dashboard's "Workspaces → Default" field is removed.

## [v0.37.0] - 2026-06-16

### Added

- chan-desktop remembers which workspaces were on and re-serves them on the next launch, so the app comes back up showing what you left running.

### Changed

- A fresh chan-desktop launch no longer creates a default workspace: there is no `~/Documents/Chan` and no seeded manual. The launcher opens empty and a standalone terminal window opens alongside it; add a workspace when you want one.
- chan-desktop configuration now lives under `~/.chan/desktop/config.json`.
- The remote-workspace mode is now labeled simply **Remote**.

### Removed

- The first-run default-workspace prompt (create / choose / factory-reset) is gone end to end.
- Remote **inbound** is removed from chan-desktop entirely (the embedded inbound tunnel listener is gone); only the outbound "Remote" mode remains. The standalone gateway's tunnel server is unaffected.
- Releases no longer ship the separate manual tarball.

### Fixed

- Windows: opening a terminal no longer briefly hangs the app while Git BASH is being discovered -- discovery is primed off the async request path.
- Windows: `chan` and `cs` resolve from the desktop install in cmd, PowerShell, and Git BASH, and a freshly-opened shell picks them up without a logout.
- Windows: `chan` / `cs` now actually print their output (for example `chan --version`) when run from a terminal -- the desktop binary reattaches to the parent console for the CLI path; output redirection (`> out.txt`) still works.
- Windows: `chan serve <path>` hands the workspace to a running chan-desktop (opening it in a window) instead of starting a standalone browser server and leaving the workspace stuck "off" in the launcher.
- Windows: opening a file in a workspace no longer hangs the whole window while the workspace is still building its index. The graph reader pool no longer stalls behind the first index build (a contended read now fails fast instead of parking), and the reindex paces itself so the editor loads and the window stays responsive; the relationship/graph panels fill in once indexing finishes.
- The Settings shortcut (Ctrl+,) is shown in the terminal-tab and editor-tab right-click menus.
- Tabs can no longer be dragged between a standalone terminal window and a workspace window, or between two different workspaces; such drops are refused. Reordering within a window, and moving a tab between two windows of the same workspace (or two terminal windows), still work.

## [v0.34.0] - 2026-06-14

### Added

- `cs window` manages desktop windows from a terminal. `cs window list` shows each window's real title and kind alongside its status, matching the title bar and the Window menu, and the new verbs drive the desktop: `new` opens a window (another standalone terminal window from a standalone terminal, another window of the workspace from a workspace terminal), `open <id>` focuses or un-hides one, `hide <id>` hides it like the close button, `rm <id>` removes it for good and drops its saved layout (prompting first when it still has running terminals, or `--force` to skip), and `title <id> <title>` sets a custom window title (empty resets it; a title another window already shows is rejected so window names stay unambiguous). The lifecycle verbs need the desktop app.

### Fixed

- `chan serve .` (or any relative path) on macOS could open a workspace on the filesystem root when handed off to a running chan-desktop: the relative path was resolved against the desktop's working directory instead of the terminal's. The serve root is now made absolute before the handoff.

## [v0.33.0] - 2026-06-13

### Added

- The Rich Prompt keeps a submitted message visible until the agent actually consumes it: the text stays in the prompt (read-only) with a "queued" indicator, and the terminal tab shows a queue-depth badge counting pending messages (including teammate pokes). Mirrors the Claude/Codex desktop behavior.
- The graph right-click menu has a Reload item again, between Depth and Copy link to graph, for refetching the graph on demand.
- The survey overlay can be dismissed from the keyboard with X (in addition to Escape and the Dismiss button).
- The desktop launcher's Open button is always enabled: opening a stopped workspace turns it on automatically, and a turn-on failure (for example, the workspace is already open in another process) now shows a dialog explaining why instead of silently flipping the toggle back.

### Fixed

- Switching away from and back to an editor tab no longer shows raw un-decorated markdown until you click, and no longer resets the scroll position. Editor tabs are kept alive across switches, so scroll, caret, undo history, and find state are all preserved.
- Switching to a graph tab no longer reloads and re-lays-out the graph. Graph tabs are kept alive across switches; pan, zoom, and selection survive, and large workspaces no longer pay a reload on every tab focus. On-disk changes still refresh the visible graph, and the new Reload item forces a manual refetch.
- Clicking a terminal tab now lands keyboard focus in the terminal so you can type immediately, matching the keyboard pane-switch shortcut.
- Undo can no longer walk back past a file's initial load to an empty document (which autosave would then have written to disk).

### Changed

- New teams start with broadcast off; enable it per tab when you want a lead terminal to fan keystrokes to the others.
- Buried desktop windows (closed but kept warm in memory) no longer count against the per-workspace window cap, and the Window menu's "Hidden Windows" header shows how many are kept warm.

## [v0.32.0] - 2026-06-12

### Added

- Dropping files from Finder onto a terminal pane types their shell-escaped absolute paths at the cursor, like macOS Terminal (multiple files space-separated). macOS desktop only; remote (tunnel/outbound) windows deliberately excluded.

### Fixed

- Dropping a file anywhere outside the editor on a desktop window no longer navigates the webview into a bare image view with no way back. Drops are now inert on every non-editor, non-terminal surface, in the desktop app and the browser alike; editor image embeds and in-page tab drags are unaffected.
- SVG images embedded in documents render again: the file API served SVG (valid UTF-8 text) as an editor JSON envelope instead of image bytes, so the image widget showed "image not found". Image- and PDF-class reads now return raw bytes with the correct content type.

### Changed

- The macOS bundle identifier is now `app.chan.desktop` (was `com.chanwriter.desktop`). After upgrading, expect a one-time keychain "Always Allow" prompt and a launcher theme reset; workspaces, configuration, and self-update continuity are unaffected.
- Documentation overhaul: README content that duplicated the manual is now pointed into it (serve flags, tunnel walkthrough), every design document was rewritten against current source, and the config reference was trued up field-by-field. Code comments and help text no longer narrate project history; several stale claims (a help text inverting the reports default, docs citing removed commands and wrong env vars) were corrected.
- Internal hygiene: compiler and frontend warnings are at zero across every workspace; several many-parameter functions gained config structs; the last ad-hoc keyboard shortcuts moved into the chord registry (fixing a Linux menu label that displayed a chord the handler ignores).

## [v0.31.1] - 2026-06-12

### Added

- Linux and Windows gained File > Close Window on Ctrl+Shift+W (plain Ctrl+W remains a terminal readline chord): it closes the active tab in a workspace window, cancels a connecting window, and closes other windows natively -- the same routing macOS has on Cmd+W.

### Changed

- The About window no longer shows the application menubar on Linux and Windows; the fixed-size dialog is just the About content.

### Fixed

- Quitting (Cmd/Ctrl+Q or the Quit menu) now actually asks for confirmation while windows are open or hidden. The v0.31.0 dialog never appeared on macOS: the system's predefined Quit item exits through a flow the confirmation hook cannot stop, so Quit is now Chan's own menu item that asks before any exit begins.
- Outbound connecting/retry windows are closable again: the close button closes them for real instead of hiding an invisible retry loop, and Cmd+W (macOS), Ctrl+Shift+W (Linux/Windows), and Ctrl+D all cancel the connection attempt from the keyboard.
- Discarding Hybrid Nav staging (Esc) now kills the shell a staged terminal spawned; previously a staged-then-cancelled split left its shell running invisibly until the idle pruner collected it.

## [v0.31.0] - 2026-06-12

### Added

- Closing a desktop window with the OS close button now hides ("buries") it instead of destroying it: terminals keep running, the layout stays warm, and an informational dialog explains the behaviour. Buried windows are listed in a "Hidden Windows" section of the Window menu for reopening; a standalone terminal window with no shells left still closes for real.
- Cmd/Ctrl+Shift+N now reopens the most recently hidden window of the focused window's family before opening a new one, and "New Window" follows the focused connection everywhere: another window of the same local workspace, the same outbound or tunneled remote, or another standalone terminal window.
- Remote windows are reopenable ad hoc: chan-server gained `GET /api/windows` (saved per-window layouts joined with live socket presence), and chan-desktop polls outbound/tunnel connections to offer their reopenable windows in a "Remote Windows" menu section.
- `cs window list` (or `cs w l`) shows every window the server knows about -- open (a live event socket is connected) and/or saved (a persisted layout exists). Works in workspaces and standalone terminals.
- Standalone terminal windows now expose the chan control socket: `cs terminal list/write/restart/scrollback`, `cs pane`, `cs terminal survey`, and `cs window list` work inside them, while workspace-only commands (open, graph, dashboard, search, team) refuse with a clear "this is a standalone terminal session" message.
- Quitting Chan Desktop (Cmd+Q or the Quit menu) now asks for confirmation while any window is open or hidden, since quitting stops their terminals and local workspaces. A bare launcher still quits silently.
- A window now reloads itself when the server process behind it restarts (e.g. an outbound `chan serve` was ^C'd and re-run): previously the window sat on a stale view with stuck terminals until a manual reload.

### Changed

- The workspace launcher is a singleton titled "Chan Desktop" (no more "Window N" suffix), and Cmd/Ctrl+Shift+N on it opens a standalone terminal window instead of another launcher.
- The mislabeled "Settings… Cmd+," Window-menu item is gone; Cmd+, (the Hybrid pane flip) is handled by the app itself and keeps working.
- In standalone terminal windows, the Hybrid Nav cheatsheet now shows only terminal-relevant commands; the workspace-only rows (File Browser, Graph, New Draft, Search, docks) no longer render as dead controls.
- `make clean` now also scrubs the gateway workspace (its own cargo target, npm trees, and SPA dist), the desktop extras, and the web build stamp.
- Tab titles get a little fade headroom so short names ("Terminal-1") keep their trailing character legible instead of fading out.
- CI macOS desktop builds select the newest Xcode on the runner so the shipped app gets the modern window chrome (the look follows the SDK the binary was linked against; older CI Xcode produced the legacy opaque title bar).

### Fixed

- Splitting a pane no longer leaves the original terminal showing only its last line until a window reload. Root cause: a remounted terminal kept a replay cursor and skipped the server's scrollback replay; the cursor was removed and every remount (split, swap, drag, move, reload) now replays the full ring.
- Opening a standalone terminal window no longer logs a spurious "503 Service Unavailable" error in the desktop console: `/api/health` now answers on workspace-less tenants (the indexer block is simply null there).
- The dead "p Stage Team Work Terminal" row was removed from the Hybrid Nav cheatsheet; Team Work spawning lives in the lead-only Cmd+P dialog.

## [v0.30.1] - 2026-06-10

### Changed

- The "Set MCP env vars" control moved from the terminal right-click menu into Terminal Settings, where it is a single global toggle (off by default) that applies to newly opened workspace terminals.
- Desktop windows are now numbered in the Window menu -- "<workspace> Window 1", "Terminal Window 1", "Chan Desktop Window 1", and so on -- with a number reused when a window closes, so duplicate windows are no longer indistinguishable.
- The broadcast-input Select All / Deselect All shortcut now works on Linux and Windows as Ctrl+Shift+I (Cmd+Shift+I on macOS); it previously had no binding outside macOS.
- The install script now also symlinks `cs` to `chan` in the install directory.

### Fixed

- Enabling MCP env vars now actually sets CHAN_MCP_* in newly opened workspace terminals; the toggle had no effect after MCP was made off-by-default. Standalone terminal windows have no workspace and still do not expose MCP.
- Dragging a terminal tab into another window no longer pulls the Chan Desktop launcher to the front when the source window closes -- focus stays on the window you dropped into.

## [v0.30.0] - 2026-06-10

### Changed

- The Dashboard carousel now opens on Workspace first, then Search, then About (previously About led).
- The per-workspace config -- your default workspace directory and the recent workspaces list -- moved off the Workspace dashboard slide and onto that slot's settings. Flip the slide with Cmd+, to reach it, below chan-reports and the metadata archive.
- The workspace inspector's "Notes directories" section is now titled "Workspaces".

### Fixed

- The chan-desktop menu bar no longer shows two "File" menus on macOS.
- Cmd+W works again on the chan-desktop launcher (Workspaces) window, where it closes the window; workspace and terminal windows still close the active tab.
- New terminals reuse the lowest free number: open Terminal-1 and Terminal-2, close Terminal-2, and the next terminal is Terminal-2 again instead of Terminal-3.
- Dragging a terminal to another window keeps its name when nothing clashes, instead of always appending a "-N" suffix. A suffix is added only on a real name conflict, and then the terminal shows the "$CHAN_TAB_NAME stays until restart" notice so you can resync the env.

## [v0.29.0] - 2026-06-10

### Added

- Standalone terminal windows on chan-desktop: File > New Terminal (Cmd+T) opens a window that holds only a terminal, with no workspace. These windows split panes, use Hybrid Nav, keep broadcast + shortcuts, and configure the terminal via the Cmd+, tab flip; Cmd+T adds a tab and Cmd+Shift+N opens another terminal window.
- Broadcast input now spans terminal windows. A terminal's broadcast menu lists same-group terminals in other windows, Select All / Deselect All (Cmd+Shift+I on macOS) applies to the whole group across every window, and every participating terminal shows the broadcast sign in its own window.

### Changed

- Terminal-N numbering is consistent across every window of a tenant: all standalone terminal windows share one sequence, and all windows of a workspace share that workspace's sequence, instead of restarting at 1 in each new window.
- The desktop About window is unified across macOS and Linux and shows the same information as the in-app Dashboard.

### Fixed

- Cross-window broadcast respects group boundaries: a terminal with broadcast turned off no longer receives input broadcast from another window.
- Terminal names are unique across all windows, not just within one window, so renaming or regrouping a terminal can no longer collide with a terminal in another window.
- The desktop update notification shows plain text plus a changelog link instead of rendering the release notes as raw markdown.

## [v0.28.1] - 2026-06-08

### Fixed

- Pasting into the terminal no longer pops a "Paste" button you have to click first. Cmd+V now pastes directly through the terminal's native paste path (which also restores bracketed paste for multi-line content), and the right-click "Paste" menu reads the clipboard natively on chan-desktop instead of through the WebKit clipboard prompt.

## [v0.28.0] - 2026-06-05

Phase 19: a graph `@@mention` lens, a startup index-reconcile fix, the agent-docs reorg into a committed `.agents/` home, and a marketing story page.

### Added

- Graph `@@mention` lens. Clicking a standalone `@@handle` from the file inspector, an editor mention, or a search mention row opens a focused graph centered on the `@@{name}` node with an edge to every file that references it, each re-anchored through its parent-directory spine back to the workspace root. Mirrors the existing `#tag` lens. Search now surfaces mention rows alongside tags.
- A chan story page on the marketing site (`/story`) carrying the project motivation, an architecture diagram, and a tour of the IDE.

### Changed

- Agent and contributor docs now live in a single committed `.agents/` home (standards, roster, orchestration contracts, and skills). The near-duplicate root `CLAUDE.md` and `AGENTS.md` are removed; `README.md` and `CONTRIBUTING.md` point into `.agents/README.md`.

### Fixed

- The graph index reconciles against disk on workspace open. A markdown file added, edited, or removed while no server was watching (closed laptop, no `chan serve` running) is now picked up on the next start instead of staying invisible across restarts, so its mentions and tags get edges. Cold or empty workspaces still defer to the background full build, so open stays fast.
- Contacts (`chan.kind: contact` notes) render as contact nodes in the graph even when reached only by a link rather than an `@@mention`. They previously fell back to the generic markdown node glyph while the file browser, inspector, and `@{}` search already treated them as contacts.

## [v0.27.1] - 2026-06-05

### Fixed

- New Draft (Cmd+N) surfaces the drafts directory in the file tree.
- File browser expansion state persists across reload and tab switch.

## [v0.27.0] - 2026-06-05

### Changed

- Drafts are stored in-tree under a configurable `.Drafts/` directory and addressed as in-root workspace paths; the server surfaces the drafts directory and the web client keys draft-path logic off it.

### Fixed

- A moved or deleted draft tab now closes cleanly.

## [v0.26.2] - 2026-06-05

Phase 18 follow-up: Linux desktop (WebKitGTK) fixes found while testing the v0.26.x desktop build. macOS code paths are unchanged.

### Added

- Linux desktop File menu, built explicitly because `Menu::default` only produces a File menu on macOS: File (About, Quit), Edit, Window, no Help. "About Chan" shows the version plus a manual "Check for updates" (the only manual self-update entry point off macOS); Quit is a custom item with an `app.exit(0)` handler because muda does not implement the predefined Quit on GTK.

### Fixed

- New draft (Ctrl+N) and Show Source (Ctrl+E) now fire off macOS. The handlers were Mac-only by accident (`Mod` resolves to Ctrl on Linux/Windows, and a `!ctrlKey` guard excluded it); they now follow the per-OS chord the shortcut registry already declared.
- The Hybrid pane flip (Cmd+, / Ctrl+,) no longer sticks mirror-reversed under WebKitGTK: the rotated-away face is hidden with a state-driven visibility swap rather than relying on `backface-visibility`, which WebKitGTK ignores inside a `preserve-3d` context (Blink was already correct, so the browser build was unaffected).
- The embedded terminal stays on the DOM renderer under WebKitGTK, fixing typed and pasted input that did not paint until a later keystroke (the WebGL layer did not composite while idle). Box-drawing characters fall back to the system font's glyphs on the Linux desktop.
- Ctrl+E stays inside a focused terminal for readline (move-to-end-of-line) instead of being claimed by the Show Source toggle.

## [v0.26.1] - 2026-06-04

Phase 18 follow-up: desktop self-update and Linux AppImage fixes.

### Fixed

- Desktop self-upgrade: the updater manifest endpoint was flattened to the static `/dl/desktop/latest.json` the release generator actually publishes; the previous templated path never matched, so desktop self-update always 404'd.
- Linux AppImage: prefer the host GTK/WebKit stack so a host whose Mesa is newer than the bundle (e.g. CachyOS) no longer aborts webview creation with `EGL_BAD_PARAMETER`.
- Insp
