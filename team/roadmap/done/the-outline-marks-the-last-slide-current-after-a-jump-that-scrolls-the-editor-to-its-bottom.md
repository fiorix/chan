# The Outline marks the last slide current after a jump that scrolls the editor to its bottom

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

## What was seen

In a ten-slide deck with the editor's Outline open, a click on the thumbnail of slide 8 or 9 leaves slide 10 marked current. `web/packages/workspace-app/src/components/FileEditorTab.svelte` 491 to 511 derives the Outline's line from the editor's scroll position: when the scroller is at its bottom (`scrollTop + clientHeight >= scrollHeight - 2`) it writes the document's last line, and otherwise the first visible line. The Outline reads `outlineScrollLine ?? caretLine` (1540). A selection or document change clears `outlineScrollLine` (510), but the jump to slide 8 or 9 scrolls the editor to its bottom, the scroll event lands after the selection update, and the bottom rule marks slide 10 current over the clicked slide. Whether a run shows it depends on layout timing: the review seat saw it in 4 of its 20 runs of the check alone and its probe copy in a two-CPU guest, one at each of the four commits read, the version's base included (`dev/v0109-team/evidence/Review109/c173/`, the probe reading `{"current":["Slide 10"],...}` at the timeout); the check's red rate with its own unwaited reads counted was 7 of 20. The behaviour came with the floating Outline in v0.108.0.

## Desired contract

After a jump from the Outline, the clicked slide stays current whatever scroll position the jump lands at: for the scroll a jump causes, the Outline follows the caret's line wherever the scroller rests; a person's own scroll keeps today's rules, the first visible line and the last line at the bottom.

## What to do

Mark the jump in `jumpTo` after its dispatch, so the jump's own selection change does not clear it. While the mark stands, the scroll handler's `read` returns the caret's line (the editor view's selection head, not the coalesced tab caret) at any scroll position, in place of both the first-visible-line rule and the last line at the bottom, since the jump's own scroll can land with the clicked slide's heading off the first visible line as well as at the document's end. A later selection or document change clears the mark, and so does a user scroll input (a wheel or touch scroll, or a pointer down on the scroller outside the content); once it is cleared both rules apply as before. Pin red first, in a mounted `FileEditorTab` test. The jump arm has two legs: a jump to a late slide followed by a forced scroll to the bottom, and a jump followed by a scroll event whose position is away from the bottom with another slide's heading first visible; each asserts the clicked slide current and is red at the parent on its own assertion. Four own-scroll legs each jump first and then clear the mark: by a selection change to an earlier visible heading, a wheel event, a touchstart on the scroller, and a pointer down on the scroller outside the content; each then forces a bottom scroll with the caret visible and asserts the last slide current, green at the parent and at the fix. One mutant per guard, each red at its own arm: the read ignoring the mark (both legs of the jump arm), the selection-change clear removed (its leg), and each user-input clear removed (its leg: the wheel, the touch and the scrollbar press). Then check 173 alone, repeated, with the check's own unwaited reads repaired first.

## Boundaries

`web/packages/workspace-app/src/components/FileEditorTab.svelte` at the scroll handler and its test. Lands after the check's own repair and before the rich prompt item, which edits the same component elsewhere (`--editor-top-pad`, 1559 and 1671) and rebases on it. Not changed: the Outline component, the caret rule, the jump.

## Acceptance

1. The mounted pin's jump arm red at the parent on both of its legs and green at the commit, its own-scroll legs green at both, one mutant per guard red, with the commands and logs recorded here.
2. Check 173 alone green in repeated runs at the commit with the check's own repair landed, against the review seat's rate at the parent, recorded here.
3. `make web-check` green at the commit.

## Built 2026-10-21

