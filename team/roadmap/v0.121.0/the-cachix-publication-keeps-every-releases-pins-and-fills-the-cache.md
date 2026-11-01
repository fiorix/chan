# The Cachix publication keeps every release's pins and fills the cache

Status: raised by the owner on 2026-11-01 during the v0.120.1 cut ("our cachix step should delete old releases like keep the last 5 or 10 before we hit the quota"); drafted by the lead for v0.121.0.

## What is there now

`.github/workflows/publish-downstream.yml`'s `cachix-build` job builds `chan` and `chan-desktop` natively on x86_64 and aarch64, pushes both closures to the public `chan` cache and pins them as `vX.Y.Z-chan-{x86_64,aarch64}-linux` and `vX.Y.Z-chan-desktop-{x86_64,aarch64}-linux` (four pins per release). A pin keeps its closure out of Cachix's garbage collection, and nothing removes a pin, so every release adds its closures for good and the cache grows by four closures a release toward the plan's quota (the owner's concern: a full cache fails the pushes and reds the Cachix lane of a release). The lane is described in `packaging/nix/README.md`, "Cachix release path", which states the pins and no retention. The `cachix-substitute` smoke substitutes the current version's closures only (`nix build --max-jobs 0` from the tag's checkout), so no check reads an older release's pins.

## Desired contract

1. The publication keeps the pins of the last N released versions (N a workflow input defaulting to 10, the owner's "5 or 10") and removes the older pins before pushing the new closures, so Cachix's garbage collection reclaims the unpinned closures and a release never meets the quota because of its predecessors.
2. Versions are ordered by their semantic version, not by pin creation time, and a dry run (`publish=false`) lists what it would remove without removing anything; a removal failure stays red and attributable in its own step and fails nothing else, like every downstream target.
3. The removal uses Cachix's own interface for pins (the CLI's pin commands or the API's pin deletion, read from Cachix's documentation when the row is built) with the existing `CACHIX_AUTH_TOKEN`; the README's Cachix section states the retention and how to raise it.
4. A test pins the selection (which pin names fall outside the last N for a given list, including rc and patch versions) without touching Cachix.

## Next

A decision on N and whether rc pins (none are made today) count; then the row.
