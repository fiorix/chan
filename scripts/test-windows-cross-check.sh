#!/usr/bin/env bash
# Exercise the real Windows cross-check driver without creating a container.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"

cleanup() {
    local args arg snapshot
    for args in "$TMP"/*/new.args; do
        [ -f "$args" ] || continue
        while IFS= read -r -d '' arg; do
            case "$arg" in
                /var/tmp/chan-windows-source.*:/source:ro)
                    snapshot="${arg%:/source:ro}"
                    if [[ $snapshot =~ ^/var/tmp/chan-windows-source\.[A-Za-z0-9]{6}$ ]]; then
                        rm -rf -- "$snapshot"
                    fi
                    ;;
            esac
        done <"$args"
    done
    rm -rf -- "$TMP"
}
trap cleanup EXIT

FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/packaging"
cp "$REPO/scripts/windows-cross-check.sh" "$FIXTURE/scripts/"
cp "$REPO/packaging/snapshot-tracked-tree.sh" "$REPO/packaging/sdme-build-policy.sh" \
    "$FIXTURE/packaging/"
printf '[workspace]\nmembers = []\n' >"$FIXTURE/Cargo.toml"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" add Cargo.toml scripts packaging
git -C "$FIXTURE" -c user.name=Fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false commit -q -m fixture

FAKE_SDME="$TMP/fake-sdme"
cat >"$FAKE_SDME" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
    fs)
        [ "$2" = ls ] || exit 91
        printf 'fixture-ubuntu imported\n'
        ;;
    new)
        printf '%s\0' "$@" >"$FAKE_DIR/new.args"
        status_dir=
        status_name=
        for arg in "$@"; do
            case "$arg" in
                *:/status) status_dir="${arg%:/status}" ;;
                STATUS_FILE=/status/*) status_name="${arg##*/}" ;;
            esac
        done
        [ -n "$status_dir" ] && [ -n "$status_name" ] || exit 92
        case "$FAKE_MODE" in
            success|cleanup_fail) printf '0\n' >"$status_dir/$status_name" ;;
            cargo) printf '101\n' >"$status_dir/$status_name" ;;
            malformed_text) printf 'not-a-status\n' >"$status_dir/$status_name" ;;
            malformed_256) printf '256\n' >"$status_dir/$status_name" ;;
            timeout) exit 124 ;;
            transport|transport_absent|transport_cleanup_fail) exit 37 ;;
            missing) ;;
            *) exit 93 ;;
        esac
        ;;
    ps)
        [ "$2" = --json ] || exit 95
        if [ "$FAKE_MODE" = transport_absent ]; then
            printf '[]\n'
        else
            previous=
            while IFS= read -r -d '' arg; do
                if [ "$previous" = --name ]; then
                    printf '[{"name":"%s"}]\n' "$arg"
                    break
                fi
                previous="$arg"
            done <"$FAKE_DIR/new.args"
        fi
        ;;
    rm)
        printf '%s\0' "$@" >"$FAKE_DIR/rm.args"
        if [ "$FAKE_MODE" = cleanup_fail ] || [ "$FAKE_MODE" = transport_cleanup_fail ]; then
            echo 'simulated removal refusal' >&2
            exit 17
        fi
        ;;
    *) exit 94 ;;
esac
FAKE
chmod +x "$FAKE_SDME"

run_case() {
    local label="$1" mode="$2" expected="$3" rc
    shift 3
    mkdir -p "$TMP/$label"
    if env -u WINDOWS_CROSS_CPUS -u WINDOWS_CROSS_MEMORY -u WINDOWS_CROSS_JOBS \
        -u WINDOWS_CROSS_TIMEOUT -u SDME_BUILD_DISK \
        FAKE_DIR="$TMP/$label" FAKE_MODE="$mode" SDME="$FAKE_SDME" \
        SDME_BUILD_DISK=13G WINDOWS_CROSS_ROOTFS=fixture-ubuntu \
        CARGO_TARGET_DIR="$TMP/$label/status" \
        "$@" "$FIXTURE/scripts/windows-cross-check.sh" \
        >"$TMP/$label/log" 2>&1; then
        rc=0
    else
        rc=$?
    fi
    if [ "$rc" -ne "$expected" ]; then
        echo "FAIL: $label returned $rc, expected $expected" >&2
        cat "$TMP/$label/log" >&2
        exit 1
    fi
}

run_case success success 0
run_case override success 0 WINDOWS_CROSS_CPUS=3 WINDOWS_CROSS_MEMORY=5G \
    WINDOWS_CROSS_JOBS=4 WINDOWS_CROSS_TIMEOUT=900
run_case cargo cargo 101
run_case timeout timeout 124
run_case transport transport 37
run_case transport_absent transport_absent 37
run_case transport_cleanup_fail transport_cleanup_fail 37
run_case missing missing 1
run_case malformed_text malformed_text 1
run_case malformed_256 malformed_256 1
run_case cleanup_fail cleanup_fail 1

