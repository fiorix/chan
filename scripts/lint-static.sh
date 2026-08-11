#!/usr/bin/env bash
# lint-static.sh -- shellcheck over the repo's tracked shell scripts, and
# actionlint over .github/workflows (with shellcheck wired in, so the shell
# inside workflow `run:` blocks is linted by the same rules as a .sh file).
#
# Neither tool is a build dependency of chan, and neither is installable
# without root on every machine that runs the gate, so both are fetched at a
# pinned version into a user cache. Acquisition failure is fatal: a linter
# that silently skips when its tool is missing gates nothing.
#
# The severity and the exclude list live in .shellcheckrc at the repo root
# rather than here, so an editor integration reports what the gate enforces.
#
# Usage:
#   scripts/lint-static.sh              # both passes
#   scripts/lint-static.sh shell        # shellcheck only
#   scripts/lint-static.sh workflows    # actionlint only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The cache sits in the user cache directory, not under target/. The gate
# discipline wipes target/ (a fresh acceptance gate is `rm -rf target`, rounds
# run `cargo clean`) and every isolated gate worktree has its own, so a cache
# there would mean a fresh download per gate. Here one download serves every
# worktree on the machine, and only a cold cache needs network.
TOOLS="${CHAN_LINT_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/chan/lint-tools}"

# Pinned so the gate reports the same findings everywhere. Bumping a version
# means replacing the pinned checksums with the new release's, and can surface
# new findings; fix or exclude them in the same commit.
SHELLCHECK_VERSION="0.11.0"
ACTIONLINT_VERSION="1.7.12"

SHELLCHECK="$TOOLS/shellcheck-$SHELLCHECK_VERSION/shellcheck"
ACTIONLINT="$TOOLS/actionlint-$ACTIONLINT_VERSION/actionlint"

die() {
    echo "lint-static: $*" >&2
    exit 1
}

# Canonical os/arch for the release-asset names. actionlint spells the
# architectures amd64/arm64 and is mapped at its download site.
host_os() {
    case "$(uname -s)" in
        Linux) echo linux ;;
        Darwin) echo darwin ;;
        *) die "no release binaries for $(uname -s)" ;;
    esac
}

host_arch() {
    case "$(uname -m)" in
        x86_64 | amd64) echo x86_64 ;;
        aarch64 | arm64) echo aarch64 ;;
        *) die "no release binaries for $(uname -m)" ;;
    esac
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print tolower($1)}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print tolower($1)}'
    else
        die "need sha256sum or shasum on PATH to verify downloads"
    fi
}

# A cached binary that does not report the pinned version (a stale cache, a
# truncated download) is re-fetched rather than trusted, so the probe must not
# be fatal on its own.
shellcheck_reported_version() {
    "$SHELLCHECK" --version 2>/dev/null | sed -n 's/^version: //p' || true
}

actionlint_reported_version() {
    "$ACTIONLINT" -version 2>/dev/null | head -1 || true
}

# The shellcheck project publishes no checksum list alongside its releases, so
# the digest of each release asset is pinned here. A literal digest in the
# repo is a stronger check than a checksum file fetched from the same host as
# the artifact, because it also fails when the release asset itself is
# replaced. (A comment cannot open with the tool's name on its own: shellcheck
# reads `# shellcheck ...` at the start of a line as a directive.)
shellcheck_sha256() {
    case "$1" in
        linux.x86_64) echo "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198" ;;
        linux.aarch64) echo "12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588" ;;
        darwin.x86_64) echo "3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6" ;;
        darwin.aarch64) echo "56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79" ;;
        *) die "no pinned shellcheck $SHELLCHECK_VERSION checksum for $1" ;;
    esac
}

