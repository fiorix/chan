# Graph bodies have no mounted test

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's residuals, recorded by the v0.100.0 item `a-duplicate-list-key-kills-its-panel`. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended, to be built after [source-text-tests-pin-spelling-not-behaviour](source-text-tests-pin-spelling-not-behaviour.md), since both change the same test files. That item has landed, and with it the graph's mount in the test harness, so this item waits on nothing; what is left of it is below.

## What was seen

Graph instance identity and keying are covered by source-pattern checks only: the mounted keep-alive suite excludes graph bodies because their canvas dependency cannot run in that harness, so a remount or missing-key defect in the graph would pass every current test.

**Read again at `4c4ada0a1` on 2026-09-29;** read, not run. The premise above no longer holds: the graph mount exists since `97f058d05`, which landed with [source-text-tests-pin-spelling-not-behaviour](source-text-tests-pin-spelling-not-behaviour.md). `components/GraphPanel.keepAlive.test.ts` mounts a pane of two graph tabs over a stand-in canvas and asserts across a switch that a panel is "the same element, not a remount" (`web/packages/workspace-app/src/components/GraphPanel.keepAlive.test.ts:84-99`), `GraphCanvas.svelte.test.ts` mounts the real canvas on a recording 2D context, and the pane's block of graph tabs is keyed (`components/Pane.svelte:1920`). What is left: no case reorders graph tabs and then compares which instance sits where, as the suite of file and dashboard tabs does (`survivesSwitch`, `components/paneKeepAliveMount.test.ts:190-219`, run at `:222` and `:229`), so a missing key would pass the graph's present suite (inferred); that suite still leaves graph tabs out, with a header comment that says why and no longer holds (`:12-14`); and the two reds that What to do asks for, a body mounted only while it is active and the key removed from the pane's block, are not on record. The lane that built the mount showed two other mutations red, a close that targets the active tab and `active` forced true (`dev/v0101-tasks/report-rawb-2.md` in the development tree).

## What to do

Establish a working graph mount in the test harness, then show its regression checks fail for a remount and for a missing key.

## What shipped

The build is on the integration branch and not on `main`: two test-only commits, accepted on 2026-10-01, in `web/packages/workspace-app/src/components`, with no production line. The graph suite gains the case the reading above found missing: two graph tabs mounted over the stand-in canvas, the second switched to, then reordered, with each panel asserted to have moved with its tab (`GraphPanel.keepAlive.test.ts:101-116`); the case lives in the graph suite because the stand-in canvas is already there. The suite of file and dashboard tabs keeps graph tabs out, and its header comment now says that the graph suite covers them across a switch and a reorder (`paneKeepAliveMount.test.ts:12-14`).

The two reds that What to do asks for are on record, each with the saved and restored hash of `Pane.svelte`: with the key removed from the pane's block of graph tabs the case fails at "the second tab brings its panel forward", and with a body mounted only while its tab is active it finds one panel where it expects two. The web gate was green at the tip. Residual: a mounted jsdom check, no painted graph.
