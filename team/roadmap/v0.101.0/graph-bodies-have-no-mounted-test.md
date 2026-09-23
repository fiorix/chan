# Graph bodies have no mounted test

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's residuals, recorded by the v0.100.0 item `a-duplicate-list-key-kills-its-panel`. A source reading against `main` at `6237c2677`.

## What was seen

Graph instance identity and keying are covered by source-pattern checks only: the mounted keep-alive suite excludes graph bodies because their canvas dependency cannot run in that harness, so a remount or missing-key defect in the graph would pass every current test.

## What to do

Establish a working graph mount in the test harness, then show its regression checks fail for a remount and for a missing key.