python3 - "$TMP" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
for label in ("success", "override", "cargo", "timeout", "transport", "transport_absent", "transport_cleanup_fail", "missing", "malformed_text", "malformed_256", "cleanup_fail"):
    folder = root / label
    args = [part.decode() for part in (folder / "new.args").read_bytes().split(b"\0") if part]
    rm_args = folder / "rm.args"
    removed = [part.decode() for part in rm_args.read_bytes().split(b"\0") if part] if rm_args.exists() else []
    def value(flag: str) -> str:
        return args[args.index(flag) + 1]
    name = value("--name")
    assert re.fullmatch(r"chan-windows-cross-check-[A-Za-z0-9]{6}", name), (label, name)
    assert removed == ([] if label == "transport_absent" else ["rm", "-f", name]), (label, removed)
    assert value("-r") == "fixture-ubuntu"
    assert value("--storage") == "btrfs"
    assert value("--disk") == "13G"
    assert value("--cpus") == ("3" if label == "override" else "2")
    assert value("--memory") == ("5G" if label == "override" else "6G")
    binds = [args[index + 1] for index, arg in enumerate(args[:-1]) if arg == "-b"]
    assert len(binds) == 2, (label, binds)
    assert any(re.fullmatch(r"/var/tmp/chan-windows-source\.[A-Za-z0-9]{6}:/source:ro", item) for item in binds), binds
    assert str(folder / "status") + ":/status" in binds, binds
    assert all("/gen:" not in item and "/cargo-target" not in item for item in binds), binds
    guest = args[args.index("--") + 1:]
    assert guest[0] == "/usr/bin/env"
    assert "STATUS_FILE=/status/" in " ".join(guest)
    assert guest.count("/usr/bin/timeout") == 1
    assert ("900s" if label == "override" else "7200s") in guest
    assert guest[guest.index("-k") + 1] == "30s"
    root_script = guest[guest.index("-c") + 1]
    build_script = guest[-1]
    assert "apt-get update" in root_script and "util-linux" in root_script
    assert "runuser -u ubuntu -- /usr/bin/env" in root_script
    assert "CARGO_TARGET_DIR=/home/ubuntu/target/windows-cross" in root_script
    assert 'CARGO_BUILD_JOBS="$WINDOWS_CROSS_JOBS"' in root_script
    assert 'RUST_TEST_THREADS="$WINDOWS_CROSS_JOBS"' in root_script
    assert 'RAYON_NUM_THREADS="$WINDOWS_CROSS_JOBS"' in root_script
    assert "cp -a --no-preserve=ownership /source/. /home/ubuntu/chan/" in build_script
    assert "cd /home/ubuntu/chan" in build_script
    for command in (
        "cargo check --release -p chan --target x86_64-pc-windows-gnu",
        "cargo test --release -p chan-library -p chan-server",
        "cargo test --release -p chan-desktop --all-targets",
    ):
        assert command in build_script, (label, command)
    assert build_script.count('RUSTFLAGS="-D warnings"') == 3
    snapshot = Path(next(item.split(":/source:ro")[0] for item in binds if item.endswith(":/source:ro")))
    assert snapshot.exists() == (label in ("cleanup_fail", "transport_cleanup_fail")), (label, snapshot)
    log = (folder / "log").read_text()
    expected_diagnostic = {
        "cargo": "build failed with status 101",
        "timeout": "guest command returned 124 (timeout bound 7200s)",
        "transport": "new' failed with status 37",
        "transport_absent": "guest 'chan-windows-cross-check-",
        "transport_cleanup_fail": "failed to remove Windows cross-check guest",
        "missing": "wrote no status",
        "malformed_text": "invalid status",
        "malformed_256": "invalid status",
        "cleanup_fail": "failed to remove Windows cross-check guest",
    }.get(label)
    if expected_diagnostic:
        assert expected_diagnostic in log, (label, log)
    if label == "cleanup_fail":
        assert "preserving snapshot and status" in log
        assert list((folder / "status").glob(".windows-cross-check-status-*"))
    elif label == "transport_cleanup_fail":
        assert "preserving snapshot and status" in log
        assert not list((folder / "status").glob(".windows-cross-check-status-*"))
    else:
        assert not list((folder / "status").glob(".windows-cross-check-status-*")), label
PY

run_case invalid_cpus success 2 WINDOWS_CROSS_CPUS=0
run_case invalid_memory success 2 WINDOWS_CROSS_MEMORY=0G
run_case invalid_jobs success 2 WINDOWS_CROSS_JOBS=-1
run_case invalid_timeout success 2 WINDOWS_CROSS_TIMEOUT=0
for label in invalid_cpus invalid_memory invalid_jobs invalid_timeout; do
    [ ! -e "$TMP/$label/new.args" ] || { echo "FAIL: $label reached container creation" >&2; exit 1; }
done

printf '\n# dirty fixture\n' >>"$FIXTURE/Cargo.toml"
run_case dirty success 1
[ ! -e "$TMP/dirty/new.args" ] || { echo 'FAIL: dirty source reached container creation' >&2; exit 1; }
git -C "$FIXTURE" checkout -- Cargo.toml

echo 'Windows cross-check driver contract: PASS (success, limits, failures, cleanup and dirty-source refusal)'
