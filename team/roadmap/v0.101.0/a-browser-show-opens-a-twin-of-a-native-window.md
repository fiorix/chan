# A browser's Show opens a second window for a record that a desktop owns

Status: raised for a decision on 2026-09-28 by the independent review of the rule of when a waiting window is on its page (`dev/v0101-team/reviews/review-Clients-11.md` in the development tree, finding 2, with the lead's notes): the code read, the two windows inferred, nothing run. The owner's ruling of 2026-09-27 that a Show from the launcher in a browser repairs a window before it un-hides it (recorded in [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md)) did not consider a record of native origin. Recommendation, as the lead's notes have it: accept the lead's ruling, which the rule's fix round builds (`dev/v0101-team/tasks/task-Lead-Clients-24.md`, ruling 2): a browser's Show acquires a window only for a record of a browser's origin, and for a record of native origin it changes the visibility and nothing else, as before the rule; Open and Focus are not changed.

## What was seen

A browser launcher's Show takes the named window and repairs it whenever the record does not read connected, with no look at the record's origin (`setWindowShown`, `web/packages/launcher/src/state/computerActions.ts:138-147`, the acquisition at `:144`; `openWindowRecord`, `web/packages/launcher/src/state/windowManager.svelte.ts:106-130`). The row's eye and the deck offer Show on every record the page may manage, native ones among them (`web/packages/launcher/src/components/WindowRow.svelte:212`; `src/components/CommandLauncher.svelte:143`, `:265-267`; `canManageWindow`, `computerActions.ts:119-121`); only the reconcile reads the origin (`reconcileWindows`, `windowManager.svelte.ts:180-183`). Before the rule a browser's Show changed the visibility and nothing else (`setWindowShown`, `computerActions.ts:138-145` at `cf105bb14`).

A desktop closes the native window of a record that the server holds hidden (`should_show`, `desktop/src-tauri/src/window_watcher.rs:233-239`; the reconcile, `:290-293`), so a window hidden on a desktop has a record that reads hidden and not connected.

The review's steps: a desktop connected to devserver D shows native window N, and the user hides N there. In a browser the user opens D's launcher and presses Show on N's row. `window.open("", N)` finds no window of that name, so a new browser window opens, waits and is navigated to N's page on D; then N's record is un-hidden and the desktop opens N again as well: two live clients on one window id. The code is read; that both windows open is inferred. Open and Focus did the same before the rule.

An origin test is not the whole answer: a devserver's first terminal is minted as a native record (`ensure_first_open_terminal`, `crates/chan-library/src/host.rs:2621-2632`, through `mint_window`, `:2478-2484`), and where no desktop is attached only a browser can open it, which is why the lead's ruling keeps Open as the gesture that acquires a window for any record.

## Desired contract

A browser's Show of a record that a desktop owns changes its visibility and opens no browser window beside the native one; a record that no desktop opens can still be opened from a browser by an Open.

## What to do

The owner decides whether the lead's ruling stands, since it narrows the owner's ruling on Show. As ruled: `setWindowShown` acquires and repairs a window only for a record of a browser's origin, and for any other record changes the visibility alone; Open and Focus stay as they are. Red first: a Show on a record of native origin that does not read connected acquires no window.

## Boundaries

`web/packages/launcher/src/state/computerActions.ts` and its tests, and `web/packages/launcher/design.md`. Not the desktop, and not Open or Focus.

## Acceptance

1. A browser's Show on a record of native origin that does not read connected opens no window and un-hides the record, pinned red first.
2. A browser's Show on a record of a browser's origin repairs as it does now.
3. An Open of a record of native origin, a devserver's first terminal among them, still opens it from a browser.
