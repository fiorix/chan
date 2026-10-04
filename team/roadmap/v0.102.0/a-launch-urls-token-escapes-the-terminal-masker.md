# A launch URL's token escapes the terminal's secret masker

Status: raised on 2026-10-03 from a reading of the terminal's masking rule made before `chan devserver status` learned to print the launch URL; accepted by the owner on 2026-10-04 for a build in v0.102.0, as the lead recommended (the ninth decision file, S1, option a). Read in the code; not seen on a display.

## Owner ruling

On 2026-10-04 the owner accepted the row for a build: the terminal's masker also hides the token of a launch URL, before the control terminal's URL line is built.

## What was seen

A control terminal with secret masking on hides the value of an assignment whose name ends in a listed suffix, `CHAN_DEVSERVER_TOKEN` among them (`SecretAssignmentMatcher.find`, `web/packages/workspace-app/src/terminal/secretMasking.ts`). The lines chan prints carry the same token in another shape: `http://127.0.0.1:<port>/?t=<token>`, from a foreground `chan devserver run`, from `chan devserver rotate-token` and from `chan serve`. A URL's `t=` has no such name, so the terminal shows the marker's value masked and the same token in clear in the URL line beside it.

## Desired contract

In a terminal with masking on, the value of a `t` query parameter of an `http` or `https` URL whose host is a loopback or an unspecified address (`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`, `[::]`) is masked as an assignment's value is, whenever the suffix list masks `CHAN_DEVSERVER_TOKEN`, so the URL line and the marker are masked and unmasked together. The name `t` is read case-sensitively, as the server reads it; the value ends at `&`, `#`, whitespace, a quote, `<` or `>`.

## What to do

Add the URL rule beside the assignment rule in the masker, derive the marker's name from its one definition, pin the rule red first in the masker's suite, and state it in the page's design and in the configuration reference's sentence on what the list masks.

## Boundaries

`web/packages/workspace-app/src/terminal/secretMasking.ts` and its tests, `web/packages/workspace-app/src/terminal/snapshotCache.ts` (the marker's name exported), the page's design document, `docs/config-reference.md`'s sentence on the list. No change to what the server prints.

## Acceptance

1. A launch URL on a loopback or unspecified host printed in a terminal with masking on shows no token; pinned red first.
2. The same URL with masking off, or with `TOKEN` removed from the suffix list, is shown whole; pinned.
3. A URL on another host, a `ws` URL and a `T=` or `token=` parameter are not touched; pinned as guards. The cost is written: a launch URL printed with a LAN bind stays in clear.
4. The design and the configuration reference state the rule.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. No browser was driven: browser check 93 fails at the base, at the step that opens a terminal, before any masking leg. With masking on, the masker hides the value of each `t` parameter of an `http` or `https` URL on a loopback or unspecified host while a listed suffix ends `CHAN_DEVSERVER_TOKEN`, and a value both rules reach is one mask (`launchUrlTokens`, `web/packages/workspace-app/src/terminal/secretMasking.ts`); it takes the marker's name from the marker's one definition (`DEVSERVER_TOKEN_MARKER`, `web/packages/workspace-app/src/terminal/snapshotCache.ts`). Acceptance 1 and 2 are pinned red first, with a case on an xterm under jsdom for the masked cells; acceptance 3's guards are pinned, a LAN address and a `t` in a fragment among them, and its cost is written; for acceptance 4, `web/packages/workspace-app/src/design.md` and `docs/config-reference.md` state the rule. Masking is visual: a copy and the link carry the whole URL (read, not driven). The control terminal's URL line, which the owner's ruling put after this row, belongs to [no-printed-line-opens-the-devserver-in-a-browser](no-printed-line-opens-the-devserver-in-a-browser.md). This row is complete.
