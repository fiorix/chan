# chan public build surface.
#
# Keep this file as the command contract. Platform and package details belong
# in subdirectories such as desktop/, packaging/linux/, and packaging/freebsd/.

.DEFAULT_GOAL := help

PREFIX ?= $(if $(XDG_BIN_HOME),$(XDG_BIN_HOME:/bin=),$(HOME)/.local)
CARGO ?= cargo
NIX ?= nix
NIX_FLAKE ?= .
NPM ?= npm
PYTHON ?= python3
# The AUR recipes populate web/node_modules with `npm ci` in prepare() and then
# build offline, so WEB_SKIP_INSTALL=1 drops the install step from `web` and
# `web-launcher`. Every other consumer keeps the default install command.
WEB_SKIP_INSTALL ?= 0
NPM_INSTALL = $(if $(filter 1,$(WEB_SKIP_INSTALL)),true,$(NPM) install)
# Internal orchestration knob for compound targets that have just completed
# `make web` or `make web-check`. Standalone entry points leave this at 0.
WEB_ALREADY_BUILT ?= 0
WEB_PREREQ = $(if $(filter 1,$(WEB_ALREADY_BUILT)),,web)
AUR_ROOTFS ?= archlinux
AUR_REV ?= HEAD
WINDOWS_CROSS_ROOTFS ?= ubuntu
NIX_PACKAGE ?= all
NIX_SDME_ROOTFS ?= ubuntu
LINUX_TARGET ?= x86_64-unknown-linux-gnu
FREEBSD_TARGET ?= x86_64-unknown-freebsd
FREEBSD_SYSROOT ?=
DEB_TARGET ?= $(LINUX_TARGET)
RPM_TARGET ?= $(LINUX_TARGET)
ARCHPKG_TARGET ?= $(LINUX_TARGET)
CHAN_TARGET ?=

# Linux chan-desktop build (AppImage/.deb) runs inside an sdme container so a
# macOS workstation can produce Linux bundles. DISTRO selects the rootfs +
# .sdme template; SDME is how sdme is reached, which differs per workstation:
# a lima VM on macOS, sdme itself on a Linux host. See
# packaging/sdme/build-chan-desktop.sh.
DISTRO ?= ubuntu
UNAME_S := $(shell uname -s)
SDME ?= $(if $(filter Darwin,$(UNAME_S)),limactl shell default sudo sdme,sudo sdme)

# chan-gateway and the Nix packaging build are Linux-only. The gateway is
# built and tested inside an sdme container, and the Nix driver calls GNU
# coreutils under a PATH that deliberately excludes a Homebrew prefix, so
# neither means anything on a macOS or Windows host. Their targets refuse
# there rather than half-run and report a failure that says nothing about
# the tree: `realpath: illegal option -- m` and a wall of timed-out
# devserver-proxy control tests read like a broken branch, and cost a
# reviewer real time before they read like the wrong host.
LINUX_ONLY = @if [ "$(UNAME_S)" != "Linux" ]; then \
		echo "error: $@ is Linux-only; this host is $(UNAME_S)." >&2; \
		echo "  chan-gateway and the Nix build run on Linux, in an sdme container." >&2; \
		echo "  On this host run 'make ci-macos' (macOS) or 'make ci-windows' (Windows)." >&2; \
		exit 1; \
	fi
WINDOWS_CROSS_TARGET_DIR ?= $(REPO_ROOT)/target/windows-cross-check
NIX_SDME_OUT ?= /var/tmp/chan-nix-sdme-check

# make copr-check knobs: the container command for the SRPM stage, the matrix
# slice, the sdme rootfs names (imported names vary per host), and whether a
# finished container survives for diagnosis. The 0/1 knobs reject any other
# value. copr-check itself is Linux-only; it needs a writable host bind to get
# the guest's results back, which the macOS lima path cannot provide.
DOCKER ?= docker
COPR_RELEASE ?= all
COPR_EL9_ROOTFS ?= centos-stream-9
COPR_EL10_ROOTFS ?= centos-stream-10
KEEP_CONTAINER ?= 0
REUSE_SRPM ?= 0

BIN := target/release/chan
WEB_BUILD_STAMP := web/.chan-build-stamp
LAUNCHER_BUILD_STAMP := web-launcher/.chan-build-stamp
REPO_ROOT := $(abspath .)

