# The Linux CLI release artifacts are labelled gnu and contain musl

Closed: shipped in [v0.89.0](../../release/release-v0.89.0.md).


Status: REGISTERED 2026-08-10 by the owner during the v0.88.0 GA, from validating the dry run's artifacts before tagging rather than trusting the green.

## What

`release.yml` publishes the Linux CLI tarballs under artifact names that name the wrong libc:

```
artifact name   release-linux-cli-x86_64-unknown-linux-gnu
contains        chan-x86_64-unknown-linux-musl.tar.gz
```

The matrix carries two fields per row, `target` (gnu) and `musl_target` (musl), and the job builds with the second while labelling with the first. The job's own display name uses `musl_target` and is correct, so the run reads as a musl build and only the artifact disagrees.

The bytes are right. `chan-x86_64-unknown-linux-musl.tar.gz` extracted from the v0.88.0 dry run reports `chan 0.88.0 (build git-4b1e75e22607)`, the GA commit's own sha, and the project ships statically linked musl by design (see [`.agents/principles.md`](../../../.agents/principles.md)). This is a labelling defect, not a packaging one.

## Two sites, not one

`matrix.target` is read twice in the `linux-cli-artifacts` job, and both readings are wrong for what the job does:

| line | use | value | what the job actually does |
| --- | --- | --- | --- |
| 162 | `setup-rust-toolchain` target input | gnu | builds musl |
| 201 | `upload-artifact` name | gnu | uploads a musl tarball |

Line 186 is the build itself and correctly uses `musl_target`. The job separately runs `rustup target add <musl>`, which is why the gnu toolchain target at line 162 does no visible harm: the target the build needs gets installed by the later step regardless. That makes line 162 dead configuration that reads as intent, which is the more expensive half to leave in place.

## Why it matters more than a cosmetic name

A reader auditing what a release shipped sees `gnu` in the asset list and has no reason to open the tarball. The project's single-binary principle turns on the Linux tarball being statically linked, so an artifact list that says otherwise contradicts a load-bearing invariant in the one place a person checks it.

It also sits on the class this release closed from the other direction. `desktop-build-id-is-unknown-in-the-nix-package` was about an artifact that could not say which build it was; this is an artifact that says something untrue about itself. Both are answered by reading the artifact rather than the label, which is the check that found this one.

## Contract

- An artifact's name states the target it was actually built for.
- The matrix carries one target per row, or every field it carries is used for what its name says.
- Toolchain setup requests the target the build uses, so the build does not depend on a later `rustup target add` to repair it.

## Acceptance

- The Linux CLI artifacts are named for musl, matching both the tarball inside and the job's display name.
- `matrix.target` is either removed from `linux-cli-artifacts` or used only where gnu is genuinely meant, established by reading each remaining use rather than by the workflow staying green.
- Confirmed on a real `publish=false` dry run by listing the artifacts and extracting one, not by reading the YAML. The defect was invisible to every green run this project has had.
- Nothing downstream consumed the old name. A grep at registration time found no other reference in `.github/workflows/` or `scripts/`, but the release asset verifier and the `/dl` metadata generators should be re-checked, since both run only on a publishing tag and neither was exercised by the dry run that found this.

## Rough size

Very small as a change, two lines. The judgement is entirely in the last acceptance line: confirming no consumer depends on the current name, on paths that a dry run does not execute.
