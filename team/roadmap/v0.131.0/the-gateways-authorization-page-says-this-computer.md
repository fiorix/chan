# The gateway's authorization page says "this computer"

Status: accepted for v0.131.0 by the owner on 2026-11-15, by survey on the round's second batch of candidates ("Take all my recommendations", item 2 of `dev/v0131-team/reports/owner-candidates-2.md`: change the product string in this release; the gateway's deploy stays the owner's); built on 2026-11-15, accepted by its Fable reviewer and merged into `v0131/int`. Closed.

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

## Built, 2026-11-15

The consent page names the requesting app's host "the local machine" in its heading, title, application sentence, optional WireGuard sentence and loopback callback sentence. The manual quotes the same heading, and the identity design describes the wording. The production diff changes those five text sites and one adjacent comment; label escaping, scopes, expiry, port interpolation, form fields and authorization behavior are unchanged.

The heading is "Authorize an app on the local machine?" and the title omits the question mark. The application sentence is "An application running on the local machine is requesting access. It identifies itself by the label below. chan cannot verify who it is." The WireGuard sentence starts "Approving also enrolls the local machine's WireGuard key with" and retains its existing ingress wording. The callback sentence is "It will receive the result on the local machine at 127.0.0.1, port {port}."

The tests applied to the unchanged renderer failed at seven intended assertions, covering the heading, title, application, callback, both WireGuard ingress forms and the snapshot (`dev/v0131-team/evidence/Desk131/gwwording-40/base-independent-red.log`, exit 101). The updated renderer passed all 40 tests in `desktop_authorize::tests` (`filtered-green.log`, exit 0). The JSON snapshot body was copied from actual renderer output and checked to differ only in its three body phrases (`tip-capture.log` and `copy-audit.json`). A repository search finds the old page quotes only in this row's original record; that historical text is preserved (`old-quotes-after.log`).

Committed-tip gateway formatting, clippy, identity rustdoc and the database-free identity suite remain pending at this implementation checkpoint. No browser smoke, Postgres integration test or deployment was run. The owner retains the gateway deployment, and this row's final acceptance still requires the remaining gates and review.

## Merged, 2026-11-15

The range `cbb4fb821..842e0a21b` was accepted by a Fable reviewer (`dev/v0131-team/reviews/review-gwwording-1.md`, notes only) and merged into `v0131/int`. Its gates ran green in a guest (job J176: the identity crate's tests and docs, the profile build and the marketing check). The page now names "the local machine" in its heading, title, body, WireGuard sentence and callback line. The review found two other user-visible strings outside this row (the launcher's Computers loading line and the desktop token label's hostname fallback); they are candidates for the owner. The gateway's deploy stays the owner's.
