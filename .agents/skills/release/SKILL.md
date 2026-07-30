---
name: release
description: >-
  Cut a chan release: the git-first rc-pinned cycle, the one-commit
  version-pin bump, the publish=false dry run, and the GA tag that
  publishes. Covers the macOS signing path.
when_to_use: >-
  The user asks to cut a release, open a release candidate, bump the
  version, tag a new vX.Y.Z, or ship a build to chan.app.
---

# Cut a release

A release is a single annotated tag `vX.Y.Z` on `main`. Pushing that tag fires `.github/workflows/release.yml` with publish semantics: it builds the CLI, gateway, and desktop artifacts across Linux, macOS, and Windows, signs and notarizes the macOS desktop build, uploads the GitHub Release assets, regenerates the chan.app `/dl` metadata (moving `latest`), and deploys GitHub Pages. A successful Release run then triggers `.github/workflows/publish-downstream.yml` once for Docker Hub, COPR, the PPA, the AUR, and the Homebrew tap. The tag push is the public release; everything before it is preparation.

## Publication layers

The release boundary is the tag, signed artifacts, GitHub Release, `/dl` metadata, and Pages deploy. Docker and every distro publication are secondary downstream targets. No secondary target may fail the release or block another secondary target. Non-blocking means decoupled, never hidden: each downstream failure stays red, attributable, and independently retryable.

## Actors

- **Release owner** (@fiorix): owns `main`, the RC branches, the final tags, and the publish decision.
- **Host agents**: run in the owner's session and clone; they review, gate, and report, but never own the release decision.
- **Contributor**: works in their own clone, owns their branch and local test cycle until they open a PR.
- **RC branch**: the public integration branch for one release candidate, named `X.Y.Z-rcN` (no leading `v`; see Invariants). A merge into it is provisional until GA.

## The cycle

Solo and contributor modes run the same cycle; the only difference is the merge boundary. The owner merges accepted candidates locally; a contributor opens a PR onto the public RC.

