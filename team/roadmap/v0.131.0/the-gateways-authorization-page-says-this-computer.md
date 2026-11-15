# The gateway's authorization page says "this computer"

Status: accepted for v0.131.0 by the owner on 2026-11-15, by survey on the round's second batch of candidates ("Take all my recommendations", item 2 of `dev/v0131-team/reports/owner-candidates-2.md`: change the product string in this release; the gateway's deploy stays the owner's); not started.

Record: found by the site documentation review (note 3) when the manual quoted the page exactly. The owner's wording rule for chan's copy is "local machine", never "this machine" or "this computer".

## What is there now

Read at `a4c7fa631`: the desktop authorization page of the gateway (`gateway/crates/identity/src/desktop_authorize.rs`, about lines 925-960) says "Authorize an app on this computer?" in its heading and title, "An application running on this computer", "enrolls this computer's WireGuard key" and "on this computer at 127.0.0.1"; its tests pin those strings (about lines 1438, 1599, 1624, 1639); the manual quotes the heading.

## Desired contract

1. The page names the machine as the local machine in every sentence that says "this computer" today, with one consistent wording across the heading, the title, the body and the WireGuard sentence.
2. Nothing else on the page changes: the label, scopes, expiry, port and form are as they are.

## Boundaries

- The page's strings, their tests, the manual's quote and any other copy that quotes them (grep the repository for each string).
- The gateway's deploy is the owner's; this row changes the source only.

## Acceptance

1. The page's tests pin the new strings and fail on the old ones.
2. A grep of the repository finds no remaining quote of the old strings outside history (`CHANGELOG.md`, `team/release/`, `team/roadmap/done/`).