ensure_shellcheck() {
    local platform tarball base dir tmp want got
    if [ ! -x "$SHELLCHECK" ] || [ "$(shellcheck_reported_version)" != "$SHELLCHECK_VERSION" ]; then
        command -v curl >/dev/null 2>&1 \
            || die "curl is required to fetch shellcheck $SHELLCHECK_VERSION"
        platform="$(host_os).$(host_arch)"
        want="$(shellcheck_sha256 "$platform")"
        tarball="shellcheck-v$SHELLCHECK_VERSION.$platform.tar.xz"
        base="https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_VERSION"
        dir="$TOOLS/shellcheck-$SHELLCHECK_VERSION"
        tmp="$dir.tmp"
        echo "==> fetching shellcheck $SHELLCHECK_VERSION into $TOOLS" >&2
        rm -rf "$dir" "$tmp"
        mkdir -p "$tmp"
        curl -fsSL -o "$tmp/$tarball" "$base/$tarball" \
            || die "downloading $base/$tarball failed (a cold cache needs network)"
        # Verify before unpacking so a truncated or swapped download fails
        # here with a clear message rather than as a mid-lint exec error.
        got="$(sha256_file "$tmp/$tarball")"
        [ "$want" = "$got" ] || die "checksum mismatch for $tarball (want $want, got $got)"
        tar -xJf "$tmp/$tarball" -C "$tmp" --strip-components=1 \
            "shellcheck-v$SHELLCHECK_VERSION/shellcheck" \
            || die "unpacking $tarball failed (needs a tar with xz support)"
        mv "$tmp" "$dir"
    fi
    got="$(shellcheck_reported_version)"
    [ "$got" = "$SHELLCHECK_VERSION" ] \
        || die "$SHELLCHECK reports version '$got', expected $SHELLCHECK_VERSION"
}

ensure_actionlint() {
    local arch tarball base dir tmp want got
    if [ ! -x "$ACTIONLINT" ] || [ "$(actionlint_reported_version)" != "$ACTIONLINT_VERSION" ]; then
        command -v curl >/dev/null 2>&1 \
            || die "curl is required to fetch actionlint $ACTIONLINT_VERSION"
        case "$(host_arch)" in
            x86_64) arch="amd64" ;;
            *) arch="arm64" ;;
        esac
        tarball="actionlint_${ACTIONLINT_VERSION}_$(host_os)_${arch}.tar.gz"
        base="https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION"
        dir="$TOOLS/actionlint-$ACTIONLINT_VERSION"
        tmp="$dir.tmp"
        echo "==> fetching actionlint $ACTIONLINT_VERSION into $TOOLS" >&2
        rm -rf "$dir" "$tmp"
        mkdir -p "$tmp"
        curl -fsSL -o "$tmp/$tarball" "$base/$tarball" \
            || die "downloading $base/$tarball failed (a cold cache needs network)"
        curl -fsSL -o "$tmp/checksums.txt" \
            "$base/actionlint_${ACTIONLINT_VERSION}_checksums.txt" \
            || die "downloading the actionlint checksum list failed"
        # Verify before unpacking so a truncated or swapped download fails
        # here with a clear message rather than as a mid-lint exec error.
        want="$(awk -v f="$tarball" '$2 == f { print $1 }' "$tmp/checksums.txt")"
        [ -n "$want" ] || die "$tarball is absent from the actionlint checksum list"
        got="$(sha256_file "$tmp/$tarball")"
        [ "$want" = "$got" ] || die "checksum mismatch for $tarball (want $want, got $got)"
        tar -xzf "$tmp/$tarball" -C "$tmp" actionlint \
            || die "unpacking $tarball failed"
        mv "$tmp" "$dir"
    fi
    got="$(actionlint_reported_version)"
    [ "$got" = "$ACTIONLINT_VERSION" ] \
        || die "$ACTIONLINT reports version '$got', expected $ACTIONLINT_VERSION"
}

# Tracked shell sources: every *.sh, plus the extension-less executables (git
# hooks, packaging helpers, deb maintainer scripts) whose shebang names a
# shell, which keeps python/node/make scripts out of the list.
shell_sources() {
    {
        git -C "$REPO" ls-files -- '*.sh' '*.bash'
        local f first
        while IFS= read -r f; do
            case "$f" in
                *.sh | *.bash) continue ;;
            esac
            first="$(head -n 1 "$REPO/$f" 2>/dev/null || true)"
            case "$first" in
                '#!'*bash*) printf '%s\n' "$f" ;;
                '#!'*/sh | '#!'*/sh\ * | '#!'*' sh' | '#!'*' sh '*) printf '%s\n' "$f" ;;
            esac
        done < <(git -C "$REPO" ls-files -s \
            | awk '$1 == "100755" { print substr($0, index($0, "\t") + 1) }')
    } | sort -u
}

