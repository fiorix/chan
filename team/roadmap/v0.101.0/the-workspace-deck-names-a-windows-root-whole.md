# The workspace app's command deck names a window on a Windows host by its whole root

Status: raised for a decision on 2026-09-28 by the lead, from the docs drafter's reading at the landing before this one, which found it beside that landing's items and wrote it nowhere (`dev/v0101-team/int34-docs/docs-draft-handback.md` in the development tree, "Found beside, for the lead", its first two bullets). Read again at `d440ab656`, where no file of `web/` differs from that landing's; not run, and nothing was run on Windows. Recommendation, the lead's: accept for v0.101.0 as a small order in the workspace app: the deck names a window's workspace by the last component of its path under either separator.

## What was seen

- **The workspace app's deck names a window's workspace by the window's path cut at `/` alone.** It reads no label: a workspace window's context, which the window's row shows in its breadcrumb and matches in its search text, is the last part of the record's path after a `/` (`scopedWindowContext`, `web/packages/workspace-app/src/components/CommandLauncher.svelte:310-314`, used at `:361-372`). The record's path is the root its registry row stores, spelled as the host spells it. On a Windows host that root holds `\` and no `/`, so the cut leaves it whole and the breadcrumb ends in the whole root, read and not run.
- **The launcher's deck names the same window by its row's label,** and cuts at `/` alone only for a window whose workspace has no row (`windowContext` and `workspaceName`, `web/packages/launcher/src/components/CommandLauncher.svelte:104-106`, `:132-138`; `rootName`, `web/packages/launcher/src/lib/windowLabel.ts:14-21`). The server gives a row with no label of its own its root's last component by the host's path rules (`workspace_label`, `crates/chan-server/src/routes/library.rs:1703-1708`, used at `:708-711`; `crates/chan-server/src/devserver.rs:3269-3274`). So on a Windows host the two decks name one window two ways.
- **The two design documents name the other case.** Each says that a Windows root with no label reads whole in the deck (`web/packages/workspace-app/src/design.md:99`, of the deck's list of workspaces, `CommandLauncher.svelte:492-493`; `web/packages/launcher/design.md:192`). A row's label is empty only when its root has no last component, or, from the launcher's routes, one that is not UTF-8 (`routes/library.rs:1703-1708`), where any cut reads a root whole; neither document names the window's context, which reads every Windows root whole.

## Desired contract

The workspace app's deck names a window's workspace as the launcher's deck does, by the label of the row that lists it, and the design documents say which surface cuts a root where and when a root reads whole.

## What to do

A suggestion beyond the record: the deck looks the window's workspace up among the workspaces its snapshot holds, by the path the row lists it at, and names it by that row's label, falling back to a cut of the path when no row lists it; settle in the plan which cut the fallback makes, since a cut at `\` misreads a Unix root whose last directory holds one (`web/packages/workspace-app/src/design.md:99`). Red first: a window whose record stores a Windows root, beside a row of that root with a label, shows the label in the deck; today it shows the whole root.

## Boundaries

`web/packages/workspace-app/src/components/CommandLauncher.svelte` (`scopedWindowContext`) and its tests, `web/packages/workspace-app/src/design.md` and `web/packages/launcher/design.md`. The server's labels are unchanged.

## Acceptance

1. A window on a Windows host whose workspace has a labelled row is named by that label in the workspace app's deck, pinned red first.
2. The two design documents say what each deck shows for a window and for a row, and when a root reads whole.
