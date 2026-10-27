# A launcher notice bubble shows no time, so nobody knows when it happened

Status: shipped at [v0.112.0](../../release/release-v0.112.0.md); the section Closing evidence holds the evidence.

Record before the release: raised on 2026-10-25 by the owner during the v0.110.0 close; v0.111.0 shipped without it; awaiting acceptance for v0.112.0.

## What was seen

The owner's words of 2026-10-25, after the v0.110.0 release: "chan-desktop notifications from chan-launcher like gateway failing should include a descriptive time like 'N minutes/hours/days ago' and if we hover over the time it shows the actual timestamp; otherwise we have no idea when the notifications happened".

Read at `b2dbbf270`; the GA and record commits of v0.110.0 change no file named here. Paths under `web/packages/launcher/src/` unless named.

- The surface is the launcher's notice ring: `state/notices.svelte.ts` keeps at most four notices (`MAX_NOTICES`), each a `Notice` with `id`, `kind` (`error` or `info`), `source` (`gateway`, `devserver` or `desktop`, with an id and a label), `title`, `message` and `at`, documented as milliseconds since the epoch and mirroring the desktop's serde shape exactly. `pushNotice` replaces a live id in place or appends and evicts the oldest; `pushLocalError` stamps `at: Date.now()` for a locally raised action error.
- The desktop stamps `at` at emit time: `desktop/src-tauri/src/gateway.rs` `emit_notice` serializes `Notice { id, kind, source, title, message, at }` on the `launcher-notice` event (the constant `LAUNCHER_NOTICE`), fire-and-forget with no replay; its callers are the gateway cascade (`notice_unreachable` after `ROSTER_UNREACHABLE_FAILURES`, the PAT load failure), `emit_system_notice` in `main.rs` and the devserver and migration narration.
- `components/NoticeBubbles.svelte` renders each bubble as a head row (the source chip, the title with an ellipsis, the Dismiss button) and a body (the message clamped to two lines, expanding on click). Nothing reads `at`: the bubble carries no time, in the head, in the expanded body or on hover, and the test file's four cases (source chip and role, a local error, expand and collapse, Dismiss) assert none.
- A relative-time rule exists once in the repository, `formatMtime` in `web/packages/workspace-app/src/state/format.ts` ("just now", `Nm ago`, `Nh ago`, `Nd ago`, the ISO date beyond a week), for a file's mtime in seconds. The launcher does not import the workspace app; `web/packages/web-shared/src` is the package both import and it has no time helper.

## Desired contract

Every notice bubble shows when its notice happened as a descriptive age in words, "just now" under a minute, then "N minutes ago", "N hours ago" and "N days ago", and the date for anything older than a week. The age keeps up with the clock while the bubble stays on screen, so a bubble left open for an hour reads "1 hour ago", not "just now". Hovering the age shows the exact local timestamp with its date and time zone; a reader without a mouse reaches the same timestamp in the expanded bubble. The age is read from the notice's `at` and never from the moment the bubble rendered, so a notice delivered to a launcher that was busy still dates from its event. The desktop payload is unchanged: `at` already carries the moment.

## What to do

1. A shared helper in `web/packages/web-shared/src/relative-time.ts`: `relativeAge(atMs, nowMs)` returning the words above (singular and plural, "1 minute ago", "2 hours ago"), and `exactStamp(atMs)` returning the local date and time with the zone offset for the hover; unit tests for the boundaries (59 s, 60 s, 59 min, 60 min, 23 h, 24 h, 6 d, 7 d) and the singular forms.
2. A ticking clock for the ring: a `now` value in `state/notices.svelte.ts` (or in the component) advanced every 30 s while the ring holds a notice and stopped when it is empty, so the ages re-render without a new push.
3. `components/NoticeBubbles.svelte`: a `<time datetime="<ISO 8601 of at>" title="<exactStamp>">` element in the head row, after the title and before Dismiss, in the secondary colour and small type, holding `relativeAge(n.at, now)`; the expanded body gains one line with the exact stamp so the time is reachable by keyboard and by a screen reader. The title keeps its ellipsis; the bubble's width is unchanged.
4. Tests, red first, in `components/NoticeBubbles.test.ts`: a notice five minutes old renders "5 minutes ago" with a `title` holding its exact stamp; a notice pushed "just now" reads so and reads "1 minute ago" after the fake clock advances a minute; a notice a day old reads "1 day ago"; one eight days old reads its date; the expanded body shows the exact stamp. `App.test.ts`'s `launcher-notice` case asserts the age appears from the payload's `at`.
5. The launcher's design document (`web/packages/launcher/design.md`, the notice paragraphs) says the bubble shows the notice's age and its exact time on hover.

