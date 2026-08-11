#!/usr/bin/env bash
# Shared resource policy for sdme containers that build chan.

# Provisional: 44G is the smallest cap demonstrated to finish the larger gate
# workload. It is not an LTO-inclusive peak for the Nix desktop build; replace
# this one value after that host measurement completes.
SDME_BUILD_DISK="${SDME_BUILD_DISK:-44G}"
readonly SDME_BUILD_DISK