run_shell() {
    ensure_shellcheck
    local files=() f
    while IFS= read -r f; do
        files+=("$f")
    done < <(shell_sources)
    [ "${#files[@]}" -gt 0 ] || die "found no tracked shell scripts to check"
    echo "==> shellcheck: ${#files[@]} tracked shell scripts" >&2
    (cd "$REPO" && "$SHELLCHECK" "${files[@]}")
    "$REPO/scripts/check-sdme-storage.py"
}

# actionlint invokes shellcheck with --norc, so .shellcheckrc has to be
# replayed as flags through SHELLCHECK_OPTS or a workflow `run:` block would
# be held to different rules than a .sh file. Every rc directive that has a
# command-line equivalent is mapped here, and anything else is fatal: a
# directive dropped silently makes the workflow pass quietly weaker than the
# .sh pass, which is the failure this target exists to prevent.
shellcheck_opts_from_rc() {
    local line key value opts="" has_severity="" has_enable=""
    while IFS= read -r line || [ -n "$line" ]; do
        # A directive may carry a trailing comment (`disable=SC2016 # why` is
        # what shellcheck itself accepts), so strip that before splitting.
        line="${line%%#*}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [ -n "$line" ] || continue
        case "$line" in
            *=*) ;;
            *) die ".shellcheckrc line '$line' is not a key=value directive" ;;
        esac
        key="${line%%=*}"
        value="${line#*=}"
        case "$key" in
            severity)
                has_severity=1
                opts="$opts --severity=$value"
                ;;
            disable) opts="$opts --exclude=$value" ;;
            enable)
                has_enable=1
                opts="$opts --enable=$value"
                ;;
            shell) opts="$opts --shell=$value" ;;
            source-path) opts="$opts --source-path=$value" ;;
            extended-analysis) opts="$opts --extended-analysis=$value" ;;
            external-sources)
                [ "$value" != "true" ] || opts="$opts --external-sources"
                ;;
            source)
                # An rc file may set `source=`, but no flag carries it, so it
                # cannot reach actionlint's --norc pass.
                die ".shellcheckrc sets source=$value, which has no" \
                    "command-line form and so cannot be replayed into" \
                    "actionlint's --norc shellcheck; put a" \
                    "\`# shellcheck source=\` comment at the dot site instead"
                ;;
            *)
                die ".shellcheckrc directive '$key' has no flag mapping in" \
                    "scripts/lint-static.sh; add one so workflow run: blocks" \
                    "stay held to the same rules as a .sh file"
                ;;
        esac
    done < "$REPO/.shellcheckrc"
    # The two forms disagree here: a `severity` line in an rc file does not
    # filter out the optional checks an `enable` line turned on, but the
    # `--severity` command-line flag does. So these two directives
    # together cannot be replayed faithfully, and `--norc` beats `--rcfile`,
    # which rules out handing actionlint the rc file instead. Refuse rather
    # than quietly hold workflow `run:` blocks to a weaker rule set.
    if [ -n "$has_severity" ] && [ -n "$has_enable" ]; then
        die ".shellcheckrc sets both severity= and enable=, which cannot be" \
            "replayed into actionlint's --norc shellcheck faithfully;" \
            "drop one, or move the optional check to a per-site directive"
    fi
    printf '%s' "${opts# }"
}

run_workflows() {
    # actionlint shells out to shellcheck for the `run:` blocks, so the
    # workflow pass needs both tools.
    ensure_shellcheck
    ensure_actionlint
    local opts
    opts="$(shellcheck_opts_from_rc)"
    echo "==> actionlint: .github/workflows" >&2
    # No file arguments: actionlint discovers every workflow under the repo
    # root itself, which covers .yaml as well as .yml. GitHub Actions accepts
    # both spellings, so a glob here would silently skip one of them.
    (cd "$REPO" && SHELLCHECK_OPTS="$opts" "$ACTIONLINT" -no-color \
        -shellcheck "$SHELLCHECK")
}

case "${1:-all}" in
    all)
        run_shell
        run_workflows
        ;;
    shell) run_shell ;;
    workflows) run_workflows ;;
    *) die "usage: lint-static.sh [all|shell|workflows]" ;;
esac
