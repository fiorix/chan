# The Cachix publication keeps every release's pins and fills the cache

Status: shipped in [v0.121.0](../../release/release-v0.121.0.md).

Record before the release: raised by the owner on 2026-11-01 during the v0.120.1 cut ("our cachix step should delete old releases like keep the last 5 or 10 before we hit the quota"); drafted by the lead for v0.121.0, with N decided by the owner on 2026-11-02 (the section Decisions); not started.

## What is there now

`.github/workflows/publish-downstream.yml`'s `cachix-build` job builds `chan` and `chan-desktop` natively on x86_64 and aarch64, pushes both closures to the public `chan` cache and pins them as `vX.Y.Z-chan-{x86_64,aarch64}-linux` and `vX.Y.Z-chan-desktop-{x86_64,aarch64}-linux` (four pins per release). A pin keeps its closure out of Cachix's garbage collection, and nothing removes a pin, so every release adds its closures for good and the cache grows by four closures a release toward the plan's quota (the owner's concern: a full cache fails the pushes and reds the Cachix lane of a release). The lane is described in `packaging/nix/README.md`, "Cachix release path", which states the pins and no retention. The `cachix-substitute` smoke substitutes the current version's closures only (`nix build --max-jobs 0` from the tag's checkout), so no check reads an older release's pins.

## Desired contract

1. The publication keeps the pins of the last N released versions (N a workflow input defaulting to 10, the owner's decision; rc pins, none of which are made today, do not count toward N) and removes the older pins before pushing the new closures, so Cachix's garbage collection reclaims the unpinned closures and a release never meets the quota because of its predecessors.
2. Versions are ordered by their semantic version, not by pin creation time, and a dry run (`publish=false`) lists what it would remove without removing anything; a removal failure stays red and attributable in its own step and fails nothing else, like every downstream target.
3. The removal uses Cachix's own interface for pins (the CLI's pin commands or the API's pin deletion, read from Cachix's documentation when the row is built) with the existing `CACHIX_AUTH_TOKEN`; the README's Cachix section states the retention and how to raise it.
4. A test pins the selection (which pin names fall outside the last N for a given list, including rc and patch versions) without touching Cachix.

## Decisions

The owner's word of 2026-11-02 on N: "keep the last 10 versions". The same exchange carried the lead's recommendation that rc pins not count toward N; the owner's answer did not take it up separately, and with no rc pins made today it changes nothing until one is.

Cachix's documentation, read when the row was built (2026-11-02), offers no way to list or delete a pin: the Pins page of docs.cachix.org (pins added in cachix 1.5) documents `cachix pin CACHE PIN-NAME STORE-PATH` with `--keep-days`, `--keep-revisions` or `--keep-forever` and leaves listing and removal to the cache's dashboard; the cachix CLI 1.13.0 (2026-10-21) has `pin` as its only pin command; the cachix-api 1.13.0 Servant specification on Hackage (2026-10-22) has one pin route, `POST /cache/{name}/pin`; the Garbage Collection page says unpinned paths are deleted oldest-accessed first at the storage limit. So the removal contracts 1 to 4 describe needs an undocumented interface. The seat put two options to the owner: delete per-version pins through an undocumented route, or pin under stable names with `--keep-revisions`, which changes the pin names, keeps revisions by pin time instead of by version and needs no selection. The owner's word of 2026-11-02: "option 2, and i dont care about anything that's already on cachix, nobody other than myself using it for testing.. we can delete it all if needed to restart".

## Next

Review and merge; the first real pin with retention runs at the next GA.

## Closing

The publication pins each package and system under one stable name, `chan-{x86_64,aarch64}-linux` and `chan-desktop-{x86_64,aarch64}-linux`, through `scripts/cachix-pin.sh`, which runs `cachix pin chan NAME STORE-PATH --keep-revisions N` for each closure; every GA adds a revision and Cachix keeps the newest N of each name. N is `publish-downstream`'s new `cachix_keep` input, default 10, which a tag-triggered run takes from the step's `|| '10'` fallback, as `aur_pkgrel` does. The helper refuses an N that is not a whole number from 1 to 9999, a malformed cache, system or package name, or a store path outside `/nix/store`, before any command runs. Against the contract as the owner's decision reshapes it:

1. The pins of the last N releases are kept: N revisions per name. Release candidates are never pinned (the `cachix-build` job does not run for a prerelease publication), so they do not count. The pushes still run before the pins, so a publication's closures are pushed while the previous revisions still hold theirs.
2. Revisions are kept by pin time, not by semantic version: a patch release of an older line counts as the newest. A dry run (`publish=false`, or a fork without the token) prints the pins a GA would make, with the retention, in the log and the job summary, and makes none. There is no removal step to fail: Cachix drops old revisions as part of the pin, and a failed pin is red in `Pin released closures` as before.
3. It uses Cachix's documented `cachix pin --keep-revisions` with the existing `CACHIX_AUTH_TOKEN`. `packaging/nix/README.md`, Cachix release path, states the four names, the retention and how to raise it; `.agents/skills/release/SKILL.md` step 9 and its Nix line name the stable pins.
4. `scripts/test-cachix-pin.sh` pins the helper without touching Cachix: the plan and pin modes' commands for both systems, a failed pin naming itself and stopping the rest, and every refusal running no command, against a stand-in `cachix` on a throwaway PATH that refuses a pin without `--keep-revisions` or with another retention flag (checked first, so the stand-in is a real check). `make nix-hash-contract-check` runs it beside the cargo hash contract, on every host; `.agents/skills/gate/SKILL.md` step 6 says so. `scripts/check-build-matrix.py` now requires the helper's call with both packages in `cachix-build` instead of the version-named pins.

Verified: seven mutations of the helper (no KEEP check, no `--keep-revisions`, plan running commands, a failed pin ignored, a name without its system, any `/nix/store` path accepted, a pin made while later pairs are still unchecked) each failed the test at a named assertion; `make shell-check`, `make workflow-check`, `make build-matrix-check` and `make nix-hash-contract-check` pass at the commit.

Open: no Cachix call was made and no workflow was dispatched, so `--keep-revisions` on the real cache, and the dry run's printed plan on a runner, first run at the next GA and its dry run. The pins named after versions (`vX.Y.Z-...`) that earlier GAs made stay in the cache, holding their closures, until they are deleted on the cache's Pins page; the owner may clear the cache.
