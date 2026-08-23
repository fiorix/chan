# FreeBSD package build details. Invoke through the root Makefile.

CHAN_REPO ?= ../..
CARGO ?= cargo
NPM ?= npm
TAR ?= tar
FREEBSD_TARGET ?= x86_64-unknown-freebsd
FREEBSD_SYSROOT ?=
FREEBSD_ABI_TARGET ?= x86_64-unknown-freebsd15.0
FREEBSD_CC ?= clang
FREEBSD_CXX ?= clang++
FREEBSD_AR ?= llvm-ar
FREEBSD_RANLIB ?= llvm-ranlib

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
	@case "$(FREEBSD_TARGET)" in x86_64-unknown-freebsd) ;; \
		*) echo "error: FREEBSD_TARGET must be x86_64-unknown-freebsd, got $(FREEBSD_TARGET)"; exit 1;; \
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
		CARGO_TARGET_X86_64_UNKNOWN_FREEBSD_LINKER="$(FREEBSD_CC)" \
		CC_x86_64_unknown_freebsd="$(FREEBSD_CC)" \
		CXX_x86_64_unknown_freebsd="$(FREEBSD_CXX)" \
		AR_x86_64_unknown_freebsd="$(FREEBSD_AR)" \
		RANLIB_x86_64_unknown_freebsd="$(FREEBSD_RANLIB)" \
		CFLAGS_x86_64_unknown_freebsd="$(FREEBSD_CFLAGS)" \
		CXXFLAGS_x86_64_unknown_freebsd="$(FREEBSD_CFLAGS)" \
		BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_freebsd="$(FREEBSD_CFLAGS)" \
		RUSTFLAGS="$(FREEBSD_RUSTFLAGS)" \
		$(CARGO) build --release --target "$(FREEBSD_TARGET)" -p chan
	rm -rf "$(TARBALL_STAGE)"
	mkdir -p "$(TARBALL_STAGE)" "$(CHAN_REPO)/target/release"
	cp "$(CHAN_REPO)/target/$(FREEBSD_TARGET)/release/chan" "$(TARBALL_STAGE)/chan"
	cp "$(CHAN_REPO)/LICENSE" "$(TARBALL_STAGE)/LICENSE"
	cp "$(CHAN_REPO)/README.md" "$(TARBALL_STAGE)/README.md"
	$(TAR) -czf "$(TARBALL_PATH)" -C "$(TARBALL_STAGE)" .
	@echo "built $(TARBALL_PATH)"