1. **Feature work.** Branches and worktrees off `main`, pushed and shared for review. Before an RC target exists, a branch holds and keeps iterating: build, test, hand-smoke, agent review.
2. **Open the RC.** The owner cuts the candidate: bump every version pin from the current GA to `X.Y.Z-rc1` (see Version pins) in one commit on a branch named `X.Y.Z-rcN`, and push it. This is the concrete integration target contributors rebase onto.
3. **Intake.** A candidate is ready when it is rebased onto the RC, locally validated (format, tests, hand-smoke), and carries its RC report (below). The owner plus host agents gate it; the owner accepts it into the RC as a provisional merge, or sends it back with the report updated.
4. **Dry-run build.** Dispatch `release.yml` on the RC branch with `publish=false`. This is the only way to exercise the macOS sign and notarize path and the Tauri updater signing off a workstation, so it is mandatory before GA. The platform chains fan out in parallel off the `context` job: macOS validation, the Linux artifacts, and the Windows artifacts all start once `context` passes, so a dry run that serializes macOS behind Linux signals a workflow regression. Download the run artifacts and validate them (`cs download` them locally when the build host is remote). Separately dispatch `publish-downstream` on the RC branch with the planned tag, `targets=docker`, and `publish=false`; it builds all four images cache-only without reading registry credentials. Artifact testing can still reject work already merged into the RC.
5. **Iterate.** A blocker returns to the owner or to a contributor PR, or overflows to the next version. If fixes land, cut the next candidate by bumping the pins `X.Y.Z-rcN` to `X.Y.Z-rc(N+1)` and repeat the dry run. An rc is a pin state only; no rc tag is ever pushed (see Invariants).
6. **GA close.** When no blockers remain, write the release report and cut GA in one commit. The report `team/release/release-vX.Y.Z.md` consolidates the accepted RC reports (or, for a no-rc patch, the round's own notes) into an era-report structure: what shipped, team/process, validation, a short retrospective (highlights, lowlights, honest feedback), and follow-ups. Match a recent report such as `team/release/release-v0.70.2.md` and the conventions in `team/release/README.md`, then add its one-line entry (with any `-rcN` sub-entries indented) to the `team/release/README.md` release index and keep that index current through the latest release. The GA commit carries the report, the README index entry, the CHANGELOG (rename `## [Unreleased]` to `## [vX.Y.Z] - <date>` with a one-line summary, or add a fresh dated section for a no-rc patch), and every version pin (workspace, gateway, desktop, web, plus the fedora specs; see Version pins). Strip `-rcN` from every pin. Fast-forward `main` to it. This GA commit is the last commit of the cycle.
7. **Tag and publish.** Annotate and push the tag on the GA commit: `git tag -a vX.Y.Z -m "chan X.Y.Z"`, then `git push origin vX.Y.Z`. The tag push runs `release.yml` with `publish=true` and ships the core release. Delete the RC branch, local and remote.
8. **Downstream publications.** A successful tagged Release run triggers `publish-downstream` once for Docker Hub, COPR, the PPA, the AUR, and the Homebrew tap. Each target has an independent job chain: a failure is red and attributable there, but cannot fail the core Release or suppress another target. Verify the four Docker manifests and both platforms, COPR `fiorix/chan` (`chan` on every enabled Fedora chroot plus all four CentOS chroots; `chan-desktop` on Fedora plus Stream 10, with no EL9 desktop job), `ppa:fiorix/chan` (noble + resolute), AUR `chan` + `chan-desktop` at `X.Y.Z-1`, and the fiorix/homebrew-chan tap serving `chan-desktop` + `chan` at `X.Y.Z` (the `homebrew-publish` contents-API check is the detector). Keep `main` frozen from the GA tag push until both COPR packages report complete: the COPR SCM packages build main's HEAD on an empty committish, so a push inside that window ships a package labelled `X.Y.Z` but built from a later tree; the `copr` job's publication probe (`packaging/distros/copr/verify-copr-publication.sh`) is the detector and reds when a built version is not the tag. The COPR chroot list, the per-chroot EPEL repository, and the `chan-desktop` EL9 chroot denylist are console state that nothing in the repo asserts and no API call confirms; read them in the COPR web UI whenever a CentOS job is missing, an EL9 job resolves the wrong EPEL, or an EL9 `chan-desktop` job appears. A red x86_64 `aur-validate` cell blocks both AUR pushes and nothing else. CI does not validate aarch64; the aarch64 PKGBUILD ships for users to build natively. The workflow needs the Docker Hub configuration plus `COPR_WEBHOOK`, `LAUNCHPAD_GPG_PRIVATE_KEY`, `LAUNCHPAD_GPG_PASSPHRASE`, `AUR_SSH_PRIVATE_KEY`, and `HOMEBREW_TAP_DEPLOY_KEY_BASE64`. Retry via `workflow_dispatch` with the tag, `publish=true` (dispatch defaults to a dry run), and `targets` narrowed to the failed publisher. See `packaging/distros/README.md` and `packaging/docker/README.md`.

## RC report files

Each candidate branch owns one report, `team/release/release-vX.Y.Z-rcN-{feature-branch}.md`, with a filename-safe branch name (`/` becomes `-`, kept short and recognizable). It records scope, commit range, test commands, hand-smoke notes, known risks, and changelog-worthy user impact. One branch never edits another branch's report. Only accepted RC reports feed the final `team/release/release-vX.Y.Z.md` and the CHANGELOG.

## Version pins (bump together)

Every pin moves to the same `X.Y.Z` (or `X.Y.Z-rcN`) in one commit. Missing one breaks the release at tag time, where the workflow's context job asserts the Cargo, desktop, and gateway versions all equal the tag:

- `Cargo.toml`: the `[workspace.package]` `version` AND every internal path-dep pin under `[workspace.dependencies]`.
- `gateway/Cargo.toml`: the separate nested workspace, versioned in lockstep through its own `[workspace.package]` version.
- `desktop/src-tauri/tauri.conf.json`: the `.app` bundle version. The desktop Rust package inherits the workspace version, so once this matches, the `.app` and the workspace stay aligned.
- The web `package.json` versions (root plus each package under `web/packages/`), and the marketing `package.json` `@chan/*` dependency pins.
- The three regenerated lockfiles: `Cargo.lock` and `gateway/Cargo.lock` (each refreshed with `cargo update -w`, which moves only the workspace-member versions), and `web/package-lock.json` (refreshed with `npm install`).

The marketing site reads the workspace version at build time, so it needs no separate bump; confirm nothing else has drifted.

GA only (not rc pins), the distro source packages -- both publish after the tag via `publish-downstream`, so neither gates it, but keep them current in the GA commit:

- Fedora COPR: bump `%global upstream_version` in BOTH `packaging/distros/fedora/chan.spec` and `chan-desktop.spec` (a fallback -- COPR's `make-srpm.sh` rewrites it from the workspace Cargo.toml), and prepend a dated `%changelog` entry to BOTH.
- Ubuntu Launchpad (PPA): no manual version edit. `packaging/distros/debian/build-source.sh` derives the version from `HEAD:Cargo.toml` and fills the `debian/{chan,chan-desktop}/debian/changelog.in` `@VERSION@`/`@DATE@` template at build time; there is no per-release Debian changelog to hand-edit.
- Arch: no manual version edit and no GA pin. `packaging/linux/arch/PKGBUILD` remains the local binary QA path. The AUR renderer under `packaging/distros/arch/` derives `pkgver` from the GA tag and uses `pkgrel=1` unless a packaging-only repair is dispatched explicitly.
- Homebrew: no manual version edit and no GA pin. The tap renderer under `packaging/distros/homebrew/` derives the version from the GA tag and hashes the published release assets; `publish-downstream` regenerates and pushes both fiorix/homebrew-chan files.

## Invariants

- **An rc is a pin, never a tag.** Any `v*` tag push, including `vX.Y.Z-rcN`, runs `release.yml` with `publish=true`, and `/dl/{cli,desktop}/latest.json` is regenerated to the pushed tag's version with no prerelease filter, so an rc tag rides the live self-update channel to every client. Validate rc builds with `publish=false` dispatches; only the GA `vX.Y.Z` tag is ever pushed. The RC-branch name carries no leading `v` (`X.Y.Z-rcN`), so it is not tag-shaped and cannot collide with a pushed tag; recent dry runs use this form (`0.70.0-rc1`).
- **A working branch must not be named after its future tag.** A feature, delivery, or round branch for version `X.Y.Z` named `vX.Y.Z` collides with the eventual GA tag `vX.Y.Z`: Git reports an ambiguous ref and a checkout, push, or `git show` can resolve to the wrong object. Name working branches and their worktrees distinctly from any tag. The delivery convention is a `../chan-vXYZ` worktree (for example `../chan-v0650`) on a descriptively named branch; RC integration branches use the tag-free `X.Y.Z-rcN` form (no leading `v`). If a branch does end up sharing the version string, fast-forward `main` onto it and delete the branch, local and remote, before tagging.
- **The GA commit is the tagged commit.** Strip the rc pins and cut the CHANGELOG in one commit, tag that commit, and push nothing after it before the tag. Do not tag a later notes or lockfile-refresh commit, and do not ship a version with no CHANGELOG entry.
- **The gate covers every workspace.** Run the full `make pre-push` gate green before cutting (see the gate skill); it must include the separate gateway workspace, or a green core gate can still die at tag time. A fresh clone may have no pre-push hook installed, in which case the manual gate is the only gate.
- **Push tags in the foreground.** A backgrounded gated push can SIGPIPE (exit 141) and silently fail to update the remote; push in the foreground, redirect to a file, and verify with `git ls-remote`. Pushes go over HTTPS with the gh credential helper when SSH is unavailable.
- **A version bump forces a full workspace rebuild.** New crate fingerprints invalidate the incremental cache; reclaim `target/` (drop `target/debug/incremental`, or `cargo clean`) if disk is tight before the gate.

## Self-upgrade is data-driven

Self-upgrade reads the latest manifest from `/dl` on chan.app. Cutting a release moves `latest` to the new version; the `/dl` generator also retains the last 5 GA versions as per-version manifests, so `chan upgrade --version X.Y.Z` resolves older releases. No `update.rs` edit is required. The desktop updater probes the static manifest at `https://chan.app/dl/desktop/latest.json`, generated at release time by `web/packages/marketing/scripts/generate-release-metadata.mjs`.

## Signing notes

- macOS Developer ID signing and notarization material lives in GitHub Actions Secrets; the secret NAMES the workflow requires are declared in `.github/workflows/release.yml`, and the private per-secret table is kept in the team's gitignored `dev/` tree. The macOS desktop job validates the secrets up front and fails fast with a pointer if one is missing.
- The Tauri updater minisign key is separate from the Apple Developer ID cert. Rotation procedures for both live in `.agents/desktop.md`.
- Secret VALUES never appear in journals, chat, or commits. Only the secret NAMES are referenced in workflow YAML and docs.

## Rollback

A published release cannot be un-published; a bad GA is superseded by the next patch (`X.Y.(Z+1)`). Because rc builds are never tagged, an rc that fails validation costs nothing to discard.
