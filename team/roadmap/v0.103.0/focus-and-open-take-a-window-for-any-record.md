# The launcher's Focus and Open, and the workspace app's deck, take a window for any record

Status: accepted for display observation; a product repair is conditional on confirmed duplication.

## Owner decision, 2026-10-06

Observe the browser launcher and workspace deck with a hidden native window before changing behavior. The owner does not recall seeing duplication in practice. If confirmed, make Focus target the actual holder and retain an explicit browser Open path when no desktop owns the window. Decide exact Open behavior from the observation; preserve opening a devserver's first terminal in a browser without a desktop.

## Record before this decision

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, still raised for a decision: the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Record before the move: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29. It is the cost left open by [a-browser-show-opens-a-twin-of-a-native-window](../done/a-browser-show-opens-a-twin-of-a-native-window.md), written under that item's What shipped, which no item held as its scope. On 2026-09-29 the owner confirmed the narrowing of a browser's Show as it landed, with this cost noted; the question put with it, whether Focus keeps taking a window for a record of native origin, was answered by that confirmation of what is built, and the change remained open until the owner's 2026-10-04 carry ruling. Read at `4c4ada0a1` by a reading of the ledger on 2026-09-29 (`dev/v0101-team/machine-move/lead38-recon-8-raised-older-a.md` in the development tree, entry 4); the code was read, that a second window opens is inferred, and nothing was run. Ruled on 2026-10-03: see Owner ruling. On 2026-10-04 the owner carried it as raised, with a display reading of Focus from a browser's launcher and from the deck before a build decision.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: Focus and Open stay as they are, and the question is decided again when [a-connected-record-does-not-say-whose-socket](../done/a-connected-record-does-not-say-whose-socket.md) lands. On 2026-10-04, after the desktop's holder tags landed, the owner carried this item as raised: first read on a display what happens when a desktop and browser share one devserver, a window is hidden on the desktop, and Focus is used from the browser's launcher and from the deck. A second window is still inferred and has not been seen; the holder list is now present for a later build to read.

## What was seen

Lines at `4c4ada0a1`, as that reading gives them.

- **The launcher's Focus and Open take a window for any record** (`focusComputerWindow`, `web/packages/launcher/src/state/computerActions.ts:127-136`), and a Focus of a native record is pinned, on purpose, to take and repair its window (`web/packages/launcher/src/state/computerActions.test.ts:83-92`). They are kept so that a devserver's first terminal, which is minted as a native record, can be opened where no desktop is attached. So a Focus from a browser on a window that is hidden on a desktop still opens a browser window beside the one the desktop opens; inferred, not run.
- **The workspace app's deck takes a window for any record too.** It offers Show on a hidden window and Focus on a shown one, both through `focusLibraryWindow`, which reads no origin (`web/packages/workspace-app/src/api/libraryWindows.ts:222-262`; `web/packages/workspace-app/src/components/CommandLauncher.svelte:383-389`), and the record it is handed carries no origin (`ScopedLibraryWindow`, `crates/chan-server/src/routes/library.rs:544-555`, built for every record of the library at `:653-663`). That a twin opens there is inferred; not run.

The reading takes the trigger to be uncommon: a desktop and a browser on one devserver, and a window hidden on the desktop. It recommended leaving Focus and Open as they are in v0.101.0 and carrying this to v0.102.0 with [a-connected-record-does-not-say-whose-socket](../done/a-connected-record-does-not-say-whose-socket.md), since telling a desktop's window from a browser's needs a record that says who holds it, and the deck's record would need an origin.

Not established: the second window on a display, from the launcher or from the deck.

## Desired contract

Not written yet. The item above asks that a browser's Show of a record that a desktop owns open no browser window beside the native one, and that a record no desktop opens can still be opened from a browser by an Open; what Focus and the deck should do is the owner's to rule.

## What to do

Decide. The alternative that was put to the owner, a Focus that also stops taking a window for a native record, needs an answer for a devserver's first terminal where no desktop is attached. It is decided with [a-connected-record-does-not-say-whose-socket](../done/a-connected-record-does-not-say-whose-socket.md).

## Boundaries

By the reading's citations: `web/packages/launcher/src/state/computerActions.ts`, `web/packages/workspace-app/src/api/libraryWindows.ts` and `components/CommandLauncher.svelte`, and the scoped record in `crates/chan-server/src/routes/library.rs`, with their tests. A browser's Show is [a-browser-show-opens-a-twin-of-a-native-window](../done/a-browser-show-opens-a-twin-of-a-native-window.md)'s, landed.

## Acceptance

1. The owner's ruling is recorded: what a browser's Focus and Open, and the workspace app's deck, do for a record that a desktop owns.
2. If it is built: each gesture that the ruling changes has a pin, red first, and an Open of a devserver's first terminal where no desktop is attached still opens it from a browser.
