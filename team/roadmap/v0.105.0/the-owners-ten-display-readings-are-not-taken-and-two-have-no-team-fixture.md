# The owner's ten display readings are not taken and two have no team fixture

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

[the-owners-display-readings-need-a-checklist](../done/the-owners-display-readings-need-a-checklist.md) shipped in part in v0.104.0. The checklist exists, with its fixtures, drivers and exact steps (`dev/v0104-team/reports/checklist-owner-readings-v0.104.0.md`, 222 lines, sha256 `adf9baf71416282ea58732342e816d65eff7d6cdea71ca76c1959cf7f26f3f7c` as measured on 2026-10-09), and none of its ten readings was taken at the cut. The release report says so in its status line and under Partial, Validation, Follow-ups and Known gaps (`team/release/release-v0.104.0.md`), and the checklist's first paragraph says "Nothing below is marked taken."

The ten readings, in the checklist's order (its table "At a glance"): 1, a hide made on the connecting page; 2, a Reload that found its target not ready while another desktop holds the window; 3, the recovery entry after a desktop restart; 4, a repeated element id reloaded twice within a second; 5, the owner's deck as a PDF, every image; 6, the printed line that opens the devserver; 7, the desktop's probe and a gateway 404; 8, a drawing's picture in an exported PDF; 9, `cs export` of the deck that hung; 10, pending edits at a hide on WKWebView or WebView2.

Six inputs are the owner's to name before starting (the checklist's line "The owner names before starting"): the original drawing document, the deck that hung, the deck for reading 5, the usual window arrangement, the VM, and the engine for reading 10. Readings 5, 8 and 9 cannot start without the first three (the closed item's section "The connecting-page driver; the checklist assembled 2026-10-08").

Two readings have no team fixture (the same table and the checklist's sections 2 and 7): reading 2 needs two desktops on one window of one devserver and a way to cut one of them off, and reading 7 needs a devserver published through the real gateway. The checklist tells the owner to record `unavailable` for each unless the owner has the arrangement.

What the team's runs are: a record that the steps reach a reading on Linux WebKitGTK 2.52.6 with debug builds, and never the reading (the closed item's "Team runs 2026-10-08"; each "Team's record so far" line of the checklist). Readings 1, 3 and 4 were reached and held there. For readings 8 and 9 the export wrapper exported the generated controls and no picture was read in any PDF. For readings 2, 5, 6, 7 and 10 the checklist records no team run. Three limits the checklist states beside those runs: reading 3's run ended the desktop with a TERM signal and not its own Quit, and the relaunch showed no workspace window until the workspace was served again; no run of reading 4 placed a reload between the board's first push and its flush; and a pass of reading 10 by hand is inconclusive for its premise, since a hand cannot show the hide fell inside the edit's wait.

The checklist names the first candidate: commit `84f831661b1f01cb0fac24da9d67629a67dcb696` on the branch `0.104.0-rc0` and the artifacts of its `publish=false` Release dry run (the checklist's "Candidate" paragraph and "The candidate's artifacts"). The tree that shipped is the GA commit, which adds two animations, tuned defaults and the version pin on top of that candidate (the release report's status line); the checklist does not name the released builds.

Not established: every one of the ten readings. The release report's Known gaps: "The Linux fixture runs do not answer the owner's display questions." Nothing was taken on macOS WKWebView or Windows WebView2. The owner readings of the frontend review's remainder are outside the checklist by its own last section and are a scope question for the owner, not part of this item.

## Desired contract

Each of the ten readings has a result recorded by the owner's word (passed, failed, inconclusive or unavailable) with its engine and arrangement, kept apart from the team's fixture reach, and a reading the owner cannot arrange is recorded unavailable with its reason and is not replaced by a fixture run. For readings 2 and 7 the item asks for a decision: the team builds an arrangement, the owner supplies one, or they stay unavailable.

## What to do

The next step is the owner's: name the six inputs, choose the engine for reading 10 and say which builds the readings are taken on. The lead then reissues the checklist against those builds, replacing the candidate's commit and artifact hashes with measured ones. The owner takes the readings; each result is written by the checklist's `record` line or told to the lead in words. A failed reading is filed as a roadmap item of its own with the reading's record. For readings 2 and 7, say from a source read whether the team can build the arrangement in its guests before building anything; reading 7 meets the boundary recorded on [a-gateway-connections-windows-across-a-devserver-restart-are-unobserved](a-gateway-connections-windows-across-a-devserver-restart-are-unobserved.md), where the stock desktop reaches no guest-made gateway.

## Boundaries

The checklist text and the results, in the round's reports and the release report. `scripts/e2e/desktop-observations/` for a fixture correction that a reading turns up (`OWNER-CHECKS.md`, `owner-fixtures.py`, `owner-controls.sh`, `owner-export.sh`, `owner-connecting-hide.sh`). No product change in this item, and the team marks nothing taken.

## Acceptance

1. The six owner inputs are named in the record, or each missing one is listed with the readings it blocks.
2. The checklist names the builds the readings are taken on, with hashes measured from those files.
3. Each of the ten readings has one result recorded by the owner's word, with its engine and arrangement; an `unavailable` carries its reason.
4. Readings 2 and 7: the decision is recorded (a team arrangement, the owner's arrangement, or unavailable); if the team builds one, one team run shows the steps reach the reading, and that run is not the reading.
5. Every failed reading has a roadmap item of its own, linked from the record.
6. The release report of the version that closes this item states the owner's results apart from fixture reach.
