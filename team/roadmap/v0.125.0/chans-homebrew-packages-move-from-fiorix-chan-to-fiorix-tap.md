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

## Built

Four commits: `276eefdcf` (`publish-downstream`'s three Homebrew jobs read `HOMEBREW_FIORIX_TAP_DEPLOY_KEY_BASE64` with no fallback to the old secret, accept only GitHub's `Hi fiorix/homebrew-tap!` greeting, stage, audit, install and test both definitions as `fiorix/tap/chan-desktop` and `fiorix/tap/chan`, and push through the new `packaging/distros/homebrew/publish-homebrew.sh`, which commits only chan's two files, fetches and rebases over a concurrent tap commit for up to five attempts, and never forces; `test-publish-homebrew.sh` runs it against a bare repository; the templates' comments and caveats and the renderer name the new tap), `b40b157e8` (the distros README and the release skill name `fiorix/tap`), `f8fa832a9` (the updater bridge note reinstalls the cask from `fiorix/tap`), and `40f29b914` (the site's install page reads `brew install --cask fiorix/tap/chan-desktop` and `brew install fiorix/tap/chan`).

Verification: the push test passed its three cases: a commit raced onto the tap's `main` stays under chan's commit with `minitile` byte for byte, a rerun at the same version makes no commit, and a hand edit to a chan file stops the push and names the file. The base's single push was rejected in the same layout, and the script with its fetch and rebase removed failed the race case. The greeting probe, extracted from the workflow, accepted the new tap's greeting and took its error arm on the old one. `make homebrew-check` rendered both definitions for 0.124.0 from the published assets with `fiorix/tap/` once in each, where the same render of the base's templates had none. The searches for the old tap's names and the old secret's name, outside the changelog, closed history and a secret-masking test fixture, printed nothing at `40f29b914` and 27 and 9 lines at the base. The site built with both commands on its install page. A `publish=false` dispatch of `publish-downstream` from the branch (`tag=v0.124.0`, `targets=homebrew`), run `42234548200`, passed: `homebrew-auth` printed `GitHub accepted the tap deploy key: Hi fiorix/homebrew-tap!`, `homebrew-validate` rendered, styled, audited, installed and tested both packages as `fiorix/tap/...`, and `homebrew-publish` reported `publish=false credential-usable=true` and pushed nothing. The same dispatch before the new secret existed, run `42207939533`, failed its report step on the absent secret.

Owner steps. Done: the write deploy key `chan publish-downstream` on `fiorix/homebrew-tap` and the repository secret `HOMEBREW_FIORIX_TAP_DEPLOY_KEY_BASE64` on `fiorix/chan`. v0.124.0 is not republished into the new tap: the v0.125.0 release's own downstream run is the first push to `fiorix/homebrew-tap` and the `publish=true` half of acceptance 1. These follow that publish, in order:

1. The new tap's README gains its chan section.
2. On a Mac with both packages installed from `fiorix/chan`, the `brew tap`, `brew trust`, `brew info` and install receipt readings; then the old tap's commit, which deletes `Casks/chan-desktop.rb` and `Formula/chan.rb`, adds `tap_migrations.json` and replaces its README with the steps to move.
3. That Mac's `brew update` and the README's steps recorded (acceptance 2), and the fresh installs on a Mac with neither tap tapped (acceptance 3).
4. `fiorix/homebrew-chan` archived, not deleted, so `brew update` on a Mac that still has it keeps working.
5. Last, the old secret `HOMEBREW_TAP_DEPLOY_KEY_BASE64` and the old deploy key on `fiorix/homebrew-chan` deleted.
