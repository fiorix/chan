# FreeBSD package build details. Invoke through the root Makefile.

CHAN_REPO ?= ../..
CARGO ?= cargo
NPM ?= npm
TAR ?= tar
FREEBSD_TARGET ?= x86_64-unknown-freebsd
FREEBSD_SYSROOT ?=
FREEBSD_ABI_TARGET ?= $(FREEBSD_TARGET)15.0
FREEBSD_CARGO_FLAGS ?=
FREEBSD_CC ?= clang
FREEBSD_CXX ?= clang++
FREEBSD_AR ?= llvm-ar
FREEBSD_RANLIB ?= llvm-ranlib

ifeq ($(FREEBSD_TARGET),x86_64-unknown-freebsd)
FREEBSD_TARGET_ENV := x86_64_unknown_freebsd
FREEBSD_TARGET_ENV_UPPER := X86_64_UNKNOWN_FREEBSD
else ifeq ($(FREEBSD_TARGET),aarch64-unknown-freebsd)
FREEBSD_TARGET_ENV := aarch64_unknown_freebsd
FREEBSD_TARGET_ENV_UPPER := AARCH64_UNKNOWN_FREEBSD
endif

FREEBSD_SYSROOT_ABS := $(abspath $(FREEBSD_SYSROOT))
FREEBSD_CFLAGS := --target=$(FREEBSD_ABI_TARGET) --sysroot=$(FREEBSD_SYSROOT_ABS)
FREEBSD_RUSTFLAGS := -C target-feature=+crt-static \
	-C link-arg=--target=$(FREEBSD_ABI_TARGET) \
	-C link-arg=--sysroot=$(FREEBSD_SYSROOT_ABS) \
	-C link-arg=-fuse-ld=lld
TARBALL_NAME := chan-$(FREEBSD_TARGET).tar.gz
TARBALL_STAGE := $(CHAN_REPO)/target/package/chan-$(FREEBSD_TARGET)
TARBALL_PATH := $(CHAN_REPO)/target/release/$(TARBALL_NAME)

.PHONY: chan-tarball
chan-tarball:
	@case "$(FREEBSD_TARGET)" in \
		x86_64-unknown-freebsd|aarch64-unknown-freebsd) ;; \
		*) echo "error: unsupported FREEBSD_TARGET $(FREEBSD_TARGET)"; exit 1;; \
	esac
	@test -n "$(FREEBSD_SYSROOT)" || { \
		echo "error: FREEBSD_SYSROOT is required"; exit 1; \
	}
	@test -f "$(FREEBSD_SYSROOT_ABS)/usr/lib/crt1.o" \
		&& test -f "$(FREEBSD_SYSROOT_ABS)/usr/lib/libc.a" \
		|| { echo "error: FREEBSD_SYSROOT does not contain FreeBSD crt1.o and libc.a"; exit 1; }
	@command -v "$(FREEBSD_CC)" >/dev/null \
		&& command -v "$(FREEBSD_CXX)" >/dev/null \
		&& command -v "$(FREEBSD_AR)" >/dev/null \
		&& command -v "$(FREEBSD_RANLIB)" >/dev/null \
		|| { echo "error: FreeBSD cross-build requires clang, clang++, llvm-ar, and llvm-ranlib"; exit 1; }
	$(MAKE) -C "$(CHAN_REPO)" web
	cd "$(CHAN_REPO)" && \
		CARGO_TARGET_$(FREEBSD_TARGET_ENV_UPPER)_LINKER="$(FREEBSD_CC)" \
		CC_$(FREEBSD_TARGET_ENV)="$(FREEBSD_CC)" \
		CXX_$(FREEBSD_TARGET_ENV)="$(FREEBSD_CXX)" \
		AR_$(FREEBSD_TARGET_ENV)="$(FREEBSD_AR)" \
		RANLIB_$(FREEBSD_TARGET_ENV)="$(FREEBSD_RANLIB)" \
		CFLAGS_$(FREEBSD_TARGET_ENV)="$(FREEBSD_CFLAGS)" \
		CXXFLAGS_$(FREEBSD_TARGET_ENV)="$(FREEBSD_CFLAGS)" \
		BINDGEN_EXTRA_CLANG_ARGS_$(FREEBSD_TARGET_ENV)="$(FREEBSD_CFLAGS)" \
		RUSTFLAGS="$(FREEBSD_RUSTFLAGS)" \
		$(CARGO) build $(FREEBSD_CARGO_FLAGS) --release --target "$(FREEBSD_TARGET)" -p chan
	rm -rf "$(TARBALL_STAGE)"
	mkdir -p "$(TARBALL_STAGE)" "$(CHAN_REPO)/target/release"
	cp "$(CHAN_REPO)/target/$(FREEBSD_TARGET)/release/chan" "$(TARBALL_STAGE)/chan"
	cp "$(CHAN_REPO)/LICENSE" "$(TARBALL_STAGE)/LICENSE"
	cp "$(CHAN_REPO)/README.md" "$(TARBALL_STAGE)/README.md"
	$(TAR) -czf "$(TARBALL_PATH)" -C "$(TARBALL_STAGE)" .
	@echo "built $(TARBALL_PATH)"
