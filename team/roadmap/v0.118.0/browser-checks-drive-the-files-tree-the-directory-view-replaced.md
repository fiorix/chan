# Browser checks drive the Files tree the directory view replaced

Status: accepted for v0.118.0 by the owner's survey answer of 2026-10-31 (the section Owner's decision), not started: the twenty-three checks migrate to the directory view through one shared open-by-path helper. Raised at the v0.117.0 GA on 2026-10-31 from the whole browser suite's run against the release tree in the Linux sdme guest.

## What was asked

Nothing was asked yet; this is a finding of the cut. The Files tab shows one directory at a time since v0.117.0 (the item [the-file-browser-shows-a-tree-with-no-directory-navigation-or-keyboard-model](../done/the-file-browser-shows-a-tree-with-no-directory-navigation-or-keyboard-model.md)), and its builder recorded that the browser suite's tree selectors were not migrated and the suite was not run on the branch.

## Evidence

The whole browser suite at the merged release tree in the guest (Ubuntu 26.04, Chrome 156): 103 checks ran, 72 green, 90-launcher-gateways skipped for the missing marketing dist, 30 red. Twenty-three of the reds wait on the tree the Files tab no longer renders, `[role="treeitem"]`, `[role=tree]` or `.browser [role="tree"]`, in the check itself or in `lib/drafts.mjs` (lines 407 and 414): 100, 101, 102, 103, 106, 110, 111, 112, 123, 126, 130, 132, 133, 163, 164, 179, 20, 21, 22, 40, 50, 80 and 98. Each opens a File Browser tab with `app.files.toggle` and clicks a tree row to open a file or to read the selection, and fails at that step, before its own subject (the editor, graph, drafts, inspectors, collaboration and root-loss checks among them). Of the other seven reds, 60, 95, 125 and 131 are red alone at `main` before the release, 195 is the tmux browser row, 107 is green alone, and 170 is red alone at its precondition, which expects the status pill to cover the file browser's Details close button and finds the button clear under the Files tab's new inspector: a precondition of the old layout, to be read again against the new one with the migration.

## Desired contract

The suite drives the Files tab as the product now presents it: a directory listing with breadcrumbs, a path field and a filter, with a docked browser keeping the tree. One shared helper opens a file by path from a Files tab (entering directories through the breadcrumbs or the path field, then the row), replacing the per-check tree walks, and `lib/drafts.mjs` reads the Drafts group where the directory view shows it.

## Acceptance

1. The twenty-three checks above pass alone and in the whole suite in the Linux guest against the release tree or later.
2. The suite's reds are the ones recorded at `main` and no other.

## Owner's decision, 2026-10-31

Surveyed in the owner's window on 2026-10-31 with three options: migrate the twenty-three checks to the directory view; point the checks at a docked browser, which keeps the tree; defer to v0.119.0. The answer, in the survey's words: "1 Migrate the 23 checks to the directory view (recommended)". So the Desired contract stands as written: one shared helper opens a file by path from a Files tab (the breadcrumbs or the path field, then the row) and replaces the per-check tree walks, `lib/drafts.mjs` reads the Drafts group where the directory view shows it, and check 170's precondition is read again against the new inspector with the migration.
