# A browser's Show opens a second window for a record that a desktop owns

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: landed on 2026-09-28 by the lead's ruling, which the owner confirmed on 2026-09-29 with no further build; raised for a decision on 2026-09-28 by the independent review of the rule of when a waiting window is on its page (`dev/v0101-team/reviews/review-Clients-11.md` in the development tree, finding 2, with the lead's notes): the code read, the two windows inferred, nothing run. The owner's ruling of 2026-09-27 that a Show from the launcher in a browser repairs a window before it un-hides it (recorded in [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md)) did not consider a record of native origin.

## Owner ruling

Confirmed on 2026-09-29, with no new decision to build. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to confirm the narrowing that had landed, with its cost noted. The narrowing is of the owner's own ruling of 2026-09-27 on Show, which made no exception: a browser's Show takes and repairs a window only for a record of a browser's origin, and for any other record it changes the visibility alone. Without it a browser opens a twin of a window that a desktop owns. What the narrowing leaves open is written as a cost under What shipped: Focus, Open and the workspace app's deck still take a window for any record.

## What was seen

A browser launcher's Show takes the named window and repairs it whenever the record does not read connected, with no look at the record's origin (`setWindowShown`, `web/packages/launcher/src/state/computerActions.ts:138-147`, the acquisition at `:144`; `openWindowRecord`, `web/packages/launcher/src/state/windowManager.svelte.ts:106-130`). The row's eye and the deck offer Show on every record the page may manage, native ones among them (`web/packages/launcher/src/components/WindowRow.svelte:212`; `src/components/CommandLauncher.svelte:143`, `:265-267`; `canManageWindow`, `computerActions.ts:119-121`); only the reconcile reads the origin (`reconcileWindows`, `windowManager.svelte.ts:180-183`). Before the rule a browser's Show changed the visibility and nothing else (`setWindowShown`, `computerActions.ts:138-145` at `cf105bb14`).

A desktop closes the native window of a record that the server holds hidden (`should_show`, `desktop/src-tauri/src/window_watcher.rs:233-239`; the reconcile, `:290-293`), so a window hidden on a desktop has a record that reads hidden and not connected.

The review's steps: a desktop connected to devserver D shows native window N, and the user hides N there. In a browser the user opens D's launcher and presses Show on N's row. `window.open("", N)` finds no window of that name, so a new browser window opens, waits and is navigated to N's page on D; then N's record is un-hidden and the desktop opens N again as well: two live clients on one window id. The code is read; that both windows open is inferred. Open and Focus did the same before the rule.

On 2026-09-28 the rule's fix round landed with the lead's ruling built. At `b39274a1a` a browser's Show takes and repairs a window only for a record of a browser's origin; on a record of native origin, or of no given origin, it changes the visibility and opens nothing (`setWindowShown`, `web/packages/launcher/src/state/computerActions.ts:138-150`, the rule at `:144-146`), pinned red first for both (`src/state/computerActions.test.ts:69-81`) and in the row's and the deck's tests, so the review's steps now reach the desktop's window alone (the desktop's side read in the review, not run). Open and Focus still take a window for any record: the row's Open and a Focus both go through `openWindowRecord`, which reads no origin (`src/state/windowManager.svelte.ts:127-155`; `focusComputerWindow`, `computerActions.ts:127-136`; `src/components/WindowRow.svelte:222`), and a Focus of a native record is pinned to take and repair its window and then un-hide it (`computerActions.test.ts:83-92`). So a Focus from a browser on N, hidden on the desktop, still opens a browser window beside the one the desktop opens once N is shown (inferred, as the review's steps are). What is left for the owner: whether the lead's narrowing of the owner's ruling on Show stands, and whether a Focus, which un-hides as a Show does, keeps taking a window for a record of native origin, as the lead's ruling keeps Open for a devserver's first terminal where no desktop is attached.

An origin test is not the whole answer: a devserver's first terminal is minted as a native record (`ensure_first_open_terminal`, `crates/chan-library/src/host.rs:2621-2632`, through `mint_window`, `:2478-2484`), and where no desktop is attached only a browser can open it, which is why the lead's ruling keeps Open as the gesture that acquires a window for any record.

## Desired contract

A browser's Show of a record that a desktop owns changes its visibility and opens no browser window beside the native one; a record that no desktop opens can still be opened from a browser by an Open.

## What to do

The owner decided on 2026-09-29 that the lead's ruling stands, though it narrows the owner's ruling on Show, and nothing is left to build. As ruled: `setWindowShown` acquires and repairs a window only for a record of a browser's origin, and for any other record changes the visibility alone; Open and Focus stay as they are. Red first: a Show on a record of native origin that does not read connected acquires no window.

## Boundaries

`web/packages/launcher/src/state/computerActions.ts` and its tests, and `web/packages/launcher/design.md`. Not the desktop, and not Open or Focus.

## Acceptance

1. A browser's Show on a record of native origin that does not read connected opens no window and un-hides the record, pinned red first.
2. A browser's Show on a record of a browser's origin repairs as it does now.
3. An Open of a record of native origin, a devserver's first terminal among them, still opens it from a browser.

## What shipped

Landed on 2026-09-28 with the fix round of the rule of when a browser window is on its page ([refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md)), as commit `84fed1e9a`, by the lead's ruling, which the owner confirmed on 2026-09-29. Lines at `4c4ada0a1`; read, not run. `setWindowShown` takes and repairs a window only when the record's origin is a browser's and the record does not read connected, and otherwise changes the visibility alone (`web/packages/launcher/src/state/computerActions.ts:138-150`, the rule at `:147`), pinned red first (`src/state/computerActions.test.ts:69-81`). The three acceptance points are met by that commit and its pins; that the desktop's window is then the only one is read in the review and not run.

**The cost, left open:**

- **The launcher's Focus and Open take a window for any record** (`focusComputerWindow`, `computerActions.ts:127-136`), and a Focus of a native record is pinned, on purpose, to take and repair its window (`computerActions.test.ts:83-92`). They are kept so that a devserver's first terminal, which is minted as a native record, can be opened where no desktop is attached. So a Focus from a browser on a window that is hidden on a desktop still opens a browser window beside the one the desktop opens (inferred, not run).
- **The workspace app's deck takes a window for any record too,** which this item's boundary did not name. It offers Show on a hidden window and Focus on a shown one, both through `focusLibraryWindow`, which reads no origin (`web/packages/workspace-app/src/api/libraryWindows.ts:222-262`; `src/components/CommandLauncher.svelte:383-389`), and the record it is handed carries no origin (`ScopedLibraryWindow`, `crates/chan-server/src/routes/library.rs:544-555`, built for every record of the library at `:653-663`). That a twin opens there is inferred; not run.
- **No item held these as its scope until 2026-09-30,** when they were raised as [focus-and-open-take-a-window-for-any-record](../v0.103.0/focus-and-open-take-a-window-for-any-record.md). Telling a desktop's window from a browser's needs a record that says who holds it, which is [a-connected-record-does-not-say-whose-socket](a-connected-record-does-not-say-whose-socket.md), accepted for v0.102.0, and the deck's record would need an origin.
