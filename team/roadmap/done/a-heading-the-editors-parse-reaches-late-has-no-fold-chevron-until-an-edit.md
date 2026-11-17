# A heading the editor's parse reaches late has no fold chevron until an edit

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a heading the editor draws as one has its fold chevron once the parse reaches it, with no input, after a jump down a long note as on its first screen, and a click in the gutter beside it folds its section whether or not the chevron is painted yet (`v0131/foldlate` at `9f699878a`, merged as `7884f9716`). Read by workspace-app tests with the creation parse cut, red at the base, with six mutations, and by check 261 in a guest's Chrome on a 353,989-character note: no chevron beside eight headings after Ctrl+End at the base, eight of eight at the tip. Not observed: chan-desktop's engines and macOS.

Record before the release: implemented and verified for v0.131.0; review pending.

Record: found on 2026-11-13 by the v0.129.0 worker that fixed the fold tests' flake under load, from reading and a jsdom probe, and left open for the owner (`dev/v0129/row-notes.md`, "Editor: fold chevrons missing where the tree has not reached"; `dev/v0129/status.md`, 2026-11-13; probe `dev/v0129/evidence/foldflake/09-views-probe-tip-4/`). Listed among v0.129.0's follow-ups (the [release record](../../release/release-v0.129.0.md)). Not seen in a browser. At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, with `@codemirror/view` 6.43.15 and `@codemirror/language` 6.13.1 as locked; by reading and in jsdom only.

- The fold gutter (`headingFoldGutter`, `web/packages/workspace-app/src/editor/fold.ts:172`) paints a chevron from `lineMarker` (174-183), which with `hasSection` (166-170) asks `headingLevelAt` (59): a read of `syntaxTree(state)`, the tree the state holds, with no forced parse. CodeMirror re-reads a gutter's markers only on a document, height or viewport change, a change of its marker facets, or when the gutter's `lineMarkerChange` says so; `lineMarkerChange` (188-195) says so for fold and unfold effects alone.
- The state's tree grows on a transaction, or when the parse worker publishes with an effects-only dispatch (`Language.setState`), which the gutter does not count. At creation the parse covers at most 3,000 characters, under a 20 ms budget that can end it after the first block.
- The heading styles come from the decoration walker (`web/packages/workspace-app/src/editor/decorations/walker.ts`), which forces the parse through the viewport before it walks (`ensureSyntaxTree`, 100 ms) and recomputes when the tree changes. `ensureSyntaxTree` does not put its tree in the state, so a line can be drawn as a heading, at its larger size, with no chevron beside it.
- A click in the gutter beside such a heading does nothing: the click handler (198-212) asks the same `headingLevelAt` and returns.
- In jsdom (probe P10), a plain view of `chanMarkdown()`, `chanDecorations()` and `headingFold()` with the creation parse cut: three headings styled and one chevron painted; still one after the worker published the whole tree and after a selection change; three after an edit. The probes of the mounted `Wysiwyg` editor (P9, P11) found its tree whole at mount and counted no chevrons, so whether the mounted editor shows the gap is not established. In a browser a measure that changes a line's height re-reads the markers, which may repair the first screen. By reading, a jump far down a long note (Ctrl+End, an outline entry) meets the same order: the walker parses the new viewport, the gutter re-reads on the viewport change against the older tree, and the worker's publish repaints nothing.
- v0.129.0 changed only test files under `src/editor/` (`git diff --stat v0.128.0 v0.129.0`), and nothing there has changed since; the gutter's behaviour is older.

## Desired contract

1. A heading the editor draws as a heading has its fold chevron once the parse reaches it, with no input: the gutter re-reads its markers when the state's syntax tree changes, as the heading styles do.
2. A click in the gutter beside a heading drawn as one folds its section, as a click on its chevron does, whether or not the chevron is painted yet.
3. Unchanged: which lines are headings, the fold ranges, and the refusal to fold to the document's end before the parse is complete (`headingFoldRange`'s `"incomplete"`).

## Boundaries

- `web/packages/workspace-app/src/editor/fold.ts`: the gutter's `lineMarkerChange` and its click handler. The walker and the language setup are not changed.
- Not here: the fold tests' initial parse under load, fixed in v0.129.0 by the `parsedState` helper.

## Acceptance

