# The file browser's New and Paste rows and the launcher's commands of those titles choose different folders

Status: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 the same day, at v0.130.0's planning; not started. Which rule the row and the command share is his to decide (the section Desired contract).

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

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`, point 2) on 2026-11-14: "As you recommend, the upload rule."

- The rule is Upload's, as `uploadDir()` (`FileTree.svelte`) holds it: the menu row's rule, except that a tree with nothing selected takes the default create directory, which in a standalone window is home and not the filesystem root. One function for the three titles, reading the selection's kind from the entry and not from the visible rows.
- A list keeps "the folder shown" even with a directory row selected. With no file browser surface at all, the launcher's `New` takes the default create directory, as now.
- The collapsed-parent case of finding 6 is taken here: the selection's kind is read from the entry, and a target's ancestors are expanded when something lands in it.
- Built after the launcher's surface row, which edits the same files. The tests add the standalone tree and the collapsed parent; the manual's Files page says the rule in the code's words.

## Built, 2026-11-15

New, Paste and Upload share `FileTree.targetDirectory`: a list's displayed folder, a tree's selected directory or selected file's parent, and the default create directory for an empty tree (workspace root or standalone home). The launcher's New and Paste dispatch to the command surface, as Upload does, so the surface supplies its own location without duplicating that state in the selection registry. New without a browser surface keeps the default. The selected entry supplies its kind even under a collapsed parent. Paste captures its selection and instance before the transfer, reveals ancestors only in that same surviving instance, and selects the landed entries in the captured selection. File creation also reveals its ancestors. Entry-specific New and Upload retain their explicit targets. The manual's Files page and the workspace app design document describe these rules.

The mounted component tests drive the real surfaces and command catalog through list/tree, empty/directory/file selection, standalone and collapsed-parent cases. The corrected baseline failed ten destination assertions (`dev/v0131-team/evidence/Web131/newpaste/unit/red-destinations-2.log`, native exit 1); the dedicated file-reveal baseline failed the ancestor-expansion assertion (`red-new-file-landing-2.log`, exit 1, 58 other tests skipped). The restored destination suite passed all 74 tests, the existing pane command suite passed 36, and the create suite passed ten (`green-final.log`, `pane-commands-green.log`, `store-create-final.log`, each exit 0 in the same directory). Thirteen distinct source mutations were killed by the intended assertions across sixteen executions (`mutations/` and `mutations-r2/`). The first captured-selection mutation survived; a mounted-Pane tab-switch regression killed the same mutation. No survivor remains. Directory creation has component and browser coverage, without a separate directory-create mutation.

Browser check 251 was run with the same final harness against base `ee0f67fdddb84832ea510c542844ba3b6ea59437` and product `87d551c4ec1b108bde16350d4c38696a8260f4eb`. The base failed the intended `list-none-launcher: New uses the destination folder` assertion (empty prompt instead of the listed folder); the tip passed, then checks 163, 196 and 251 passed together, with zero skips (`dev/v0131-team/evidence/Ops131/J160/{base-251,tip-251,tip-neighbors}.console.log` and their `.rc` files: 1, 0 and 0). Results, destination observations, timelines and screenshots are in the adjacent `newpaste-251-{base,tip,neighbors}-J160/` directories. Upload and Paste assert physical destinations and exact bytes; nested directory creation asserts ancestor reveal. Other New arms inspect the prompt and cancel, including standalone home. Standalone selected-directory/file and hidden-selection cases are component coverage; an empty-selection Paste browser arm uses the native keyboard shortcut. The guest source overlays were restored to their recorded clean states.

The product commit's scoped frontend and marketing gates passed (`dev/v0131-team/evidence/Ops131/J75/web-check.log` and `web-marketing-check.log`, native exit 0); the final harness commit's gate and range review are recorded in the round hand-back. The harness uses a revisioned workspace dock preference write to avoid the separately recorded stale-workspace-response race, and native standalone dock controls with waits for the actual child listing. Both successful browser timelines contain one standalone command-capability HTTP 403 before the main window socket opens. The unchanged capability client retries this liveness failure; the timing supports that explanation, but the response body and successful retry were not recorded. These runs are not claimed to be free of HTTP errors. No desktop, macOS or Windows reading was made for this row.
