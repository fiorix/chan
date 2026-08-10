.PHONY: dev build check fmt fmt-check lint test clean web tauri-cli \
        app-signed app-notarized sign-prereqs notarize-prereqs \
        dmg-layout-proof windows-installer xwin-prereqs xwin-check \
        ci-linux-prereqs ci-linux ci-macos ci-windows

# Monorepo root. Override via CHAN_REPO=/path on CI.
CHAN_REPO ?= ..
CARGO ?= cargo
NPM ?= npm
TAURI_CLI_VERSION ?= ^2
# Under .build-tools/, never target/. CI caches target/, and this root is
# PREPENDED to PATH below whether or not it exists, so a cached copy would
# silently outrank the pinned tool a job just installed -- and TAURI_CLI_VERSION
# is applied at install time only, so a restored one is never re-checked.
TAURI_CLI_ROOT := $(abspath $(CHAN_REPO)/.build-tools/tauri-cli)
TAURI_CLI_BIN := $(TAURI_CLI_ROOT)/bin/cargo-tauri
TAURI := PATH="$(TAURI_CLI_ROOT)/bin:$$PATH" cargo tauri

# Finder-less DMG packaging (packaging/desktop/build-dmg.sh + dmg_settings.py). The
# layout is pinned by the settings file, so any dmgbuild 1.x yields the same
# layout; tighten DMGBUILD_SPEC to an exact `==` for a fully reproducible pin.
DMGBUILD_SPEC ?= dmgbuild>=1.6,<2
# Under .build-tools/, never target/: see TAURI_CLI_ROOT above. A venv is the
# worst thing to cache, because it stores the absolute path of the interpreter
# that created it.
DMG_VENV ?= $(abspath $(CHAN_REPO))/.build-tools/dmg-venv
BUNDLE_DIR := $(abspath $(CHAN_REPO))/target/release/bundle
CI_MACOS_CONFIG := tauri.ci.macos.conf.json
CI_WINDOWS_CONFIG := tauri.ci.windows.conf.json
WEB_ALREADY_BUILT ?= 0
CI_WEB_PREREQ = $(if $(filter 1,$(WEB_ALREADY_BUILT)),,web)

# Keep local dev self-contained: CI installs tauri-cli globally, but a
# fresh workstation usually does not have the cargo subcommand yet.
tauri-cli:
	@if ! command -v cargo-tauri >/dev/null 2>&1 \
	    && [ ! -x "$(TAURI_CLI_BIN)" ]; then \
	    echo "installing tauri-cli $(TAURI_CLI_VERSION) under $(TAURI_CLI_ROOT)"; \
	    cargo install tauri-cli --locked --version "$(TAURI_CLI_VERSION)" \
	        --root "$(TAURI_CLI_ROOT)"; \
	fi

# Build the embedded web bundles. chan-desktop is fully self-
# contained: it links chan + chan-server + chan-workspace directly
# and embeds web/dist plus web-launcher/dist via rust-embed. On
# macOS/Linux no `chan` binary ships in the bundle (argv[0] dispatch
# covers it); the Windows NSIS bundle carries chan.exe as a resource.
# The only build-time staging step is the web bundles the Rust crate
# embeds.
web:
	$(MAKE) -C $(CHAN_REPO) web

# Launch the desktop app in dev mode (cargo tauri dev). Matches the
# root Makefile's `make dev` convention: each launches its component
# in dev mode.
dev: tauri-cli web
	cd src-tauri && $(TAURI) dev

build: tauri-cli web
	cd src-tauri && $(TAURI) build

windows-installer: tauri-cli web
	cd $(CHAN_REPO) && $(CARGO) build --release -p chan
	cd src-tauri && $(TAURI) build --bundles nsis --config tauri.windows.conf.json

# Secret-free native package proofs for ordinary CI. Release signing and
# notarization stay in release.yml; these targets prove that the platform
# compiler and bundler can create the artifact on every pull request.
ci-linux-prereqs:
	@for tool in xdg-open xdg-mime; do \
	    command -v "$$tool" >/dev/null 2>&1 || { \
	        echo "error: $$tool is required; install xdg-utils"; exit 1; \
	    }; \
	done