1. First, the reading, in a guest: the workspace app in a browser opens a long note and counts the painted chevrons against the lines drawn as headings on the first screen before any input, with headings on that screen past the first 3,000 characters; then the same after a jump to the note's end. Run on the code without the change. If every count matches, the row goes back to the owner with that reading, to close it or keep contract 2 alone.
2. Workspace app tests over a view with the creation parse cut (probe P10's shape; `withShortCreationParse` in `editor/fold.test.ts`): after the worker's publish, with no input, every heading has its chevron; a click beside a heading the creation parse did not reach folds its section. Each red on the code without the change.
3. The reading of step 1 as a browser check under `scripts/e2e/browser-smoke/checks/`, green on the change in a guest.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, point 10) on 2026-11-14: "as you recommend". The reading's outcomes are ruled in advance:

- Chevrons missing on the first screen or after the jump: both contract lines are built.
- Every count matches: contract 1 is built anyway on the jsdom red (probe P10: three headings styled, one chevron, still one after the worker's publish, three after an edit), acceptance 3 is dropped since a browser check that cannot go red proves nothing, and the row records that no browser showed the gap. The reason: the gutter depends on the syntax tree and `lineMarkerChange` ignores tree changes; a browser's height measure repairing it is an accident, not a contract.
- A gap whose cause lies outside `fold.ts` (the walker or the language setup, which this row excludes): back to the owner with the reading.

## Built, 2026-11-14

The guest reading at `23ee2e97b3b5d1eb50ccc78a3a4cc90cf2bda660` reproduced the gap after Ctrl+End in all five runs: zero chevrons beside eight fully visible section headings, with all eight headings present in the published tree. The first screen matched (nine of nine); returning through Outline and jumping back restored eight of eight. The exact fixture is 353,989 characters. The evidence and screenshot readings are in `dev/v0131-team/followups/followup-Edit131-Lead131-6.md`, with raw J32 artifacts under `dev/v0131-team/evidence/Ops131/J32/`. The lead applied the owner's missing-chevron outcome, so both contract lines are implemented.

The gutter compares the old and new published tree identities as well as fold effects. A click publishes the parse through the clicked line before heading detection, making a styled heading foldable before its marker appears. Heading classification, section boundaries and the incomplete-parse refusal remain unchanged. The decoration walker and language setup are unchanged. The editor design document and manual explain the refresh and click behavior.

The two creation-parse-cut regressions failed at the unmodified implementation: the worker completed its tree but only one of three chevrons appeared, and clicking the late heading produced no fold instead of its exact section. The fixed implementation passed both. Additional coverage keeps fenced hash lines inert and fold/unfold chevrons current when geometry does not signal a change. Host evidence is under `dev/v0131-team/evidence/Edit131/foldlate/`; the browser regression is `scripts/e2e/browser-smoke/checks/261-foldlate.mjs`, using the reading's exact fixture and asserting each visible parsed heading has one chevron on the first screen and after Ctrl+End.

The instrumented jsdom cost probe on that fixture measured one 36-line refresh after an effects-only worker publication: 46 bounded tree reads, 136 visited nodes and 0.183 ms summed marker callback time. Thirty document edits in each mode caused exactly one 36-line refresh per edit; thirty selections with an unchanged tree caused none. CodeMirror combines document and tree refresh reasons into one viewport sweep. Timing includes instrumentation and excludes parsing, DOM synchronization and browser painting; it is not an input-latency measurement. Full per-update evidence and the probe are in `dev/v0131-team/evidence/Edit131/foldlate/cost/`.

Verification completed on code commit `6f0a13e19491d982faf5adb9f40d1dbc6dc07ef1`. Ops job J51g ran `make web-check` and `make web-marketing-check`, both exit 0 with a clean committed tree before and after; the workspace app passed 727 files and 10,109 tests. Logs are `dev/v0131-team/evidence/Ops131/J51g/web-check.log` and `web-marketing-check.log`. Six independent guard mutations each failed an assertion and hash-checked restoration passed all 23 fold tests; the final tests against base fold.ts failed exactly the two intended regressions. Logs and restoration hashes are under `dev/v0131-team/evidence/Edit131/foldlate/mutations-final/` and `red-final.log`.

Job J51 ran committed check 261 in the edit guest, with the same script overlaid at base `fa3960841de0d55c106656a7fc2e80ddafe0b5c8`. Each revision ran two fresh views. Both base runs had nine chevrons for nine first-screen headings, then zero for eight after Ctrl+End, returning exit 1 at the painted-chevron assertion. Both tip runs had nine of nine initially and eight of eight after Ctrl+End, returning exit 0 with one check, no skips or page errors. Counts match before and after each screenshot; all eight screenshots were inspected. Artifacts, source/binary/bundle provenance and exact commands are in `dev/v0131-team/evidence/Ops131/J51/` and `dev/v0131-team/followups/followup-Ops131-Edit131-5.md`. The final row-only evidence commit does not change the gated product, tests or manual. No macOS or WebKitGTK run was required or claimed for this row; review remains separate.
