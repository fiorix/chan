# The file browser menu's Paste lands in the selection's folder, not the right-clicked folder

Status: accepted for v0.132.0 by the owner on 2026-11-17, by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"); not started.

Record: item 4 of `dev/v0131-team/reports/owner-candidates-2.md`, from the independent review of the New and Paste work (`dev/v0131-team/reviews/review-newpaste-1.md`, note 1), which found it pre-existing and outside that row's contract. [The New and Paste row](../done/the-file-browsers-new-and-paste-rows-and-the-launchers-commands-choose-different-folders.md) made the menu row, the chord and the launcher's Paste share one folder rule; none of them reads the row the menu was opened on. Nothing is lost: the paste lands in a folder the user did not point at.

## What is there now

Read at `b73773a93`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- A right-click on a tree or list row opens the entry menu with that row as `menu` (`components/FileTree.svelte:659-666`, `showMenu`, called from the rows at `:1413` and `:1525`) and does not move the selection.
- The menu's other rows act on the clicked row: Copy and Cut take it when it is outside the selection (`:956-960`), the New row for a directory starts inside that directory (`:1598-1603`, `newFileOrDir(menu!.path)`), the Upload row replaces the clicked file (`:1614-1618`), and Rename, Delete, Copy path, Download, New terminal here and the per-type rows read `selected`, which is the clicked row while the menu is open (`:926`).
- The menu's Paste row runs `runCommand("paste")` (`:1622`), which calls `pasteIntoTarget()` (`:962`, `:1075-1092`), which reads `targetDirectory()` (`:1064-1070`): in a list, the folder the list shows; in a tree, the selected directory, the selected file's parent, or the default create directory with nothing selected. The clicked row plays no part. In a tree with `notes/a.md` selected, a right-click on `notes/sub` and Paste lands in `notes`; in a list showing `notes`, a right-click on the folder row `notes/sub` and Paste lands in `notes`.
- The chord and the launcher's Paste go through the same `targetDirectory()` (the launcher's through the `chan:command` dispatch, `components/FileBrowserSurface.svelte:133-146`), where no row is clicked. The manual (`web/packages/marketing/src/pages/manual/files.html:40`) and `design.md:233` describe that one rule and say nothing of the right-clicked row. The destinations suite's menu arm anchors the menu on the selected entry, so the two agree there (`components/FileBrowserSurface.destinations.test.ts:141-150`, the comment at `:147`); no case right-clicks a row outside the selection.

## Desired contract

1. The entry menu's Paste lands in the clicked row's folder: the row itself when it is a directory, its parent when it is a file, in a tree and in a list alike, as the same menu's New row for a directory starts there and its Copy and Cut take the clicked row.
2. The chord and the launcher's Paste keep the shared rule: a list's folder shown, a tree's selected directory or selected file's parent, the default create directory with nothing selected.
3. What lands is selected and revealed through its ancestors in the same surface, as today, and a paste refused by an occupied name stays refused as today.

## Boundaries

- The Paste row and `pasteIntoTarget` in `components/FileTree.svelte`, taking an explicit destination, with their tests; `fbClipboardPaste` and the transfer route stay as they are.
- The empty-area right-click reaches the surface's own menu (`components/FileBrowserSurface.svelte:328`), which stays as it is.
- The manual's Files page and `design.md` where they state the folder rule.

## Acceptance

1. Mounted tests over the real surface, red at the base: in a tree with a file selected, a right-click on a sibling directory then Paste lands in that directory; a right-click on a file outside the selection then Paste lands in that file's parent; in a list showing `notes`, a right-click on the folder row `notes/sub` then Paste lands in `notes/sub`. The chord and the launcher's Paste keep today's destinations: the destinations suite stays green.
2. Making the menu's Paste read `targetDirectory()` again turns the clicked-row cases red, and restoring it turns them green.
3. A browser check in a guest's Chrome, and the same in chan-desktop on WebKitGTK in the desktop guest: copy a file, right-click a folder row in a Files tab, Paste; the file is found in that folder on disk and the landed entry is selected.
4. The manual's Files page (`files.html:40`) and `design.md:233` say that the menu's Paste follows the clicked row and the chord and launcher the shared rule.

## Accepted, 2026-11-17

The owner accepted this row by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"). The choice the draft left to him is taken as the draft recommended: option (a), Paste lands in the clicked row's folder with the selection untouched. He may revisit it before the build. The options as drafted:

- (a) Paste lands in the clicked row's folder, the selection untouched (recommended: matches the menu's own New, Copy and Cut, and desktop file managers).
- (b) A right-click selects the row first, as a left click does, so every menu row acts through the selection. Changes the selection on every right-click, which the Copy and Cut rows today deliberately avoid (`:956-960`).
- (c) Leave as is and have the manual say the menu's Paste follows the selection.

## Built, 2026-11-17

The menu's Paste takes the clicked row's folder - the row itself for a directory, its parent for a file, in a tree and in a list alike - while the chord and the launcher's Paste keep the shared `targetDirectory` rule. Built on `v0132/fbpaste` and merged into `v0132/int` as `e3a300af7`: the paste destination rule in `FileTree.svelte`, check 232 in Chrome, the `fbpaste-native` desktop driver pair, the manual sentence (`files.html:40`, keys named), and `design.md:233`.

Acceptance 1: the three clicked-row cases in `FileBrowserSurface.destinations.test.ts` ("right-click on a sibling directory pastes there, selection untouched", "right-click on a file outside the selection pastes into its parent", "right-click on a folder row in a list pastes into that folder") fail at the base and pass at the tip; the suite passes 77 at `7ad836d76`. Red log `dev/v0132-team/evidence/Input132/fbpaste-1/red.log`.

Acceptance 2: making the menu's Paste read `targetDirectory` again turns those three cases red, and restoring it turns them green (`dev/v0132-team/evidence/Input132/fbpaste-1/mutation-red.log`); the product logic is unchanged since `42f818d28`.

Acceptance 3: check 232 passes in Chrome (J58 at `81c0f8679`, `ALL GREEN`); the `fbpaste-native` driver passes on WebKitGTK at the tip (J81 at `7ad836d76`, twelve `ok` lines and `PASS`) and faults at the base on the two property lines (`FAIL landed on disk absent`, `FAIL landed entry selected absent`, `exitCode: 10`). Records under `dev/v0132-team/evidence/Ops132/J58/` and `dev/v0132-team/evidence/Ops132/J81/`.

Acceptance 4: the manual's Files page and `design.md:233` say the menu's Paste follows the clicked row and the chord and launcher the shared rule.

What the WebKitGTK leg does not exercise: it enters at a dispatched `contextmenu` event with a synthesized click, so the pointer press through the engine, the engine's own context menu being suppressed, and a trusted click are read on Chrome (check 232's pointer events) and by a person, not by this driver; no handler on the path reads `isTrusted`.