# Gateway release crate set. Single source for the pre-push gateway
# build (gateway-build) and the release.yml deb-packaging matrix, which
# both read it instead of repeating the names, so a crate rename breaks
# the local gate rather than only the published release.
GATEWAY_RELEASE_CRATES := profile identity devserver-proxy devserver-control admin

.PHONY: help
help: ## Show this help.
	@printf "chan build and release targets\n\n"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-28s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: chan
chan: $(WEB_PREREQ) ## Build the release CLI binary.
	@if [ -n "$(CHAN_TARGET)" ]; then \
		$(CARGO) build --release --target "$(CHAN_TARGET)" -p chan; \
	else \
		$(CARGO) build --release -p chan; \
	fi

.PHONY: chan-desktop
chan-desktop: ## Build the desktop app through desktop/Makefile.
	$(MAKE) -C desktop build

.PHONY: desktop-dev
desktop-dev: ## Launch the desktop app in dev mode.
	$(MAKE) -C desktop dev

.PHONY: linux-chan-tarball
linux-chan-tarball: ## Build the Linux CLI tarball for LINUX_TARGET.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		LINUX_TARGET="$(LINUX_TARGET)" chan-tarball

.PHONY: freebsd-chan-tarball
freebsd-chan-tarball: ## Cross-build the static FreeBSD CLI tarball.
	$(MAKE) -C packaging/freebsd \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		FREEBSD_TARGET="$(FREEBSD_TARGET)" \
		FREEBSD_SYSROOT="$(FREEBSD_SYSROOT)" chan-tarball

.PHONY: linux-deb
linux-deb: ## Build a .deb for DEB_TARGET, defaulting to LINUX_TARGET.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		DEB_TARGET="$(DEB_TARGET)" deb

.PHONY: linux-rpm
linux-rpm: ## Build an .rpm for RPM_TARGET, defaulting to LINUX_TARGET.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		RPM_TARGET="$(RPM_TARGET)" rpm

.PHONY: linux-archpkg
linux-archpkg: ## Build an Arch package for ARCHPKG_TARGET.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		ARCHPKG_TARGET="$(ARCHPKG_TARGET)" archpkg

.PHONY: linux-packages
linux-packages: ## Build all Linux packages for the current target set.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" CARGO="$(CARGO)" NPM="$(NPM)" \
		DEB_TARGET="$(DEB_TARGET)" RPM_TARGET="$(RPM_TARGET)" \
		ARCHPKG_TARGET="$(ARCHPKG_TARGET)" packages

.PHONY: linux-chan-desktop
linux-chan-desktop: ## Build the chan-desktop AppImage/.deb for DISTRO via sdme.
	$(MAKE) -C packaging/linux \
		CHAN_REPO="$(REPO_ROOT)" SDME="$(SDME)" DISTRO="$(DISTRO)" \
		chan-desktop

.PHONY: linux-gateway
linux-gateway: ## Build the gateway .deb packages via sdme (the gateway-linux-packages mirror).
	# The gateway is a separate nested workspace, so its sdme build infra
	# lives under packaging/gateway/scripts/dev/sdme/ (next to chan-psql.sdme) rather
	# than packaging/linux. SDME selects how sdme is reached (lima on macOS).
	CHAN_REPO="$(REPO_ROOT)" SDME="$(SDME)" \
		packaging/gateway/scripts/dev/sdme/build-gateway.sh

.PHONY: distros-tarball
distros-tarball: ## Build the vendored source tarball (COPR/PPA input) under target/distros.
	packaging/distros/mkdist --repo "$(REPO_ROOT)"

.PHONY: copr-srpm
copr-srpm: ## Build the chan + chan-desktop SRPMs locally (fedora container).
	packaging/distros/copr/build-srpm.sh $(PKG)

.PHONY: copr-build
copr-build: ## Build the SRPMs and submit them to COPR (needs copr-cli auth).
	packaging/distros/copr/build-srpm.sh $(PKG) --submit