The ruling dated 2026-10-21 (the lead's ledger, 18:36Z) widened the pending Outline jump to the editor selection head's line at any scroll position. Commit `b632113db82a74eb45bb12fba2627cff82fb0bd3` sets that mark after the jump dispatch; a later selection or document change, wheel or touch input, or pointer down on the scroller outside editor content clears it, returning the existing viewport rules. The source and mounted test are the only committed paths; `dev/v0109-team/tasks/task-Hygiene109-Lead109-11.md` gives the commands and complete evidence.

The mounted pin at parent `bf94ca16741d8260ed85dc7b8306127e5e8c482b` failed the bottom jump with `Slide 10` instead of `Slide 8` and the away-from-bottom jump with `Slide 10` instead of `Slide 9`, while both own-scroll legs passed (`dev/v0109-team/evidence/Hygiene109/otlbtm/pin-parent-expanded.{log,status}`). The fixed pin passed all four legs (`pin-fixed-expanded.{log,status}`); three targeted mutants failed at their own read, later-selection, and user-input assertions (`mutant-read-2`, `mutant-selection-1`, and `mutant-input-1` launch logs and statuses in the same directory). The mounted jsdom harness drives `requestMeasure` directly and does not sample the marker frame by frame.

At `b632113db82a74eb45bb12fba2627cff82fb0bd3`, `make web-check` passed with `VITEST_MAX_WORKERS=1`: 577 workspace app test files and 7,350 tests passed, followed by the production build and a clean checkout (`web-gate-one-worker.launch.{log,status}`). Two default-worker attempts each ended rc 2 on the same unrelated 30-second timeout in `TerminalTab.keepAlive.test.ts`, with 7,349 tests passing; the isolated file passed all 12 tests (`web-gate.launch`, `web-gate-retry.launch`, and `terminal-keepalive.launch` logs and statuses). The host cgroup snapshots `cgroup-mid.txt` and `cgroup-after.txt` show an 8 GiB memory peak, 1,456,459,776 bytes of lifetime swap peak, and 363 throttled periods across the latter gate and browser interval, so these runs are recorded as contended; no OOM occurred.

After strict browser-suite `npm ci`, Puppeteer 25.15.0 ran check 173 alone ten times at the commit using debug binary SHA-256 `e0fb34ff03b6d6b2dd25eb65fcf368e18d73e9398b22cbc8afa5cb91bc81bdb4`: ten green, zero red, skipped, or invalid (`browser-10.launch.{log,status}` and `browser-10/`, with the export archive `browser-10.tar.gz`). The parent bcs173 commit had seven green and three shape A timeouts in its ten committed solos (`dev/v0109-team/tasks/task-Hygiene109-Lead109-10.md`); this comparison is observational under the guest contention.

Acceptance 1 is the mounted pin and its mutants; 2 is check 173 alone, ten green at the commit against the parent's three shape A reds in ten, and the review seat's interleaved pair below; 3 is `make web-check`.

In the review seat's guest, check 173's flow ran interleaved on the base's bundle and this commit's, one binary (`dev/v0109-team/evidence/Review109/otlbtm/`): shape A at the clicked-thumbnail wait 2 of 8 at the base and 0 of 8 here; the one-frame return to the previous slide after an End jump 1 of 10 readable base runs (3 of 8 in an earlier session) and 0 of 12 here; with a jump's mark standing, a programmatic scroll to the top left the clicked slide current in 4 of 4, and a press on the scroller first let the marker follow the viewport in 8 of 8; the scroller is `.cm-scroller`.

The touch and scrollbar legs: the mounted pin adds a `touchstart` on `view.scrollDOM` and a `pointerdown` on the scroller outside `contentDOM`, each after a jump to Slide 8 and followed by a forced bottom scroll that must mark Slide 10; the two listener-deletion mutants each made the named file red at its own new assertion (`expected 'Slide 8' to be 'Slide 10'`, 1 failed and 101 passed of 102; `dev/v0109-team/evidence/Hygiene109/otlbtm/fold-mutant-{touch,pointer}.launch.{log,status}`), and the unmutated file passed 102 of 102 with svelte-check clean at `8db747be07d8667592dc7c9c4f3c0e3c00cf1cfd`, a test-only amend of the code commit (`fold-green`, `fold-commit`).
