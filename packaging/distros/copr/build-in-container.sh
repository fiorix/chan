#!/usr/bin/env bash
# Rebuild, install, and smoke one RPM package in a CentOS sdme container.
#
# $OUT is a host bind and the only surface that outlives the container. Its
# caller hands it back to the host user, on failure as well as on success.

set -euo pipefail

PKG="${PKG:-}"
EL_RELEASE="${EL_RELEASE:-}"
OUT="${OUT:-/out}"
SRPM_DIR="${SRPM_DIR:-/srpm}"

case "$PKG" in
    chan|chan-desktop) ;;
    *) echo "error: PKG must be chan or chan-desktop" >&2; exit 1 ;;
esac
case "$EL_RELEASE" in
    9|10) ;;
    *) echo "error: EL_RELEASE must be 9 or 10" >&2; exit 1 ;;
esac
if [ "$EL_RELEASE" = 9 ] && [ "$PKG" = chan-desktop ]; then
    echo "error: chan-desktop is unsupported on EPEL Next 9" >&2
    exit 1
fi

srpm="$(find "$SRPM_DIR" -maxdepth 1 -type f -name "$PKG-[0-9]*.src.rpm" -printf '%T@ %p\n' \
    | sort -nr | sed -n '1s/^[^ ]* //p')"
[ -n "$srpm" ] || {
    echo "error: no $PKG SRPM found under $SRPM_DIR" >&2
    exit 1
}

echo ">> preparing CentOS Stream $EL_RELEASE repositories" >&2
dnf -y install dnf-plugins-core rpm-build shadow-utils
dnf config-manager --set-enabled crb
if [ "$EL_RELEASE" = 9 ]; then
    dnf -y install epel-release epel-next-release
fi

# COPR applies project external repositories with signature checking disabled.
# Keep the variables literal so DNF selects EPEL 9 or 10 for this rootfs.
{
    echo '[chan-copr-epel]'
    echo 'name=chan COPR external EPEL'
    echo 'baseurl=https://dl.fedoraproject.org/pub/epel/$releasever/Everything/$basearch/'
    echo 'enabled=1'
    echo 'gpgcheck=0'
    echo 'skip_if_unavailable=0'
} >/etc/yum.repos.d/chan-copr-epel.repo

dnf -y makecache
echo ">> resolving BuildRequires for $(basename "$srpm")" >&2
dnf -y builddep "$srpm"

id builder >/dev/null 2>&1 || useradd -m builder
if [ "$(id -u builder)" -eq 0 ]; then
    echo "error: COPR builder must be non-root" >&2
    exit 2
fi
install -d -o builder -g builder /home/builder/rpmbuild
# Only root writes into $OUT, and it is a host bind: chowning it to the guest's
# builder uid would lock the host user out of its own results directory.
mkdir -p "$OUT"

echo ">> rebuilding $(basename "$srpm") as builder with Cargo offline" >&2
cargo_jobs_env=()
[ -z "${CARGO_BUILD_JOBS:-}" ] || cargo_jobs_env=("CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS")
runuser -u builder -- env HOME=/home/builder CARGO_NET_OFFLINE=true \
    "${cargo_jobs_env[@]}" \
    rpmbuild --rebuild "$srpm" --define '_topdir /home/builder/rpmbuild'

rpm_path="$(find /home/builder/rpmbuild/RPMS -type f -name "$PKG-[0-9]*.rpm" \
    | sort | sed -n '1p')"
[ -n "$rpm_path" ] || {
    echo "error: rpmbuild produced no $PKG binary RPM" >&2
    exit 1
}
install -m 0644 "$rpm_path" "$OUT/"
rpm_path="$OUT/$(basename "$rpm_path")"

rpm_name="$(rpm -qp --qf '%{NAME}' "$rpm_path")"
rpm_release="$(rpm -qp --qf '%{RELEASE}' "$rpm_path")"
rpm_arch="$(rpm -qp --qf '%{ARCH}' "$rpm_path")"
[ "$rpm_name" = "$PKG" ] || {
    echo "error: expected package $PKG, got $rpm_name" >&2
    exit 1
}
case "$rpm_release" in
    *".el${EL_RELEASE}"*) ;;
    *) echo "error: RPM release '$rpm_release' lacks .el${EL_RELEASE}" >&2; exit 1 ;;
esac
case "$(uname -m):$rpm_arch" in
    x86_64:x86_64|aarch64:aarch64) ;;
    *) echo "error: container architecture $(uname -m) produced RPM architecture $rpm_arch" >&2; exit 1 ;;
esac

echo ">> installing $(basename "$rpm_path")" >&2
dnf -y install "$rpm_path"
chan --version
cs --help >/dev/null
systemd-analyze verify /usr/lib/systemd/user/chan-devserver.service

if [ "$PKG" = chan-desktop ]; then
    # The desktop personality delegates `chan upgrade` to a running GUI, so a
    # headless container cannot exercise that path. Prove the rpm build marker
    # reached the binary instead; the standalone CLI assertion below covers
    # the executable package-manager refusal path.
    grep -aFq 'sudo dnf upgrade' /usr/bin/chan-desktop
    desktop-file-validate /usr/share/applications/chan-desktop.desktop
    ldd_output="$(ldd /usr/bin/chan-desktop)"
    if grep -q 'not found' <<<"$ldd_output"; then
        echo "error: chan-desktop has unresolved shared libraries" >&2
        echo "$ldd_output" >&2
        exit 1
    fi
    rpm -q --conflicts chan-desktop | grep -qx chan
    for size in 32x32 64x64 128x128 256x256 512x512; do
        test -f "/usr/share/icons/hicolor/$size/apps/chan-desktop.png"
    done
else
    if chan upgrade >"$OUT/upgrade.out" 2>&1; then
        echo "error: packaged chan upgrade unexpectedly succeeded" >&2
        exit 1
    fi
    grep -q 'dnf upgrade' "$OUT/upgrade.out"
fi

echo ">> validated $rpm_name-$rpm_release.$rpm_arch" >&2
