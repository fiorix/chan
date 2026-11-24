#!/usr/bin/env bash
# Collect the GStreamer plugins the AppImage bundles into a new directory under
# <parent> and print it, for linuxdeploy's GStreamer plugin to read as
# GSTREAMER_PLUGINS_DIR. That plugin otherwise copies every plugin on the build
# host, with their codec libraries and licenses. This list is what WebKitGTK
# needs to capture the microphone, record it to WebM/Opus, decode common audio,
# and play it.
#
# A build host without them still builds an AppImage, whose microphone reports
# no device; CHAN_APPIMAGE_GST_STRICT=1, which a release sets, refuses that.
set -euo pipefail

parent=${1:?usage: appimage-gstreamer-plugins.sh <parent-dir>}
plugins=(
    app audioconvert audioparsers audiorate audioresample autodetect
    coreelements encoding flac gio interleave isomp4 matroska mpg123 ogg opus
    playback pulseaudio transcode typefindfunctions volume vorbis wavparse
)

source_dir=$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)
if [[ ! -d $source_dir ]]; then
    source_dir=/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0
fi

mkdir -p -- "$parent"
target=$(mktemp -d "$parent/plugins.XXXXXX")
missing=()
for plugin in "${plugins[@]}"; do
    if [[ -f $source_dir/libgst$plugin.so ]]; then
        ln -s -- "$source_dir/libgst$plugin.so" "$target/"
    else
        missing+=("$plugin")
    fi
done

if ((${#missing[@]})); then
    printf 'appimage: GStreamer plugins missing from %s: %s\n' "$source_dir" "${missing[*]}" >&2
    if [[ ${CHAN_APPIMAGE_GST_STRICT:-} == 1 ]]; then
        exit 1
    fi
fi
printf '%s\n' "$target"