.PHONY: copr-check
copr-check: ## Build and smoke the supported CentOS COPR matrix via sdme (Linux hosts).
	SDME="$(SDME)" DOCKER="$(DOCKER)" PKG="$(or $(PKG),all)" \
		COPR_RELEASE="$(COPR_RELEASE)" REUSE_SRPM="$(REUSE_SRPM)" \
		KEEP_CONTAINER="$(KEEP_CONTAINER)" \
		COPR_EL9_ROOTFS="$(COPR_EL9_ROOTFS)" \
		COPR_EL10_ROOTFS="$(COPR_EL10_ROOTFS)" \
		packaging/distros/copr/build-with-sdme.sh

.PHONY: ppa-source
ppa-source: ## Build signed per-series Launchpad source packages from the tarball.
	packaging/distros/debian/build-source.sh $(PKG)

.PHONY: ppa-upload
ppa-upload: ## dput the built source packages to the Launchpad PPA.
	packaging/distros/debian/upload.sh

.PHONY: aur-check
aur-check: ## Build and smoke both AUR packages in a disposable sdme Arch container.
	AUR_ROOTFS="$(AUR_ROOTFS)" REV="$(AUR_REV)" SDME="$(SDME)" \
		packaging/distros/arch/build-with-sdme.sh

.PHONY: windows-cross-check
windows-cross-check: ## Check the release CLI for Windows GNU in a disposable sdme container.
	CARGO_TARGET_DIR="$(WINDOWS_CROSS_TARGET_DIR)" \
		WINDOWS_CROSS_ROOTFS="$(WINDOWS_CROSS_ROOTFS)" SDME="$(SDME)" \
		scripts/windows-cross-check.sh

.PHONY: browser-smoke-deps
browser-smoke-deps: ## Install headless Chrome and its libraries for scripts/e2e/browser-smoke.
	scripts/e2e/browser-smoke/provision.sh

.PHONY: homebrew-check
homebrew-check: ## Render and syntax-check both Homebrew tap definitions from released assets.
	packaging/distros/homebrew/make-homebrew-package.sh chan-desktop $(HOMEBREW_VERSION)
	packaging/distros/homebrew/make-homebrew-package.sh chan $(HOMEBREW_VERSION)

.PHONY: macos-chan-app
macos-chan-app: ## Build and sign the macOS .app bundle.
	$(MAKE) -C desktop app-signed

.PHONY: macos-chan-dmg
macos-chan-dmg: ## Build the macOS .dmg bundle.
	$(MAKE) -C desktop dmg-layout-proof

.PHONY: macos-chan-dmg-notarised
macos-chan-dmg-notarised: ## Build, notarise, and staple the macOS .dmg.
	$(MAKE) -C desktop app-notarized

.PHONY: macos-chan-dmg-notarized
macos-chan-dmg-notarized: macos-chan-dmg-notarised

.PHONY: windows-chan-installer
windows-chan-installer: ## Build the Windows NSIS desktop installer.
	$(MAKE) -C desktop windows-installer

.PHONY: shell-check
shell-check: ## Run shellcheck over the tracked shell scripts.
	scripts/lint-static.sh shell

.PHONY: workflow-check
workflow-check: ## Run actionlint (and shellcheck on run: blocks) over the workflows.
	scripts/lint-static.sh workflows

.PHONY: build-matrix-check
build-matrix-check: ## Verify every shipped build surface remains gated.
	$(PYTHON) scripts/check-build-matrix.py

.PHONY: nix-check
nix-check: ## Evaluate, build, and smoke both Nix packages.
	$(LINUX_ONLY)
	$(NIX) flake check --all-systems --no-build "$(NIX_FLAKE)"
	@set -e; \
	for package in chan chan-desktop; do \
		out="$$($(NIX) build --no-link --print-out-paths "$(NIX_FLAKE)#$$package")"; \
		[ -n "$$out" ] && [ "$$(printf '%s\n' "$$out" | wc -l)" -eq 1 ] || { \
			echo "error: expected one Nix output path for $$package, got: $$out" >&2; \
			exit 1; \
		}; \
		scripts/smoke-nix-package.sh "$$out" "$$package"; \
	done

.PHONY: nix-sdme-check
nix-sdme-check: ## Run Nix checks in a disposable Ubuntu sdme guest.
	$(LINUX_ONLY)
	NIX_PACKAGE="$(NIX_PACKAGE)" NIX_SDME_ROOTFS="$(NIX_SDME_ROOTFS)" \
		OUT="$(NIX_SDME_OUT)" SDME="$(SDME)" \
		packaging/nix/build-with-sdme.sh

