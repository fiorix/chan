# Six Low findings of the v0.102 Rust review are open

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; each finding gets a disposition, repaired or stated as an observation, from its text in the v0102 archive.

## What was seen

The v0.102.0 report (`team/release/release-v0.102.0.md`, Follow-ups) leaves six of the last Rust review's nine Low findings open after rc1's two test pins and the rewrap of two commit messages: a join of tenant tasks with no bound of its own under the attempt lock, a hand-back marked and not delivered that stays marked, two gaps in the docs of the host and the server file, two guards with no series, and pin hygiene. The findings' text is in the v0102 archive (`../chan-dev/releases/v0102-team/`), not in the report; locating each finding's text and file is the first step.

## Desired contract

Each of the six has a disposition recorded in this item with the finding's text and location: repaired in this version with a test or a doc change, already repaired with the commit named, or an observation kept as written with its reason.

## What to do

Find the six findings' text in the archive and quote each with its path. Read each at source at the base. Dispose: a bounded join, an undelivered hand-back that clears its mark, the two doc gaps filled, the two guards given their series or their absence explained, and the pin hygiene applied, each as its own small commit where repaired; an observation where a repair is not warranted, with the reason.

## Boundaries

The files the findings name in `crates/chan-library/` and `crates/chan-server/` and their tests and docs; no change outside a finding's location.

## Acceptance

1. The six findings quoted with their archive paths and their source locations at the base.
2. A disposition per finding, each repair in its own commit with fmt, clippy and the whole crate suite green in the owning guest, each observation with its reason.
3. The reviewer reads the six dispositions against the archive text.
