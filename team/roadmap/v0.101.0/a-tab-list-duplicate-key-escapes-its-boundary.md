# A duplicate key in a tab list escapes the per-tab boundary

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's residuals, recorded by the v0.100.0 item `a-duplicate-list-key-kills-its-panel`. A source reading against `main` at `6237c2677`.

## What was seen

Each pane body renders inside its own `<svelte:boundary>` (`web/packages/workspace-app/src/components/Pane.svelte:1773`, `:1798`, `:1853`), but a duplicate key raised while evaluating the enclosing tab list is outside them. It reaches the outer pane-body boundary and unmounts every body in the pane, and removing the cause does not reset that boundary until the user chooses Try again. The tab strip and its label computations sit outside both boundaries.

## What to do

Key the tab list so a duplicate cannot arise, or place a boundary that resets itself around the list evaluation, with a mounted test that raises a duplicate and shows the other tabs survive.