.PHONY: nix-sdme-contract-check
nix-sdme-contract-check: ## Check the sdme Nix driver without starting a guest.
	$(LINUX_ONLY)
	TMPDIR=/var/tmp packaging/nix/test-build-with-sdme.sh

.PHONY: pre-push
pre-push: ## Run the local pre-push gate.
	# The static checks run first: they are seconds-long, they cover the
	# packaging and CI surface no cargo/npm target reads, and a finding there
	# is not worth a full compile to discover.
	$(MAKE) shell-check
	$(MAKE) workflow-check
	$(MAKE) build-matrix-check
ifeq ($(UNAME_S),Linux)
	# Linux-only (see LINUX_ONLY), but kept HERE with the other static checks
	# rather than beside the gateway block below: it is seconds long and needs
	# no compile, so a finding in it should not cost a full clippy + test +
	# build first. The gateway steps stay below because they ARE compiles.
	$(MAKE) nix-sdme-contract-check
endif
	$(MAKE) web-lock-check
	$(CARGO) fmt --check
	RUSTFLAGS="-D warnings" $(CARGO) clippy --all-targets -- -D warnings
	RUSTFLAGS="-D warnings" $(CARGO) test --all-targets
	RUSTFLAGS="-D warnings" $(CARGO) build --no-default-features
ifeq ($(UNAME_S),Linux)
	# chan-gateway and the Nix packaging driver are Linux-only (see
	# LINUX_ONLY), so this block is the Linux arm's alone. A macOS or
	# Windows host runs the rest and the git hook stays usable there;
	# ci-linux is what covers these, and it is the gate CI runs for them.
	#
	# gateway-lint compiles every gateway test target without executing it;
	# gateway-test executes the database-free subset and reports the seven
	# Postgres-backed integration-test files as not run; gateway-build only
	# compiles the release crates.
	$(MAKE) gateway-fmt
	$(MAKE) gateway-lint
	RUSTFLAGS="-D warnings" $(MAKE) gateway-test
	RUSTFLAGS="-D warnings" $(MAKE) gateway-build
endif
	$(MAKE) web-check
	$(MAKE) web-marketing-check
	$(MAKE) shortcuts-check
	$(MAKE) host-build-check WEB_ALREADY_BUILT=1

.PHONY: host-devserver-build-check
host-devserver-build-check: chan ## Build and boot-smoke the host release CLI.
	scripts/smoke-built-devserver.sh "$(BIN)"

.PHONY: ci-linux-build
ci-linux-build: host-devserver-build-check ## Build Linux release surfaces.
	$(MAKE) -C desktop ci-linux WEB_ALREADY_BUILT=1

.PHONY: ci-macos-build
ci-macos-build: host-devserver-build-check ## Build macOS release surfaces.
	$(MAKE) -C desktop ci-macos WEB_ALREADY_BUILT=1

.PHONY: host-build-check
host-build-check: ## Build the native host's release CLI and desktop package.
ifeq ($(UNAME_S),Linux)
	$(MAKE) ci-linux-build
else ifeq ($(UNAME_S),Darwin)
	$(MAKE) ci-macos-build
else
	@echo "error: make pre-push needs a native Linux or macOS host"; exit 1
endif

.PHONY: ci-linux
ci-linux: pre-push ## Run the Linux CI validation target.

.PHONY: ci-macos
ci-macos: ## Run the focused macOS CI validation target.
	$(MAKE) build-matrix-check
	RUSTFLAGS="-D warnings" $(CARGO) clippy --all-targets -- -D warnings
	RUSTFLAGS="-D warnings" $(CARGO) test --all-targets
	$(MAKE) ci-macos-build

