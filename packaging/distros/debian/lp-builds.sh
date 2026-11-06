#!/usr/bin/env bash
# Read the binary builds of one exact PPA source publication.
# Exit 0: every build succeeds; 1: missing publication or failed build;
# 2: usage, network or API-shape error; 3: builds still in progress.
# Usage: lp-builds.sh [--verbose] <source-name> <full-debian-version> <series>
# PPA defaults to ppa:fiorix/chan; LP_API_BASE defaults to the public API.

set -euo pipefail

verbose=0
if [[ ${1:-} == --verbose || ${1:-} == -v ]]; then
    verbose=1
    shift
fi
if [[ $# != 3 ]]; then
    echo 'usage: lp-builds.sh [--verbose] <source-name> <full-debian-version> <series>' >&2
    exit 2
fi
package=$1
version=$2
series=$3
LP_API_BASE=${LP_API_BASE:-https://api.launchpad.net}
LP_API_BASE=${LP_API_BASE%/}
PPA=${PPA:-ppa:fiorix/chan}

fail() { echo "lp-builds: $*" >&2; exit 2; }
[[ $PPA =~ ^ppa:([a-zA-Z0-9.+-]+)/([a-zA-Z0-9.+-]+)$ ]] || fail 'PPA must be ppa:owner/name'
owner=${BASH_REMATCH[1]}
archive=${BASH_REMATCH[2]}
[[ $LP_API_BASE =~ ^https?://[^/?#]+$ ]] || fail 'LP_API_BASE must be an HTTP(S) origin'
[[ $package =~ ^[a-z0-9][a-z0-9.+-]*$ && $series =~ ^[a-z][a-z0-9-]*$ && -n $version ]] || fail 'invalid package, version or series'

# Read every page before classifying, so a later failure cannot look green.
collection() {
    local url=$1 response page next start size total=-1 count=0 entries='[]' seen=$'\n'
    shift
    while [[ -n $url ]]; do
        [[ $url == "$LP_API_BASE/1.0/"* ]] || fail "unexpected API link: $url"
        [[ $seen != *$'\n'"$url"$'\n'* ]] || fail 'cyclic API pagination'
        seen+="$url"$'\n'
        if [[ $verbose == 1 ]]; then printf 'lp-builds: GET %s\n' "$url" >&2; fi
        response=$(curl -fsS --max-time 30 -G "$url" "$@") || fail 'Launchpad API request failed'
        set --
        page=$(jq -ce '
            def integer: type == "number" and . >= 0 and floor == .;
            if type == "object" and (.entries | type == "array")
               and (.start | integer) and (.total_size | integer)
               and ((.next_collection_link == null) or
                    (.next_collection_link | type == "string" and length > 0))
            then . else error("invalid collection") end
        ' <<< "$response") || fail 'invalid Launchpad collection'
        start=$(jq -r '.start' <<< "$page")
        size=$(jq -r '.total_size' <<< "$page")
        [[ $start == "$count" ]] || fail 'non-contiguous API pagination'
        if [[ $total == -1 ]]; then total=$size; fi
        [[ $total == "$size" ]] || fail 'collection size changed during pagination; retry'
        entries=$(jq -cn --argjson previous "$entries" --argjson page "$page" '$previous + $page.entries') || fail 'invalid entries'
        count=$(jq 'length' <<< "$entries")
        next=$(jq -r '.next_collection_link // empty' <<< "$page")
        if [[ -z $next ]]; then
            [[ $count == "$total" ]] || fail 'incomplete API collection'
        else
            [[ $count -gt $start && $count -lt $total ]] || fail 'invalid API pagination'
        fi
        url=$next
    done
    printf '%s\n' "$entries"
}

sources=$(collection "$LP_API_BASE/1.0/~$owner/+archive/ubuntu/$archive" \
    --data-urlencode 'ws.op=getPublishedSources' \
    --data-urlencode "source_name=$package" --data-urlencode "version=$version" \
    --data-urlencode 'exact_match=true') || exit 2
publications=$(jq -ce --arg package "$package" --arg version "$version" \
    --arg series "$LP_API_BASE/1.0/ubuntu/$series" '
    def text: type == "string" and length > 0;
    if all(.[]; type == "object" and (.source_package_name | text)
           and (.source_package_version | text) and (.distro_series_link | text)
           and (.status as $status | ["Pending", "Published", "Superseded", "Deleted", "Obsolete"] | index($status) != null)
           and (.self_link | text))
    then [.[] | select(.source_package_name == $package and .source_package_version == $version
                       and .distro_series_link == $series
                       and (.status == "Published" or .status == "Pending"))]
    else error("invalid source publication") end
' <<< "$sources") || fail 'invalid source-publication shape'
count=$(jq 'length' <<< "$publications")
if [[ $count == 0 ]]; then
    printf 'no publication: %s %s %s\n' "$package" "$version" "$series"
    exit 1
fi
[[ $count == 1 ]] || fail 'ambiguous source publication'
publication=$(jq -r '.[0].self_link' <<< "$publications")
builds=$(collection "$publication" --data-urlencode 'ws.op=getBuilds') || exit 2
rows=$(jq -er --arg package "$package" --arg version "$version" \
    --arg series "$LP_API_BASE/1.0/ubuntu/$series" '
    if all(.[]; type == "object" and (.arch_tag | type == "string" and test("^[a-z0-9][a-z0-9_-]*$"))
           and (.buildstate | type == "string") and .source_package_name == $package
           and .source_package_version == $version and .distro_series_link == $series)
    then map([.arch_tag, .buildstate] | @tsv) | join("\n")
    else error("invalid build") end
' <<< "$builds") || fail 'invalid build shape'
if [[ -z $rows ]]; then
    printf 'lp-builds: no builds yet for %s %s %s\n' "$package" "$version" "$series" >&2
    exit 3
fi
failed=0
pending=0
while IFS=$'\t' read -r arch state; do
    case "$state" in
        'Successfully built') ;;
        'Failed to build'|'Failed to upload'|'Cancelled build'|'Chroot problem'|'Build for superseded Source') failed=1 ;;
        'Needs building'|'Currently building'|'Dependency wait'|'Uploading build'|'Cancelling build'|'Gathering build output') pending=1 ;;
        *) fail "unknown build state: $state" ;;
    esac
    printf '%s %s\n' "$arch" "$state"
done <<< "$rows"
if [[ $failed == 1 ]]; then exit 1; fi
if [[ $pending == 1 ]]; then exit 3; fi
exit 0
