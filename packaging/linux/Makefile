# Linux package build details. Invoke through the root Makefile.

CHAN_REPO ?= ../..
CARGO ?= cargo
NPM ?= npm
TAR ?= tar
LINUX_TARGET ?= x86_64-unknown-linux-gnu
DEB_TARGET ?= $(LINUX_TARGET)
RPM_TARGET ?= $(LINUX_TARGET)
ARCHPKG_TARGET ?= $(LINUX_TARGET)
# Compound root targets set this only after building the exact current web
# sources. Direct package entry points retain their self-contained default.
WEB_ALREADY_BUILT ?= 0

# chan-desktop Linux build. Distinct from the CLI deb/rpm/archpkg targets
# above: those cross-compile the `chan` CLI on the host and package the binary,
# whereas chan-desktop runs `cargo tauri build` (which bundles the AppImage)
# inside an sdme container so a macOS host can produce Linux desktop bundles.
DISTRO ?= ubuntu
SDME ?= limactl shell default sudo sdme

CHAN_VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' "$(CHAN_REPO)/Cargo.toml" | head -1)
TARBALL_NAME ?= chan-$(LINUX_TARGET).tar.gz
TARBALL_STAGE := $(CHAN_REPO)/target/package/chan-$(LINUX_TARGET)
TARBALL_PATH := $(CHAN_REPO)/target/release/$(TARBALL_NAME)
ARCHPKG_DIR := $(CHAN_REPO)/target/archpkg/chan

ifneq ($(filter x86_64-%,$(ARCHPKG_TARGET)),)
ARCHPKG_ARCH := x86_64
else ifneq ($(filter aarch64-%,$(ARCHPKG_TARGET)),)
ARCHPKG_ARCH := aarch64
else
ARCHPKG_ARCH := unsupported
endif

# The standalone tarball is the only musl artifact (it is the install.sh /
# self-upgrade download, so a too-new build glibc must not gate older machines).
# musl needs cargo-zigbuild (zig as the cross C/C++ compiler) so the C/C++ deps
# (ring, bundled SQLite, tokenizers esaxx-rs/onig) link fully static; gnu uses
# plain cargo build. The .deb/.rpm targets stay gnu (the distro provides glibc).
ifneq ($(filter %-unknown-linux-musl,$(LINUX_TARGET)),)
TARBALL_BUILD := $(CARGO) zigbuild
else
TARBALL_BUILD := $(CARGO) build
endif

.PHONY: chan-tarball
chan-tarball:
	@case "$(LINUX_TARGET)" in *-unknown-linux-gnu|*-unknown-linux-musl) ;; \
		*) echo "error: LINUX_TARGET must be a gnu or musl Linux target, got $(LINUX_TARGET)"; exit 1;; \
	esac
	$(MAKE) -C "$(CHAN_REPO)" web
	cd "$(CHAN_REPO)" && $(TARBALL_BUILD) --release --target "$(LINUX_TARGET)" -p chan
	rm -rf "$(TARBALL_STAGE)"
	mkdir -p "$(TARBALL_STAGE)" "$(CHAN_REPO)/target/release"
	cp "$(CHAN_REPO)/target/$(LINUX_TARGET)/release/chan" "$(TARBALL_STAGE)/chan"
	cp "$(CHAN_REPO)/LICENSE" "$(TARBALL_STAGE)/LICENSE"
	cp "$(CHAN_REPO)/README.md" "$(TARBALL_STAGE)/README.md"
	$(TAR) -czf "$(TARBALL_PATH)" -C "$(TARBALL_STAGE)" .
	@echo "built $(TARBALL_PATH)"

# The .deb/.rpm below are the release downloads: release.yml runs these targets
# and stages their output as GitHub release assets. They deliberately carry no
# CHAN_PACKAGED marker, unlike the distro source packages under
# packaging/distros/: no apt or dnf repository serves a hand-installed asset, so
# `sudo apt upgrade` would never update one and `chan upgrade` stays its update
# path.
.PHONY: deb
deb:
	@case "$(DEB_TARGET)" in *-unknown-linux-gnu) ;; \
		*) echo "error: DEB_TARGET must be a gnu Linux target, got $(DEB_TARGET)"; exit 1;; \
	esac
	@if [ "$(WEB_ALREADY_BUILT)" != 1 ]; then \
		$(MAKE) -C "$(CHAN_REPO)" web; \
	fi
	cd "$(CHAN_REPO)" && $(CARGO) build --release --target "$(DEB_TARGET)" -p chan
	cd "$(CHAN_REPO)" && $(CARGO) deb --no-build --no-strip --target "$(DEB_TARGET)" -p chan
	@ls -1 "$(CHAN_REPO)/target/$(DEB_TARGET)/debian/"*.deb