.PHONY: ci-windows
ci-windows: ## Test the Windows-meaningful crates, build and smoke the NSIS package.
	$(MAKE) build-matrix-check
	# The Rust test run is scoped to chan-library and chan-desktop, the two
	# crates whose Windows behavior is worth testing: chan-library carries
	# the `#[cfg(windows)]` ConPTY child-reaping tests that no other arm can
	# execute, and chan-desktop is the Windows shell itself. The rest of the
	# workspace (chan-workspace, chan-server, the tunnel crates, and so on)
	# is platform-neutral logic whose test harnesses assume a Unix host
	# (verbatim-vs-normalized path identity, POSIX shell commands, real-PTY
	# tests that drive a shell to completion). Those suites have never run on
	# Windows and porting their harnesses tests the port, not the product;
	# running them here surfaced a backlog of Unix assumptions with no
	# Windows-specific coverage to show for it. See the roadmap draft on a
	# full Windows test port.
	#
	# The release CLI is built first because `desktop/src-tauri` is a
	# workspace member, so compiling chan-desktop's tests pulls in its
	# Windows Tauri config, which declares `target/release/chan.exe` as a
	# bundled resource. Only the Windows config declares it, which is why the
	# Linux and macOS arms run their sweeps without this step. The web bundles
	# are built before it on purpose: chan-server embeds web/dist and
	# web-launcher/dist via rust-embed, so a CLI built before they exist is
	# rebuilt from the embed crates up once the bundles appear, and so is one
	# built before a second `make web` rewrites them (vite emits the same
	# files with new mtimes, which is a rebuild to cargo). Either costs about
	# nine minutes on the Windows runner. So: build the bundles once, here,
	# and tell `desktop ci-windows` they exist (WEB_ALREADY_BUILT=1, as
	# ci-linux-build and ci-macos-build do), which makes its own
	# `cargo build --release -p chan` a no-op.
	$(MAKE) web
	$(CARGO) build --release -p chan
	# The `chan` crate's own tests run on no Windows arm (see above), and the
	# standalone chan.exe is a published release artifact. Most of the crate is
	# covered on the other arms through its injectable pure cores; what is not
	# is the two Windows-only syscall wrappers. This smoke drives exactly those
	# -- the DETACHED_PROCESS daemon spawn and the `\\.\pipe\` control-socket
	# connect -- plus the plain fact that chan.exe reaches `main` at all. It is
	# a few seconds and is not the deferred full-suite Windows port.
	scripts/smoke-windows-cli.sh target/release/chan.exe
	RUSTFLAGS="-D warnings" $(CARGO) test -p chan-library -p chan-desktop --all-targets
	$(MAKE) -C desktop ci-windows WEB_ALREADY_BUILT=1
	scripts/smoke-built-devserver.sh target/release/chan-desktop.exe

.PHONY: ci-linux-packages
ci-linux-packages: ## Build the direct-download Linux deb and rpm packages.
	$(MAKE) web
	$(MAKE) linux-deb WEB_ALREADY_BUILT=1
	$(MAKE) linux-rpm WEB_ALREADY_BUILT=1

.PHONY: ci-distro-sources
ci-distro-sources: ## Assemble COPR and unsigned noble PPA source packages.
	# copr-srpm creates the shared vendored tarball that ppa-source consumes,
	# so running distros-tarball separately would repeat npm + cargo vendor.
	$(MAKE) copr-srpm
	PPA_NOSIGN=1 PPA_SERIES=noble $(MAKE) ppa-source

.PHONY: docker-build
docker-build: ## Build all chan and gateway OCI images.
	packaging/docker/build.sh

.PHONY: docker-chan-build
docker-chan-build: ## Build the chan CLI/devserver OCI image.
	packaging/docker/build.sh --chan-only

.PHONY: docker-gateway-build
docker-gateway-build: ## Build all four chan-gateway OCI images.
	packaging/docker/build.sh --gateway-only

.PHONY: ci-release
ci-release: pre-push ## Run the local release validation target.

.PHONY: gateway-spa
gateway-spa: ## Build the gateway identity SPA bundle (rust-embed input).
	$(LINUX_ONLY)
	cd web && $(NPM) install && $(NPM) run build -w @chan/profile

.PHONY: gateway-fmt
gateway-fmt: ## Check formatting in the separate gateway workspace.
	$(LINUX_ONLY)
	cd gateway && $(CARGO) fmt --check

.PHONY: gateway-build
gateway-build: gateway-spa ## Build, but do not test, the gateway release crates (GATEWAY_CARGO_FLAGS adds cross/release).
	$(LINUX_ONLY)
	# Depends on gateway-spa: identity embeds web/dist via rust-embed at
	# compile time, so the bundle must exist or the derive fails to build.
	cd gateway && $(CARGO) build $(GATEWAY_CARGO_FLAGS) \
		$(foreach crate,$(GATEWAY_RELEASE_CRATES),-p $(crate))

