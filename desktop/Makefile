.PHONY: run build check fmt fmt-check lint test clean chan-bin tauri-cli \
        app-signed app-notarized sign-prereqs notarize-prereqs

# Monorepo root. Override via CHAN_REPO=/path on CI.
CHAN_REPO ?= ..
TARGET_TRIPLE := $(shell rustc -vV | sed -n 's/host: //p')
CHAN_BIN := src-tauri/binaries/chan-$(TARGET_TRIPLE)
TAURI_CLI_VERSION ?= ^2
TAURI_CLI_ROOT := $(abspath $(CHAN_REPO)/target/tauri-cli)
TAURI_CLI_BIN := $(TAURI_CLI_ROOT)/bin/cargo-tauri
TAURI := PATH="$(TAURI_CLI_ROOT)/bin:$$PATH" cargo tauri

# Keep local dev self-contained: CI installs tauri-cli globally, but a
# fresh workstation usually does not have the cargo subcommand yet.
tauri-cli:
	@if ! command -v cargo-tauri >/dev/null 2>&1 \
	    && [ ! -x "$(TAURI_CLI_BIN)" ]; then \
	    echo "installing tauri-cli $(TAURI_CLI_VERSION) under $(TAURI_CLI_ROOT)"; \
	    cargo install tauri-cli --locked --version "$(TAURI_CLI_VERSION)" \
	        --root "$(TAURI_CLI_ROOT)"; \
	fi

# Stage chan as the bundled helper binary for CLI-owned surfaces.
# Local drive serving is embedded in chan-desktop; this binary is
# still needed for registry mutations and other CLI paths until
# those APIs move into the desktop host. Rebuilds every invocation
# so in-progress chan edits flow into `make run` without a separate
# step; cargo's own incremental build keeps the cost small when
# nothing changed.
#
# `fullstack-b-21`: when an APPLE_SIGNING_IDENTITY is in the env,
# codesign chan with Developer ID + hardened runtime + secure
# timestamp BEFORE Tauri's bundler picks it up. Tauri's
# `bundle.macOS.files` copies the binary into the .app bundle
# verbatim without routing it through Tauri's signing pass, so
# Apple's notary rejected `-b-20`'s output for missing
# Developer-ID-signature / no-timestamp / no-runtime on the
# bundled chan. Signing here gets the file into the bundle
# already-correct; Tauri's later codesign on the .app itself
# preserves chan's existing signature when the identity matches.
# Skipped when APPLE_SIGNING_IDENTITY is empty (local dev /
# unsigned-build path); the signed targets (app-signed /
# app-notarized) gate on `sign-prereqs` which already enforces
# the identity is set.
chan-bin:
	$(MAKE) -C $(CHAN_REPO) web
	cd $(CHAN_REPO) && cargo build --release --bin chan
	mkdir -p src-tauri/binaries
	cp $(CHAN_REPO)/target/release/chan $(CHAN_BIN)
	@if [ -n "$$APPLE_SIGNING_IDENTITY" ]; then \
	    echo "codesign chan: --options=runtime --timestamp --sign $$APPLE_SIGNING_IDENTITY"; \
	    codesign --force --options=runtime --timestamp \
	        --sign "$$APPLE_SIGNING_IDENTITY" $(CHAN_BIN); \
	fi

run: tauri-cli chan-bin
	cd src-tauri && $(TAURI) dev

build: tauri-cli chan-bin
	cd src-tauri && $(TAURI) build

check:
	cd src-tauri && cargo check

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
# desktop/CLAUDE.md):
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
app-signed: sign-prereqs tauri-cli chan-bin
	cd src-tauri && $(TAURI) build --bundles app
	@echo ""
	@echo "signed .app: $(CHAN_REPO)/target/release/bundle/macos/Chan.app"
	@echo "verify: codesign -dv --verbose=2 $(CHAN_REPO)/target/release/bundle/macos/Chan.app"

# Sign + notarize + staple + bundle a .dmg.
#
# We split the build (Tauri) from the notarize (xcrun notarytool)
# because tauri-bundler 2.x only knows the APPLE_ID/PASSWORD/TEAM_ID
# auth shape; it does NOT consume notarytool Keychain profiles. To
# support `--keychain-profile <name>` for local dev (Apple's blessed
# mechanism) AND env-var for CI, we unset Tauri's notarize env vars
# during the build so tauri-bundler skips its own notarize step, then
# call `xcrun notarytool submit` ourselves with the appropriate flag
# set. CI behaviour is identical to the prior path (manual notarytool
# call uses the same credentials Tauri would have used).
app-notarized: sign-prereqs notarize-prereqs tauri-cli chan-bin
	cd src-tauri && env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
	    $(TAURI) build --bundles app,dmg
	@DMG=$$(ls -1 $(CHAN_REPO)/target/release/bundle/dmg/*.dmg | head -1); \
	    if [ -z "$$DMG" ]; then \
	        echo "error: no .dmg produced by cargo tauri build"; exit 1; \
	    fi; \
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
	    fi && \
	    xcrun stapler staple "$$DMG"
	@echo ""
	@echo "notarized artifacts:"
	@ls -1 $(CHAN_REPO)/target/release/bundle/dmg/*.dmg 2>/dev/null || true
	@echo "verify: spctl -a -t open --context context:primary-signature -v \\"
	@echo "          $(CHAN_REPO)/target/release/bundle/macos/Chan.app"
