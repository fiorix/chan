# chan's Homebrew packages move from fiorix/chan to fiorix/tap

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the first push to `fiorix/homebrew-tap` was the release's downstream run (`552baa154`, 2026-11-07), and the owner's Mac steps followed it the same day, recorded under Owner steps below.

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

Owner steps, all done. Before the release: the write deploy key `chan publish-downstream` on `fiorix/homebrew-tap` and the repository secret `HOMEBREW_FIORIX_TAP_DEPLOY_KEY_BASE64` on `fiorix/chan`. v0.124.0 was not republished into the new tap: the v0.125.0 release's own downstream run was the first push to `fiorix/homebrew-tap` (`552baa154`, 2026-11-07 12:58Z) and the `publish=true` half of acceptance 1. After that publish, on 2026-11-07, in order:

1. The new tap's README gained its chan section (`82baad8`, `88c9adb`); its formula trust line reads `brew trust --formula fiorix/tap/chan`, since a bare `brew trust` infers the type from local tap files and fails before the tap is tapped.
2. The readings ran in isolated Homebrew prefixes with both packages installed from `fiorix/chan` at 0.124.0, the Mac itself holding neither through brew; then the old tap's commit `8657521` deleted `Casks/chan-desktop.rb` and `Formula/chan.rb`, added `tap_migrations.json` with both entries and replaced its README with the steps to move.
3. With `fiorix/tap` tapped and trusted, `brew update` moved the cask by itself and upgraded it to 0.125.0 (its "moved to Homebrew" message is wrong, and the uninstall it suggests would remove the fresh install, so the README says to skip it) and moved the formula silently, then `brew upgrade chan` took it to 0.125.0; with the new tap not tapped, brew printed tap, trust and reinstall commands for both packages and changed nothing, and the README's steps (tap, trust, reinstall both, untap `fiorix/chan`) ended at 0.125.0 from `fiorix/tap` (acceptance 2); fresh installs with neither tap tapped each tapped `fiorix/tap` and trusted that one item, 0.125.0 both (acceptance 3). The cask's `tap_migrations.json` entry is needed, `brew reinstall` working through it; the brief's uninstall-then-install steps for the app were not.
4. `fiorix/homebrew-chan` archived, not deleted; it still taps, and `brew update` on a Mac that has it reports no error.
5. The old secret `HOMEBREW_TAP_DEPLOY_KEY_BASE64` and the old deploy key on `fiorix/homebrew-chan` deleted; `HOMEBREW_FIORIX_TAP_DEPLOY_KEY_BASE64` kept.