.PHONY: gateway-lint
gateway-lint: gateway-spa ## Clippy all gateway targets without executing tests.
	$(LINUX_ONLY)
	# The gateway is a separate Cargo workspace, so the root clippy run does
	# not reach it. Depends on gateway-spa for the same rust-embed reason as
	# gateway-build.
	cd gateway && RUSTFLAGS="-D warnings" $(CARGO) clippy --all-targets -- -D warnings

.PHONY: gateway-test
gateway-test: gateway-spa ## Execute gateway tests that do not require Postgres.
	$(LINUX_ONLY)
	@printf '%s\n' \
		'gateway-test: EXECUTE: all gateway library unit tests' \
		'gateway-test: EXECUTE: devserver-proxy unit, integration, and doc tests' \
		'gateway-test: NOT RUN: 7 profile/identity integration-test files require TEST_DATABASE_URL'
	cd gateway && $(CARGO) test --workspace --lib
	cd gateway && $(CARGO) test -p devserver-proxy

.PHONY: gateway-release-crates
gateway-release-crates: ## Print the gateway release crate names on one line.
	@echo $(GATEWAY_RELEASE_CRATES)

.PHONY: web-launcher
web-launcher: ## Build the embedded launcher bundle (web-launcher/dist).
	# chan-server bakes BOTH frontend bundles via rust-embed: web/dist
	# (WebAssets) and web-launcher/dist (LauncherAssets, the devserver/library
	# root SPA). web-launcher/dist is a gitignored build artifact, so every
	# path that builds web/dist before the cargo/rust-embed step must build
	# this too -- wired as a prerequisite of `web`/`web-check` so the single
	# `make web` funnel (root `chan`, desktop/Makefile, packaging/linux,
	# packaging/freebsd, release.yml) builds both with no per-consumer edit.
	cd web && $(NPM_INSTALL) && $(NPM) run build -w @chan/launcher
	@date -u '+%Y-%m-%dT%H:%M:%SZ' > "$(LAUNCHER_BUILD_STAMP)"

.PHONY: web
web: web-launcher ## Build the embedded web bundle.
	cd web && $(NPM_INSTALL) && $(NPM) run build -w @chan/workspace-app
	@date -u '+%Y-%m-%dT%H:%M:%SZ' > "$(WEB_BUILD_STAMP)"

.PHONY: web-lock-check
web-lock-check: ## Verify web/package-lock.json is in sync with every package.json.
	# Every other web target runs `npm install`, which silently REPAIRS a
	# desynced lockfile in the working tree, so the committed file can be
	# broken while the whole gate stays green. Only a strict `npm ci` rejects
	# it. The only other strict npm ci in the system runs in the Nix sandbox,
	# which executes after the tag is pushed and checks out the tag: by then
	# the release cannot be repaired.
	#
	# This runs among the static checks, before anything can rewrite the file,
	# and costs about two seconds. npm 10+ skips the node_modules removal phase
	# under --dry-run; the recipe enforces that floor before relying on it.
	# --ignore-scripts is required, not cosmetic: npm still runs lifecycle
	# scripts under --dry-run. This tree's `postinstall` calls patch-package, so
	# on a fresh checkout (every CI runner) the check would exit 127 on a binary
	# that is not installed yet. The lockfile sync
	# validation happens before any script runs, so skipping scripts costs the
	# check nothing.
	@set -eu; \
		npm_version="$$( $(NPM) --version )"; \
		npm_major="$${npm_version%%.*}"; \
		case "$$npm_major" in \
			''|*[!0-9]*) \
				printf 'error: web-lock-check could not parse npm version %s\n' \
					"$$npm_version" >&2; \
				exit 1 ;; \
		esac; \
		if [ "$$npm_major" -lt 10 ]; then \
			printf '%s\n' \
				"error: web-lock-check requires npm >= 10; resolved npm version $$npm_version may remove node_modules under --dry-run" >&2; \
			exit 1; \
		fi
	cd web && $(NPM) ci --dry-run --ignore-scripts

