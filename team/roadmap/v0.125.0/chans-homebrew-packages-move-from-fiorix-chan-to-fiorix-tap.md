# chan's Homebrew packages move from fiorix/chan to fiorix/tap

Status: accepted by the owner on 2026-11-05 at the v0.124.0 close, to be done after the v0.124.0 tag; not started.

## What was asked

The owner wants to retire `fiorix/homebrew-chan` (tap `fiorix/chan`) and publish the `chan-desktop` cask and the `chan` formula from `fiorix/homebrew-tap` (tap `fiorix/tap`), beside the owner's other macOS packages (`minitile` today). v0.124.0 publishes to `fiorix/homebrew-chan` as before.

## What is there now

- `publish-downstream`'s `homebrew-auth`, `homebrew-validate` and `homebrew-publish` jobs render both definitions from `packaging/distros/homebrew/`, audit and install them on a macOS runner, and push them over SSH with `HOMEBREW_TAP_DEPLOY_KEY_BASE64`, the private half of a write deploy key on `fiorix/homebrew-chan`; the probe matches that repository's name in GitHub's greeting. The jobs render from the dispatching ref, not the tag, so a homebrew-only dispatch from `main` can publish v0.124.0 into the new tap without a new release.
- `fiorix/homebrew-tap` has no deploy key. Its own `update.yml` commits `minitile` updates to the same branch every three hours, so a push from chan can meet a concurrent commit.
- The tap name appears in the templates' comments, `packaging/distros/README.md`, the release skill, `desktop/updater-bridge.md` and the site's install page (`brew install --cask fiorix/chan/chan-desktop`, `brew install fiorix/chan/chan`).
- Homebrew 7.0.12 (`cmd/update_report/reporter.rb`, `migrate_tap_migration`): with a `tap_migrations.json` in the old tap, an installed formula deleted there moves to the new tap on `brew update` only when the new tap is already tapped or trusted; otherwise brew prints the `brew tap`, `brew trust` and `brew reinstall` commands. A deleted cask with a migration entry takes the path written for a cask that became a Homebrew formula: it checks formula trust and says the cask "has been moved to Homebrew". Since Homebrew 6.0.0 a non-official tap's packages need trust, and a fully qualified `brew install` trusts that one item.

## Desired contract

- `publish-downstream` validates and pushes both definitions to `fiorix/homebrew-tap` with a write deploy key on that repository, and its push survives a concurrent commit from the tap's own update workflow.
- The docs and the site name `fiorix/tap/chan-desktop` and `fiorix/tap/chan`. The tap's README gets a chan section saying chan's release workflow pushes these two files, not the tap's update workflow.
- The old tap tells existing users what to run, using a migration whose behaviour was read on a Mac with both packages installed, and is then archived.

## Acceptance

1. A `publish=false` homebrew dispatch from `main` proves the new key and validates both definitions; a `publish=true` one puts v0.124.0's `Casks/chan-desktop.rb` and `Formula/chan.rb` in `fiorix/homebrew-tap` and leaves `minitile` as it was.
2. On a Mac with both packages installed from `fiorix/chan`: after the old tap's change and `brew update`, what brew prints and does for each package is recorded, and the steps in the old tap's README bring both to `fiorix/tap`; `brew upgrade chan` then follows the new tap.
3. A fresh `brew install --cask fiorix/tap/chan-desktop` and `brew install fiorix/tap/chan` work on a Mac with neither tap tapped.
4. No file in the chan repository names `fiorix/homebrew-chan`, `fiorix/chan/chan` or `fiorix/chan/chan-desktop`, except the changelog and closed history.
