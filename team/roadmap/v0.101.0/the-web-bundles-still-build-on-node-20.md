# The web bundles still build on node 20 everywhere but Nix

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog, where the mismatch was accepted for one release candidate and never reconciled. The claims are a source reading against `main` at `fa0df75ad`.

## What was seen

Every GitHub workflow that builds a bundle asks for node 20: twenty `node-version: '20'` sites across `ci.yml`, `release.yml`, `release-desktop.yml`, `pages.yml` and `gateway-ci.yml`. The three Dockerfiles under `packaging/docker/` build from `node:20-bookworm` images, and `packaging/docker/README.md` documents that base. The Nix packages already use `nodejs_22` (`packaging/nix/chan.nix`, `packaging/nix/chan-desktop.nix`), so the project ships bundles from two major versions today. `web/package.json` declares no `engines`, so nothing states which one is meant.

The Dockerfiles' base images are named by tag, not by digest. Pinning them was deferred by ruling twice in the backlog's rounds and is not ruled on here.

## Desired contract

Owner ruling, 2026-09-20: node 22 if possible. The project does what is right and is not held back by the development host, whose distribution tooling means the bundles are built in a separate sdme container there anyway; the requirement is that it works well in GitHub Actions.

One node major builds every bundle the project ships, it is 22, and one place states it so the next bump is one edit plus the sites that cannot read it.

## Boundaries

The five workflows, the three Dockerfiles and their README, and `web/package.json` (an `engines` floor). Nix already conforms. The distribution packages under `packaging/distros/` (the AUR `makedepends`, the Fedora spec) build with whatever `nodejs` the distribution ships and cannot be pinned from here, so a declared floor has to be one the oldest supported distribution still meets; establishing that is part of the item. Whether the `FROM` lines gain a digest while they are being edited is the owner's to rule; this item does not require it.

## Acceptance

1. No workflow or Dockerfile names node 20; a check in the static gate fails when a new site names a different major than the declared one.
2. Main CI, Gateway CI and a `publish=false` release dry run are green on node 22, including the desktop package jobs on macOS and Windows.
3. Both Docker images build, and the test under `packaging/docker/test/` still passes.
4. The bundles built on 22 pass `make web-check` and the release devserver smoke, and `package-lock.json` is unchanged or its change is explained.
5. The node each supported distribution ships is recorded, and the declared floor does not exclude any of them, or the item names the package that has to change.