.PHONY: web-check
web-check: web-launcher ## Run frontend check, vitest, and production build.
	# vitest (npm test == `vitest run`) gates here so the pre-push / ci-linux
	# path covers the frontend unit tests: CI runs the make ci-* targets, so
	# anything absent here is ungated. The `web-launcher` prerequisite builds
	# the launcher bundle so the pre-push / release cargo build embeds a real
	# launcher.
	#
	# The web-launcher prerequisite only BUILDS the launcher (vite build), which
	# misses type errors + unit regressions, so gate its svelte-check + vitest
	# here too (it already ran `npm install`). @chan/profile builds in
	# gateway-spa, which runs vite build alone, so its check + test belong here
	# for the same reason. All three SPAs are fully gated.
	cd web && $(NPM) install \
		&& $(NPM) run check -w @chan/launcher && $(NPM) run test -w @chan/launcher \
		&& $(NPM) run check -w @chan/workspace-app && $(NPM) run test -w @chan/workspace-app \
		&& $(NPM) run check -w @chan/profile && $(NPM) run test -w @chan/profile \
		&& $(NPM) run build -w @chan/workspace-app
	@date -u '+%Y-%m-%dT%H:%M:%SZ' > "$(WEB_BUILD_STAMP)"

.PHONY: shortcuts-check
shortcuts-check: ## Verify chan serve's keybinding table matches shortcuts.ts.
	# KEYBINDINGS_TABLE is generated from shortcuts.ts and pasted into the
	# Rust const by hand, so a chord change in the TS silently leaves `chan serve
	# --help` lying. Diff the generator's output against the const. Lives on
	# the web side because the generator needs node, which the Rust jobs do
	# not guarantee.
	cd web && $(NPM) install >/dev/null
	python3 scripts/check-shortcuts-help.py

.PHONY: web-marketing-check
web-marketing-check: ## Run marketing site checks.
	cd web && $(NPM) install && $(NPM) run check -w @chan/marketing

.PHONY: models
models: ## Pre-fetch the optional embedded search model.
	$(CARGO) run --release -p fetch-models

.PHONY: build-release
build-release: models web ## Build chan with the embedded search model.
	$(CARGO) build --release --features embed-model -p chan

.PHONY: test
test: ## Run Rust tests.
	$(CARGO) test --workspace

.PHONY: lint
lint: ## Run Rust formatting and clippy checks.
	$(CARGO) fmt --check
	$(CARGO) clippy --all-targets -- -D warnings

.PHONY: hooks
hooks: ## Install the git pre-push hook.
	./scripts/install-hooks

.PHONY: install
install: chan ## Install chan under PREFIX/bin.
	install -d $(PREFIX)/bin
	install -m 755 $(BIN) $(PREFIX)/bin/chan
	@echo "installed to $(PREFIX)/bin/chan"
	@case ":$$PATH:" in *":$(PREFIX)/bin:"*) ;; \
		*) echo "note: $(PREFIX)/bin is not in PATH; add it to your shell rc";; \
	esac

.PHONY: uninstall
uninstall: ## Remove chan from PREFIX/bin.
	rm -f $(PREFIX)/bin/chan
	@echo "removed $(PREFIX)/bin/chan"

.PHONY: clean
clean: ## Remove local build outputs (root workspace, web, gateway, desktop).
	$(CARGO) clean
	rm -rf web/dist web/node_modules web/pkg
	rm -rf web-launcher/dist web-launcher/node_modules
	rm -f $(WEB_BUILD_STAMP) $(LAUNCHER_BUILD_STAMP)
	# gateway/ is its own cargo workspace: root `cargo clean` never
	# touches gateway/target. The gateway frontend lives in the ./web
	# npm workspace; only its rust-embed SPA dist remains under gateway/.
	cd gateway && $(CARGO) clean
	rm -rf gateway/crates/identity/web/dist
	# Desktop owns its extras (downloaded sidecar binaries); same
	# delegation as the chan-desktop / desktop-dev build targets.
	$(MAKE) -C desktop clean

.PHONY: dev
dev: chan ## Run chan serve against /tmp/chan-dev with no token.
	$(BIN) serve /tmp/chan-dev --no-token

.PHONY: all build rpm
all: chan
build: chan
rpm: linux-rpm
