# The required-assets list spells a prerelease deb with a dot

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised from the v0.99.0 release, whose rc1 dry run showed the mismatch. Nothing is broken at a GA version; the next release candidate meets it again.

## What was seen

`requiredAssets` builds the gateway deb names from `gatewayPackageVersion` (`web/packages/marketing/scripts/release-assets.mjs`), which replaces `-` with `.` (`release-version.mjs`), so for `0.99.0-rc1` it expects `chan-gateway-*_0.99.0.rc1-1_{amd64,arm64}.deb` while cargo-deb writes the Debian form `0.99.0~rc1-1`. In the rc1 dry run (Release 35465776424) the other fifteen asset names matched exactly and the ten gateway debs did not. At a GA version the list and the artifacts agree 25 to 25, so nothing is broken today; which reading is right is unverified, because a GitHub release upload rewrites `~` in an asset name to `.`.

## Desired contract

The required-assets list names the artifacts the pipeline actually produces at every version shape it is asked about, or it says in one place, next to the transform, why a prerelease is spelled differently and that nothing consumes it.

Owner ruling, 2026-09-20: the tilde. `requiredAssets` names the Debian form cargo-deb writes (`0.99.0~rc1-1`), which is what a `publish=false` dry run compares it against, and the comment beside the transform names the GitHub upload rewrite of `~` to `.`.

Build-side and published-release readers need distinct spellings. `gatewayPackageVersion` and `gatewayDebAssets` describe build artifacts and supply the tilde form to `requiredAssets`. `gatewayAssetVersion` and `gatewayDebAssetsAsPublished` describe uploaded assets and supply the dot form to the published-release collector, metadata generator and `requiredAssetsAsPublished`. The post-upload verifier reads the release API and uses `requiredAssetsAsPublished`. The names agree at GA. A published-release fixture uses the uploaded spelling, so a prerelease test exercises the same names its reader receives.

## Boundaries

`web/packages/marketing/scripts/release-version.mjs`, `web/packages/marketing/scripts/release-assets.mjs`, the published-asset readers `collect-release-assets.mjs`, `generate-release-metadata.mjs` and `verify-release-assets.mjs` in the same directory, and their tests. The release workflow and cargo-deb are not changed.

## Acceptance

1. A unit test over a `-rcN` version asserts the tilde name shape produced by the build and the dot name shape read from a published release, with each reading stated in the test's own words.
2. A GA version still produces 25 of 25 matching names, pinned.
3. The decision between the tilde and the dot is recorded where the transform lives, naming the GitHub upload rewrite.
4. The next rc dry run's asset diff is empty for the gateway debs, or the diff is explained by the recorded decision.

Implementation evidence on `main` at `9a368ed7c` covers the transforms, collector, metadata generator and prerelease manifest fixtures. The published-release verifier correction is independently reviewed at candidate `756b5249d`; its literal RC fixture requires all 25 published names and rejects missing or wrong-version gateway assets. That candidate still requires integration and landing. Acceptance 4 still needs the release candidate's artifact comparison; the unit tests do not establish that result.