ci-linux: ci-linux-prereqs tauri-cli $(CI_WEB_PREREQ)
	@test "$$(uname -s)" = Linux || { \
	    echo "error: desktop ci-linux requires a native Linux host"; exit 1; \
	}
	cd src-tauri && $(TAURI) build --bundles appimage
	@appimage="$$(find "$(BUNDLE_DIR)/appimage" -name '*.AppImage' \
	    -type f -print -quit)"; \
	    [ -n "$$appimage" ] \
	        || { echo "error: Tauri emitted no AppImage"; exit 1; }; \
	    "$(CHAN_REPO)/scripts/smoke-built-devserver.sh" "$$appimage"

ci-macos: tauri-cli $(CI_WEB_PREREQ)
	@test "$$(uname -s)" = Darwin || { \
	    echo "error: desktop ci-macos requires a native macOS host"; exit 1; \
	}
	cd src-tauri && $(TAURI) build --bundles app --config $(CI_MACOS_CONFIG)
	@test -x "$(BUNDLE_DIR)/macos/Chan.app/Contents/MacOS/chan-desktop" \
	    || { echo "error: Tauri emitted no runnable Chan.app"; exit 1; }
	codesign --verify --deep --strict "$(BUNDLE_DIR)/macos/Chan.app"
	"$(CHAN_REPO)/scripts/smoke-built-devserver.sh" \
	    "$(BUNDLE_DIR)/macos/Chan.app/Contents/MacOS/chan-desktop"

ci-windows: tauri-cli $(CI_WEB_PREREQ)
	@case "$$(uname -s)" in \
	    MINGW*|MSYS*|CYGWIN*) ;; \
	    *) echo "error: desktop ci-windows requires a native Windows host"; \
	       exit 1 ;; \
	esac
	cd $(CHAN_REPO) && $(CARGO) build --release -p chan
	cd src-tauri && $(TAURI) build --bundles nsis \
	    --config $(CI_WINDOWS_CONFIG)
	@find "$(BUNDLE_DIR)/nsis" -name '*.exe' -type f -print -quit \
	    | grep -q . || { echo "error: Tauri emitted no NSIS installer"; exit 1; }

check:
	cd src-tauri && cargo check

# ---------------------------------------------------------------------------
# Windows cross-compile check (cargo-xwin) -- fast local Windows compile proof.
# ---------------------------------------------------------------------------
#
# cargo-xwin cross-compiles to the MSVC target from macOS/Linux by downloading
# the MSVC CRT + Windows SDK headers on demand (no Windows host, no Wine -- Wine
# can't run WebView2 anyway). This is the team's FAST local proof that the
# cfg(windows) arms compile. The AUTHORITATIVE Windows build + NSIS bundle is
# `make ci-windows` in .github/workflows/ci.yml per pull request, and
# release.yml's Windows artifacts on the tag path.
#
# Crate set is the core (server/shell/workspace): those carry the cfg(windows)
# transport + terminal arms and must compile before the desktop GUI build can.
# The chan-desktop crate's full Windows build pulls the whole Tauri + WebView2
# toolchain and is proven by those native Windows CI jobs, not here.
XWIN_TARGET ?= x86_64-pc-windows-msvc
XWIN_CRATES ?= -p chan-server -p chan-shell -p chan-workspace

# cargo-xwin needs the LLVM toolchain ON TOP OF cargo-xwin + the rust target:
# cc-rs shells out to `llvm-lib` / `clang-cl` to build the C deps (ring), so a
# host without LLVM dies with `failed to find tool "llvm-lib"`.
# `check` needs llvm-lib + clang-cl (no linking); a full `xwin build` would also
# need `lld-link` from the `lld` package.
#   macOS:  brew install llvm        (keg-only; bin auto-added to PATH below)
#   Debian: sudo apt-get install -y llvm clang lld
# CI's windows-latest needs none of this -- it builds with native MSVC.
#
# On macOS Homebrew's llvm is keg-only (its bin is NOT on the default PATH), so
# auto-prepend it: a plain `brew install llvm` is then enough, no manual PATH
# edit. Override with LLVM_BIN=/path on a non-Homebrew host.
LLVM_BIN ?= $(shell command -v brew >/dev/null 2>&1 && echo "$$(brew --prefix llvm 2>/dev/null)/bin")
XWIN_PATH := $(if $(LLVM_BIN),$(LLVM_BIN):$(PATH),$(PATH))

