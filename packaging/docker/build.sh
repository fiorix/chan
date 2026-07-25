#!/usr/bin/env bash
# Build the chan + chan-gateway OCI images from the repo root context.
#
# Engine-agnostic: prefers docker (BuildKit), falls back to podman, then
# buildah. Diagnostics go to stderr; stdout stays clean for the image list.
#
#   packaging/docker/build.sh                 # build all five images, tag :dev
#   packaging/docker/build.sh -t v0.49.0-rc1  # custom tag
#   packaging/docker/build.sh --save          # also export OCI archives for `sdme fs import`
#   packaging/docker/build.sh --model         # build the chan image with the embedded model
#   packaging/docker/build.sh --chan-only     # build only the chan image
#   packaging/docker/build.sh --gateway-only  # build only the four gateway images
#   packaging/docker/build.sh -v              # verbose (set -x)
#
# Output OCI archives (with --save) land in packaging/docker/_out/<image>.oci.tar, ready
# for: sudo sdme fs import packaging/docker/_out/<image>.oci.tar --name <name> --oci-mode app \
#        --base-fs <base>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/_out"

TAG="dev"
SAVE=0
MODEL=0
COMPONENT=all

log() { printf '>> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        -t|--tag)   TAG="${2:?missing tag}"; shift 2 ;;
        --save)     SAVE=1; shift ;;
        --model)    MODEL=1; shift ;;
        --chan-only)
            [ "$COMPONENT" = all ] \
                || die "--chan-only and --gateway-only are mutually exclusive"
            COMPONENT=chan
            shift
            ;;
        --gateway-only)
            [ "$COMPONENT" = all ] \
                || die "--chan-only and --gateway-only are mutually exclusive"
            COMPONENT=gateway
            shift
            ;;
        -v|--verbose) set -x; shift ;;
        -h|--help)  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "unknown argument: $1" ;;
    esac
done

# Pick a container engine. buildah's build verb is `bud`/`build`; docker and
# podman use `build`. docker gets BuildKit so it honors <dockerfile>.dockerignore.
ENGINE=""
for cand in docker podman buildah; do
    if command -v "$cand" >/dev/null 2>&1; then ENGINE="$cand"; break; fi
done
[ -n "$ENGINE" ] || die "no container engine found (need docker, podman, or buildah)"
if [ "$ENGINE" = docker ] && ! docker buildx version >/dev/null 2>&1; then
    die "docker BuildKit needs the buildx CLI plugin (for example: apt install docker-buildx)"
fi
log "engine: $ENGINE"

# Per-engine build wrapper. $1=dockerfile $2=target(or '') $3=image:tag $4=extra
build() {
    local dockerfile="$1" target="$2" image="$3"; shift 3
    local -a args=(-f "${dockerfile}" -t "${image}")
    [ -n "$target" ] && args+=(--target "$target")
    [ "$MODEL" = "1" ] && args+=(--build-arg EMBED_MODEL=1)
    args+=("$@")
    log "build ${image}  (-f ${dockerfile#"$REPO_ROOT"/}${target:+ --target $target})"
    case "$ENGINE" in
        docker)
            DOCKER_BUILDKIT=1 docker build "${args[@]}" "${REPO_ROOT}" ;;
        podman|buildah)
            # podman/buildah read --ignorefile rather than the BuildKit-named
            # <dockerfile>.dockerignore.
            "$ENGINE" build --ignorefile "${dockerfile}.dockerignore" \
                "${args[@]}" "${REPO_ROOT}" ;;
    esac
}

CHAN_DF="${SCRIPT_DIR}/chan.Dockerfile"
GW_DF="${SCRIPT_DIR}/gateway.Dockerfile"

if [ "$COMPONENT" != gateway ]; then
    build "${CHAN_DF}" "" "chan:${TAG}"
fi
if [ "$COMPONENT" != chan ]; then
    build "${GW_DF}" identity "chan-gateway-identity:${TAG}"
    build "${GW_DF}" profile "chan-gateway-profile:${TAG}"
    build "${GW_DF}" devserver-proxy "chan-gateway-devserver-proxy:${TAG}"
    build "${GW_DF}" devserver-control "chan-gateway-devserver-control:${TAG}"
fi

if [ "$SAVE" = "1" ]; then
    mkdir -p "${OUT_DIR}"
    images=()
    if [ "$COMPONENT" != gateway ]; then
        images+=(chan)
    fi
    if [ "$COMPONENT" != chan ]; then
        images+=(chan-gateway-identity chan-gateway-profile)
        images+=(chan-gateway-devserver-proxy chan-gateway-devserver-control)
    fi
    for img in "${images[@]}"; do
        out="${OUT_DIR}/${img}.oci.tar"
        log "save ${img}:${TAG} -> ${out#"$REPO_ROOT"/}"
        case "$ENGINE" in
            docker) docker save "${img}:${TAG}" -o "${out}" ;;
            podman) podman save --format oci-archive -o "${out}" "${img}:${TAG}" ;;
            buildah) buildah push "${img}:${TAG}" "oci-archive:${out}" ;;
        esac
    done
fi

log "done; images:"
"$ENGINE" images 2>/dev/null | grep -E 'chan(-gateway)?(-(identity|profile|devserver-proxy|devserver-control))?\s' || true
