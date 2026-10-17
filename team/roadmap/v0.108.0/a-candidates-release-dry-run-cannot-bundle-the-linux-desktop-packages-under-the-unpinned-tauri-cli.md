# A candidate's release dry run cannot bundle the Linux desktop packages under the unpinned Tauri CLI

Status: raised on 2026-10-17 by the lead from the review seat's reading of the 0.107.0 candidate's Release dry run; for the release workflow's owner.

## What was seen

Read in the 0.107.0 candidate's Release dry run (38989039770, publishing off) and v0.106.0's runs, not constructed. The two Linux desktop package jobs (amd64 and arm64) install `tauri-cli@2` unpinned and fail at the RPM bundle on the dashed candidate version: "invalid version "0.107.0-rc0": contains invalid character (allowed: alphanumeric, '.', '_', '+', '%', '{', '}', '~', '^')". The CLI resolved to 2.12.3 for that run; 2.12.2 built the 0.106.0 candidate's bundles from the same workflow. The GA's version carries no dash, so the tagged run builds them: the GA branch's dry run 39013711082 (the control arm) bundled the deb, the RPM and the AppImage at 0.107.0 under the same 2.12.3. Every candidate's dry run reds both jobs and validates neither bundle, so the dry run leaves the Linux desktop packaging unexercised before a GA.

## Desired contract

A candidate's Release dry run builds the Linux desktop packages at the candidate's version as it builds the GA's, so a packaging regression in those jobs is seen before the tag.

## What to do

Hand the RPM bundle a version mapped as the Fedora specs map it (`-rc0` to `~rc0`, with the deb and AppImage keeping their forms), in the bundle invocation the Linux desktop package jobs run, with the mapping written beside it; prove it by a candidate's dry run with both jobs green. A pin of `tauri-cli` to 2.12.2 is not the repair: a dashed RPM version is outside RPM's own grammar, so the pinned bundle uploads an RPM against acceptance 1, and the pin changes the tagged run's tool against acceptance 2.

## Boundaries

`.github/workflows/release.yml` (the Linux desktop package jobs' Tauri CLI install and bundle steps) and `desktop/Makefile` (the `build` target's `$(TAURI) build`, where the candidate's red reads), `packaging/distros/fedora/` only as the reference for the mapping. Not changed: the GA's version string, the tag's own run, the desktop crate.

## Acceptance

1. A candidate's Release dry run with publishing off: the two Linux desktop package jobs green at a dashed version, the RPM, deb and AppImage artifacts uploaded with the version each format accepts.
2. The tagged run at a GA version builds the same artifacts unchanged in name and content.