# Install cargo-xwin + the Windows MSVC rust target on demand (same on-demand
# posture as tauri-cli), and fail fast with install guidance when LLVM is
# missing -- cargo-xwin's own error is further down the build and less obvious.
xwin-prereqs:
	@PATH="$(XWIN_PATH)" command -v llvm-lib >/dev/null 2>&1 || { \
	    echo "error: cargo-xwin needs the LLVM toolchain (llvm-lib / clang-cl) on PATH."; \
	    echo "  macOS:  brew install llvm"; \
	    echo "  Debian: sudo apt-get install -y llvm clang lld"; \
	    echo "  (macOS keg-only llvm is auto-added to PATH; else set LLVM_BIN=/path)"; \
	    exit 1; \
	}
	@if ! command -v cargo-xwin >/dev/null 2>&1; then \
	    echo "installing cargo-xwin"; \
	    cargo install cargo-xwin --locked; \
	fi
	@rustup target add $(XWIN_TARGET) >/dev/null 2>&1 || true

# Compile-check the core crates for Windows. Runs from the repo root so cargo
# resolves the workspace; RUSTFLAGS parity with the integrated -D warnings gate.
# XWIN_PATH puts the LLVM tools on PATH for cc-rs (ring).
xwin-check: xwin-prereqs
	cd $(CHAN_REPO) && PATH="$(XWIN_PATH)" RUSTFLAGS="-D warnings" cargo xwin check \
	    --target $(XWIN_TARGET) $(XWIN_CRATES)

fmt:
	cd src-tauri && cargo fmt --all

fmt-check:
	cd src-tauri && cargo fmt --all -- --check

lint:
	cd src-tauri && cargo clippy --all-targets -- -D warnings

test:
	cd src-tauri && cargo test --all-targets

clean:
	cd src-tauri && cargo clean
	rm -rf src-tauri/binaries

# ---------------------------------------------------------------------------
# Code signing + notarization (macOS, distribution to others).
# ---------------------------------------------------------------------------
#
# Signing is environment-driven; nothing personal lives in this repo.
#
#   APPLE_SIGNING_IDENTITY  full identity string from
#                           `security find-identity -v -p codesigning`,
#                           e.g. "Developer ID Application: Name (TEAMID)".
#                           Auto-detected from the keychain when a
#                           single "Developer ID Application: ..." cert
#                           is present; pin explicitly when there is
#                           more than one.
#   APPLE_TEAM_ID           the 10-char Team ID at the end of the
#                           identity string. Auto-derived from
#                           APPLE_SIGNING_IDENTITY; override only if
#                           the cert name does not follow the
#                           "... (TEAMID)" convention.
#   APPLE_ID                the Apple Developer account email
#   APPLE_PASSWORD          app-specific password generated at
#                           appleid.apple.com -> Sign-In and Security
#                           -> App-Specific Passwords. NOT the iCloud
#                           password. Treat as a credential.
#
# Recommended local flow: stash the app-specific password as a
# notarytool Keychain profile so `make app-notarized` runs from a
# bare shell with no env exports (see "Local notarization setup" in
# .agents/desktop.md):
#
#   xcrun notarytool store-credentials chan \
#       --apple-id <email> --team-id <TEAMID> --password <app-pw>
#
# Then plain `make app-notarized` Just Works. CI keeps the env-var
# path via APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID populated from
# GitHub Actions Secrets. Env vars win over Keychain profile when
# both are present (lets you test alternative credentials without
# removing your default profile).
#
# Two paths:
#
#   app-signed       sign the .app with Developer ID. Gatekeeper
#                    accepts on machines where the user has
#                    right-clicked -> Open at least once. Faster
#                    than notarized; useful for local install or
#                    dev distribution.
#   app-notarized    sign + send to Apple's notary service + staple
#                    the ticket + bundle a .dmg. The .dmg opens
#                    cleanly on any Mac with no Gatekeeper warnings.
#                    Roundtrip to Apple is 2-15 min per build.
#
# Both targets fail fast with a clear message if the required env
# vars are missing, so a half-built unsigned .app never gets handed
# off by accident.

# Auto-derive APPLE_SIGNING_IDENTITY from the keychain when not
# pinned. Two `security` calls (instead of `$(words ...)`) because
# the identity string contains spaces, which would break naive
# word-counting.
ifeq ($(APPLE_SIGNING_IDENTITY),)
DETECTED_SIGN_COUNT := $(shell security find-identity -v -p codesigning 2>/dev/null \
    | grep -c '"Developer ID Application:')
