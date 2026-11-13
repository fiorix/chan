# The file browser's New and Paste rows and the launcher's commands of those titles choose different folders

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started. Which rule the row and the command share is his to decide (the section Desired contract).

Record: reported by the independent review of v0.129.0's file-action changes (`dev/v0129/reviews/review-deckfiles-1.md`, finding 3), the changes that made the launcher's `Upload` and the file browser menu's `Upload` row one function on the owner's ruling. Put to him as a candidate for the next version, he answered: "2. new and pase: good, item for next version is correct".

## What is there now

In a file browser the menu's `New` and `Paste` rows choose their folder with `pasteTargetDir` (`web/packages/workspace-app/src/components/FileTree.svelte`): the directory a list shows; in a tree the selected directory, the selected file's directory, or the tree's root with nothing selected. The launcher's `New file or directory` and `Paste` choose with `targetDirFromSelection` (`web/packages/workspace-app/src/state/commands/browser.ts`): the selected directory, the selected file's directory, or the default create directory with nothing selected, whatever the view shows. Since v0.129.0 the launcher's `Upload` runs the menu row's choice, so in one state the launcher's `Upload` and its `New` can pick different folders.

## Evidence

The review's run in a guest (`dev/v0129/evidence/deckfiles/review-1/run-1/`), in a Files tab:

- Listing `notes` with nothing selected, the row's prompt starts at `notes/` and the launcher's `New` at the workspace root.
- With `notes/sub` selected, the row starts at `notes/` and the command at `notes/sub/`.

`Paste` disagrees the same way, from reading. Related, low, from reading (the review's finding 6): `pasteTargetDir` reads whether the selection is a directory from the visible rows, so a selected directory hidden under a collapsed parent counts as a file and the row's target is its parent; the `New` and `Paste` rows did so before v0.129.0.

## Desired contract

1. The menu row and the launcher command of one title choose one folder in every view and every selection, through one function, as `Upload` does since v0.129.0.
2. Which rule that is, the owner's. The default this row proposes, by the parallel with his `Upload` ruling ("Into a directory": both into the directory in context, as the menu does and as `New` and `Paste` choose their target): the menu row's rule.

## Boundaries

- The file browser's `New` and `Paste` rows and the launcher's `New file or directory` and `Paste`, in the workspace app; the manual's Files page where it states either. The collapsed-parent case of finding 6 can be taken with it.
- Not here: which file browser surface the launcher's selection commands act on (they follow the surface focused last, which a press on another pane's tab label does not move), a candidate the owner has not ruled on.

## Acceptance

1. Tests that drive the real components and commands, in a list view and in a tree, with nothing selected, a directory selected and a file selected: the row and the command reach one folder in each, red on today's code where they differ.
2. The manual says where `New` and `Paste` put what they make, in the words the code holds.