.PHONY: rpm
rpm:
	@case "$(RPM_TARGET)" in *-unknown-linux-gnu) ;; \
		*) echo "error: RPM_TARGET must be a gnu Linux target, got $(RPM_TARGET)"; exit 1;; \
	esac
	@if [ "$(WEB_ALREADY_BUILT)" != 1 ]; then \
		$(MAKE) -C "$(CHAN_REPO)" web; \
	fi
	cd "$(CHAN_REPO)" && $(CARGO) build --release --target "$(RPM_TARGET)" -p chan
	mkdir -p "$(CHAN_REPO)/target/release"
	cp "$(CHAN_REPO)/target/$(RPM_TARGET)/release/chan" "$(CHAN_REPO)/target/release/chan"
	# cargo-generate-rpm writes output under the CWD's target dir, which here is
	# crates/chan/ (we cd there because rpm asset `source` paths resolve relative
	# to the package dir, unlike cargo-deb). --target-dir forces output into the
	# workspace target/ so it lands beside the .deb, where the release workflow's
	# `find target` staging step looks. Asset resolution is unaffected.
	# RPM version grammar forbids '-' (it separates version from release), so a
	# semver prerelease (0.50.0-rc1) is translated to RPM's '~' form (0.50.0~rc1),
	# which also sorts before the final release. The semver version is unchanged
	# everywhere else; a final release carries no '-' and is unaffected.
	cd "$(CHAN_REPO)/crates/chan" && $(CARGO) generate-rpm --target "$(RPM_TARGET)" --target-dir "$(CHAN_REPO)/target" --set-metadata 'version = "$(subst -,~,$(CHAN_VERSION))"'
	@file=$$(find "$(CHAN_REPO)/target" -path '*/generate-rpm/*.rpm' -type f | head -1); \
		if [ -z "$$file" ]; then \
			echo "error: no .rpm under $(CHAN_REPO)/target"; \
			exit 1; \
		fi; \
		echo "built $$file"

.PHONY: archpkg
archpkg:
	@case "$(ARCHPKG_TARGET)" in x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu) ;; \
		*) echo "error: ARCHPKG_TARGET must be x86_64-unknown-linux-gnu or aarch64-unknown-linux-gnu, got $(ARCHPKG_TARGET)"; exit 1;; \
	esac
	@if [ "$(ARCHPKG_ARCH)" = "unsupported" ]; then \
		echo "error: ARCHPKG_TARGET must start with x86_64- or aarch64-, got $(ARCHPKG_TARGET)"; \
		exit 1; \
	fi
	@command -v makepkg >/dev/null 2>&1 || { \
		echo "error: makepkg not found; run linux-archpkg inside an Arch sdme rootfs"; \
		exit 1; \
	}
	$(MAKE) -C "$(CHAN_REPO)" web
	# A hand-built pacman package from the working tree, not an AUR install:
	# the marker hands update ownership to the package manager without naming
	# an AUR helper the user never used.
	cd "$(CHAN_REPO)" && CHAN_PACKAGED=pacman $(CARGO) build --release --target "$(ARCHPKG_TARGET)" -p chan
	rm -rf "$(ARCHPKG_DIR)"
	mkdir -p "$(ARCHPKG_DIR)"
	cp "$(CURDIR)/arch/PKGBUILD" "$(ARCHPKG_DIR)/PKGBUILD"
	cd "$(ARCHPKG_DIR)" && \
		CHAN_REPO="$(CHAN_REPO)" \
		ARCHPKG_TARGET="$(ARCHPKG_TARGET)" \
		CHAN_PKG_VERSION="$(CHAN_VERSION)" \
		CHAN_ARCH="$(ARCHPKG_ARCH)" \
		makepkg --force --nodeps --clean
	@ls -1 "$(ARCHPKG_DIR)/"*.pkg.tar.*

.PHONY: chan-desktop
chan-desktop:
	CHAN_REPO="$(abspath $(CHAN_REPO))" SDME="$(SDME)" DISTRO="$(DISTRO)" \
		"$(abspath $(CHAN_REPO))/packaging/sdme/build-chan-desktop.sh"

.PHONY: packages
packages: deb rpm archpkg