ifeq ($(DETECTED_SIGN_COUNT),1)
APPLE_SIGNING_IDENTITY := $(shell security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p')
endif
endif
# Do not export an empty signing identity: Tauri treats a present-but-empty
# APPLE_SIGNING_IDENTITY as an explicit codesign identity and fails with
# "no identity found" instead of using its unsigned/ad-hoc local build path.
ifneq ($(APPLE_SIGNING_IDENTITY),)
export APPLE_SIGNING_IDENTITY
endif

# Auto-derive APPLE_TEAM_ID from the trailing "(TEAMID)" in the
# signing identity. Skipped when the identity is unset (the
# sign-prereqs target reports that case).
ifeq ($(APPLE_TEAM_ID),)
ifneq ($(APPLE_SIGNING_IDENTITY),)
APPLE_TEAM_ID := $(shell echo "$(APPLE_SIGNING_IDENTITY)" \
    | sed -n 's/.*(\([A-Z0-9]\{10\}\))$$/\1/p')
endif
endif
ifneq ($(APPLE_TEAM_ID),)
export APPLE_TEAM_ID
endif

# Local-notarization helper. Apple's blessed mechanism for storing
# app-specific passwords for `notarytool` is `xcrun notarytool
# store-credentials <profile-name>`; once a profile is stashed,
# subsequent submissions consume it via --keychain-profile. Default
# profile name is `chan`; override with NOTARIZE_PROFILE=othername.
NOTARIZE_PROFILE ?= chan

# Detect which credential source app-notarized uses. Precedence:
# env vars first (CI's GH-Secrets-driven path stays authoritative),
# then the local Keychain profile. Empty if neither is configured;
# notarize-prereqs reports the case with a setup hint.
#
# The Keychain check uses `security find-generic-password` against
# notarytool's service id (com.apple.gke.notary.tool); it just
# tests existence (no -g/-w), so it does not prompt for Keychain
# access and the actual password value never leaves the Keychain.
ifneq ($(and $(APPLE_ID),$(APPLE_PASSWORD),$(APPLE_TEAM_ID)),)
NOTARIZE_VIA := env
else ifneq ($(shell security find-generic-password \
    -s "com.apple.gke.notary.tool" -a "$(NOTARIZE_PROFILE)" \
    >/dev/null 2>&1 && echo yes),)
NOTARIZE_VIA := keychain
else
NOTARIZE_VIA :=
endif

sign-prereqs:
	@if [ -z "$$APPLE_SIGNING_IDENTITY" ]; then \
	    echo "error: APPLE_SIGNING_IDENTITY not set"; \
	    echo "find one with: security find-identity -v -p codesigning"; \
	    echo "example: export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'"; \
	    exit 1; \
	fi
	@security find-identity -v -p codesigning | \
	    grep -F "$$APPLE_SIGNING_IDENTITY" >/dev/null || { \
	    echo "error: identity '$$APPLE_SIGNING_IDENTITY' not in keychain"; \
	    echo "available identities:"; \
	    security find-identity -v -p codesigning; \
	    exit 1; \
	}

notarize-prereqs:
	@if [ -z "$(NOTARIZE_VIA)" ]; then \
	    echo "error: no notarization credentials available"; \
	    echo "  option 1 (local dev, recommended): stash an app-specific"; \
	    echo "    password as a notarytool Keychain profile named"; \
	    echo "    '$(NOTARIZE_PROFILE)'. One-time setup on the workstation:"; \
	    echo "      xcrun notarytool store-credentials $(NOTARIZE_PROFILE) \\"; \
	    echo "          --apple-id <email> --team-id <TEAMID> \\"; \
	    echo "          --password <app-specific-password>"; \
	    echo "    Override the profile name with NOTARIZE_PROFILE=othername."; \
	    echo "  option 2 (CI / env-driven): set APPLE_ID + APPLE_PASSWORD +"; \
	    echo "    APPLE_TEAM_ID. APPLE_PASSWORD is the app-specific password"; \
	    echo "    generated at appleid.apple.com, NOT the iCloud password."; \
	    echo "    APPLE_TEAM_ID auto-derives from APPLE_SIGNING_IDENTITY"; \
	    echo "    when the cert name ends in '(TEAMID)'."; \
	    exit 1; \
	fi

# Sign the .app with the configured Developer ID identity. No
# notarization, no .dmg. Tauri picks APPLE_SIGNING_IDENTITY out of
# the env when calling `codesign`.
app-signed: sign-prereqs tauri-cli web
	cd src-tauri && $(TAURI) build --bundles app
	@echo ""
	@echo "signed .app: $(CHAN_REPO)/target/release/bundle/macos/Chan.app"
	@echo "verify: codesign -dv --verbose=2 $(CHAN_REPO)/target/release/bundle/macos/Chan.app"

# Sign + notarize + staple + bundle a .dmg.
#
# We build ONLY the signed .app with Tauri, then build the .dmg ourselves with
# `dmgbuild` (packaging/desktop/build-dmg.sh), because tauri-bundler's DMG step lays out
# the Finder window over AppleScript/Finder, which no-ops on a headless CI
# runner and ships a flat default-layout DMG. dmgbuild writes the layout
# programmatically (no Finder), so local == CI byte-for-byte. The notarize is
# split from the build: tauri-bundler 2.x only knows the
# APPLE_ID/PASSWORD/TEAM_ID auth shape, not notarytool Keychain profiles, so we
# unset those env vars during the Tauri build and call `xcrun notarytool submit`
# ourselves with the right flag set (Keychain profile locally, env vars on CI).
app-notarized: sign-prereqs notarize-prereqs tauri-cli web
	cd src-tauri && env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
	    $(TAURI) build --bundles app
	@set -e; \
	    APP="$(BUNDLE_DIR)/macos/Chan.app"; \
	    if [ ! -d "$$APP" ]; then echo "error: signed Chan.app not found at $$APP"; exit 1; fi; \
	    VERSION=$$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1); \
	    ARCH=$$(uname -m | sed 's/arm64/aarch64/'); \
	    DMG="$(BUNDLE_DIR)/dmg/Chan_$${VERSION}_$${ARCH}.dmg"; \
	    rm -f "$(BUNDLE_DIR)"/dmg/*.dmg; \
	    DMG_VENV="$(DMG_VENV)" DMGBUILD_SPEC="$(DMGBUILD_SPEC)" \
	        $(abspath $(CHAN_REPO))/packaging/desktop/build-dmg.sh "$$APP" "$$DMG" "Chan"; \
	    echo "codesigning $$DMG (Developer ID: $(APPLE_SIGNING_IDENTITY))"; \
	    codesign --force --timestamp --sign "$(APPLE_SIGNING_IDENTITY)" "$$DMG"; \
	    if [ "$(NOTARIZE_VIA)" = "keychain" ]; then \
	        echo "notarizing $$DMG (via Keychain profile '$(NOTARIZE_PROFILE)')"; \
	        xcrun notarytool submit "$$DMG" \
	            --keychain-profile "$(NOTARIZE_PROFILE)" --wait; \
	    else \
	        echo "notarizing $$DMG (via env vars)"; \
	        xcrun notarytool submit "$$DMG" \
	            --apple-id "$(APPLE_ID)" \
	            --password "$(APPLE_PASSWORD)" \
	            --team-id "$(APPLE_TEAM_ID)" --wait; \
	    fi; \
	    xcrun stapler staple "$$DMG"
	@echo ""
	@echo "notarized artifacts:"
	@ls -1 $(BUNDLE_DIR)/dmg/*.dmg 2>/dev/null || true
	@echo "verify: spctl -a -t open --context context:primary-signature -v \\"
	@echo "          $(BUNDLE_DIR)/macos/Chan.app"

# Local DMG layout proof (no certs, no notarization). Builds the .app + the
# Finder-less DMG so you can eyeball the layout; because dmgbuild is
# Finder-less, this local layout is identical to what CI produces. Use to
# verify the layout before a release cut.
dmg-layout-proof: tauri-cli web
	cd src-tauri && $(TAURI) build --bundles app --no-sign
	@set -e; \
	    APP="$(BUNDLE_DIR)/macos/Chan.app"; \
	    if [ ! -d "$$APP" ]; then echo "error: Chan.app not found at $$APP"; exit 1; fi; \
	    VERSION=$$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1); \
	    ARCH=$$(uname -m | sed 's/arm64/aarch64/'); \
	    DMG="$(BUNDLE_DIR)/dmg/Chan_$${VERSION}_$${ARCH}.dmg"; \
	    rm -f "$(BUNDLE_DIR)"/dmg/*.dmg; \
	    DMG_VENV="$(DMG_VENV)" DMGBUILD_SPEC="$(DMGBUILD_SPEC)" \
	        $(abspath $(CHAN_REPO))/packaging/desktop/build-dmg.sh "$$APP" "$$DMG" "Chan"; \
	    echo ""; \
	    echo "layout-proof DMG: $$DMG"; \
	    echo "inspect: hdiutil attach \"$$DMG\" && ls -la /Volumes/Chan"