## Boundaries

`web/packages/web-shared/src/relative-time.ts` (new, with its test), `web/packages/launcher/src/state/notices.svelte.ts` (the clock), `web/packages/launcher/src/components/NoticeBubbles.svelte` and its test, `web/packages/launcher/src/App.test.ts`, the launcher design document. Not changed: the desktop's `emit_notice` and its payload, the ring's bound, the message clamp and expand, the workspace app's `formatMtime` (a sibling of the same rule family, left as it is; a later row may move it onto the shared helper).

## Acceptance

1. In chan-desktop, a gateway that stops answering raises its bubble in the launcher; the bubble reads "just now" and, left on screen, reads "N minutes ago" as the minutes pass; hovering the age shows the exact local timestamp with its time zone.
2. A notice that arrived while the launcher window was hidden dates from its event, not from the moment the window was shown.
3. The expanded bubble shows the exact timestamp as text.
4. The tests above red first, green after; `make web-check` green.

## Closing evidence

The launcher derives each notice's age from its event time, refreshes it every 30 seconds while notices remain, and stops the clock when the ring empties. The head shows a semantic time with an ISO `datetime` and a hover title containing the local date, time and UTC offset; the expanded body presents that stamp as text. The shared helper uses the full date at seven days. The browser gateway check selects the page-level flip, the gateway form's Add button and the Add card's completed turn before interacting with the form.

The helper test first failed to import its absent module (`dev/v0112-team/evidence/Web112/ntctim-relative-red.log`, exit 1, zero tests), then failed 12 assertions against temporary empty stubs (`ntctim-relative-assertion-red.log`, exit 1). The mounted bubble tests failed four assertions (`ntctim-bubbles-red.log`, exit 1), and the `launcher-notice` app case failed its event-age assertion (`ntctim-app-red.log`, exit 1), before the behavior existed. The final focused helper and bubble runs passed (`ntctim-relative-dst-green.log`, `ntctim-bubbles-30s-green.log`, exits 0); the app case passed (`ntctim-app-green.log`, exit 0). Single mutations of the singular minute, seven-day boundary, stop-on-empty guard and 30-second tick each failed their guard test (`ntctim-mutant-singular.log`, `ntctim-mutant-week.log`, `ntctim-mutant-clock-stop.log`, `ntctim-mutant-30s.log`, exits 1) and were reverted.

The complete precommit `make web-check` passed with 57.4 KiB of launcher gzip JS against its 60 KiB budget and no Svelte diagnostics (`dev/v0112-team/evidence/Web112/ntctim-web-check-final-precommit.log`, exit 0). The browser helper Node gate passed 55 tests (`ntctim-browser-lib-test-final-precommit.log`, exit 0). Check 90 passed with one check run after the selectors and card turn were handled (`ntctim-check90-card-helper-precommit.log`, exit 0). The lead's base check 90 failed before the notice path at the ambiguous page flip selector (`dev/v0112-team/evidence/Lead112/int/check90-base-2/`); a later tip run with only the selector repairs failed at the gateway-card wait after the form was filled (`ntctim-check90-rerun.log`, exit 1). The latter cause is unproven and consistent with clicking during the Add card's 520 ms turn; the bounded card-turn wait gives that check an observed start and end.

Alex's chan-desktop hand-smoke of a gateway failure, hover stamp, hidden-window event time and long-lived notice remains to be done on Alex's machine. The browser check verifies the mounted demo path and the unit tests pin the time behavior; neither exercises that native window path.
