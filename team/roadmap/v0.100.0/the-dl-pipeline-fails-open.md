# The /dl release pipeline fails open

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (findings REL-01, REL-02 and REL-03, medium), re-verified against `main` at `d3de0180b`. The v0.99.0 cut changed nothing here: `web/packages/marketing` moved only its version pin, and all three reproduce byte for byte.

## What was seen

`web/packages/marketing/scripts` turns a published GitHub release into the static tree that `chan upgrade`, both installers, the Tauri updater and the download buttons read. `/dl/cli/latest.json` and `/dl/desktop/latest.json` are the highest-blast-radius artifacts in the repository: a bad one does not fail a build, it changes what every existing install downloads next. Three paths in that pipeline turn a mistake into silence.

**A requested tag that does not exist ships a site with no downloads.** `collect-release-assets.mjs` treats a 404 as acceptable whenever `--allow-missing-release` is set, without asking whether a `--tag` was requested, and `preserve-release-metadata.mjs` always passes that flag and then appends the user's `--tag`. A tag that parses as a version but is not a published release (a typo, a version not cut yet) makes the collector return null all the way up, and the deploy publishes chan.app with no `/dl` from a build that reported success.

**A renamed asset disappears instead of failing.** `generate-release-metadata.mjs` imports nothing from `release-assets.mjs`, which single-sources the asset names, and re-spells the DMG, both AppImages, the NSIS installer and all six CLI asset names itself. Its final filter keeps only candidates present in the manifest, so a rename on one side silently drops that download row.

**A new updater platform ships unverified.** In `release-assets.mjs`, `updaterPayloads` is commented as the single source for the collector and the updater asset list, and `updaterAssets` is a separate hand-written list that nothing cross-checks. Adding a platform gives the collector a new updater entry whose detached `.sig` the release verifier never requires.

## Desired contract

The pipeline fails closed. A tag that was asked for and cannot be found is an error. Asset names are spelled once and every script derives from that spelling. Every updater payload the collector can publish is one the verifier requires a signature for, by construction.

## Boundaries

`web/packages/marketing/scripts/collect-release-assets.mjs`, `preserve-release-metadata.mjs`, `generate-release-metadata.mjs`, `release-assets.mjs`, and their tests under the same package. `--allow-missing-release` keeps its one legitimate use, a site built before any release exists. No change to the published JSON shapes. A `publish=false` dry run does not execute these scripts, so the proof is local, against the real v0.99.0 release assets.

## Acceptance

1. Collecting with a `--tag` that is not a published release exits non-zero, with and without `--allow-missing-release`.
2. Renaming an asset in `release-assets.mjs` either renames it everywhere or fails the metadata generation; a test proves a name present in one list and absent from the other is an error.
3. `updaterAssets` is derived from `updaterPayloads`, and a payload added to one appears in the other without a second edit.
4. Generating metadata for the published v0.99.0 assets reproduces the published `latest.json` files byte for byte, before and after the change.
