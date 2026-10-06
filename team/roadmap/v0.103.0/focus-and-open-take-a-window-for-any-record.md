# The launcher's Focus and Open, and the workspace app's deck, take a window for any record

Status: duplication observed from the browser deck's Show; on 2026-10-06 the owner chose explicit browser Open with no remote native Focus, and the repair is being built red first. Two earlier Open arms opened only a browser. Three other target gestures remain unobserved after instrument failures.

## Owner decision, 2026-10-06

Observe the browser launcher and workspace deck with a hidden native window before changing behavior. The owner does not recall seeing duplication in practice. If confirmed, make Focus target the actual holder and retain an explicit browser Open path when no desktop owns the window. Decide exact Open behavior from the observation; preserve opening a devserver's first terminal in a browser without a desktop.

## Owner choice, 2026-10-06: explicit browser Open

With the deck Show duplication observed, the lead put two policies to the owner (`dev/v0103-team/reports/proposal-Lead103-item5-owner-choice.md` in the development tree): A, explicit browser Open with no remote native Focus, recommended; or B, a new addressable and acknowledged remote native Focus route. On 2026-10-06 the owner chose A through the lead's window survey, recorded at `dev/v0103-team/evidence/Lead103/surveys/lead-switch-complete.log`.

The chosen contract, from the reviewed design `dev/v0103-team/reports/design-DocSync103-item5-focus-show.md` at its recommended option: a browser deck's Show of a hidden native-origin record posts visibility only and opens no browser page, so an attached desktop's watcher may restore the native window; both browser command decks offer an explicit Open in this browser for native-origin rows, hidden or visible, and offer no Focus for them; a stale Focus invocation for such a row refuses with an unavailable-native-focus message and makes no popup, page check or visibility change; the desktop-bridge launcher and the Tauri workspace keep their native Focus; browser-origin rows keep their present popup and page-repair behavior; a scoped server that omits the origin is unknown, follows the same no-implicit-popup policy and is not called native-owned; and the launcher's explicit Open of a devserver's first terminal without a desktop is preserved. Open does not unhide the record, and Show's success means only that `hidden` became false. A browser still receives no action for a scoped row whose `managed` is false, whose launch path this host may not serve. No remote native Focus route is added in this release; that remains option B, not chosen.

The build it authorizes: the scoped record (`ScopedLibraryWindow`, `crates/chan-server/src/routes/library.rs`) carries `origin` explicitly for both native and browser records, so an older server's absent field stays distinguishable; the launcher (`web/packages/launcher/src/state/computerActions.ts`, `components/CommandLauncher.svelte`) and the workspace app (`web/packages/workspace-app/src/api/libraryWindows.ts`, `api/libraryCommand.ts`, `components/CommandLauncher.svelte`), with their tests, change their Show, Focus and Open commands, each changed gesture with a pin that is red first, as Acceptance 2 asks; and the observed `deck:server` pair is compared again on the reviewed candidate under the same attached-desktop fixture, expecting one restored native window and zero newly opened browser pages for the target. Nothing here is built, reviewed or gated yet; those results are recorded when they exist.

## Deck Show duplication, 2026-10-06

A later bounded Linux WebKitGTK desktop and Chromium browser invocation reproduced the duplicate through the workspace deck's Show action against the same frozen product `a64c6184739aa9b7c4c85f00124ef56292277b02`, with clean fixture `55cd6ba8c` and a separately hashed diagnostic overlay. Before Show, the selected record was hidden, disconnected and had no holders; its original native X window was gone. The helper browser page belonged to a different record. The enabled Show action for the exact selected window succeeded, opening a browser page on that record and a new native X window with its title. The record then had two holders, including its original desktop holder. Independent review accepted this page, X and record join as one simultaneous browser/native outcome; internal cause is not assigned.

The server-launcher Focus, desktop-launcher Focus and launcher Show arms stopped before their target gesture. Their launcher row had disabled Show, while the deck helper found no visible target rows. These instrument outcomes establish neither a missing product action nor a passing absence of duplication. The earlier two Open observations remain separate and were not repeated.

The invocation returned exit1 with all four arms retained. Every driver also hit an unset `BROWSER_PID` during cleanup, skipping its exact Node wait. The duplication rests on the completed product row, retained page/X/record evidence and successful unchanged result reader, rather than that exit status. Separate final process samples showed idle, with unchanged source/binary identities, resource caps and OOM count; they do not prove the skipped reap. The retained handback is `dev/v0103-team/tasks/task-Desktop103-Lead103-77.md`, with evidence in `dev/v0103-team/evidence/Desktop103/observe/focus-r5-diagnosis-job/attempt-01/` and independent judgment in `dev/v0103-team/reviews/review-Review103-Desktop103-focus-r5-diagnosis-attempt01-artifact-1.md`.

This observation meets the owner's condition for designing the repair. Exact Focus/Show routing and Open behavior must be settled before implementation, preserving browser opening when no desktop is attached. The empty holder list before Show means live window holders alone do not identify the desktop that will recreate a hidden window. No product repair or combined gate is claimed by this observation.

## Earlier partial display observation, 2026-10-06

One bounded Linux WebKitGTK desktop and Chromium browser invocation ran six isolated arms against frozen product `a64c6184739aa9b7c4c85f00124ef56292277b02` with fixture `b79fda81d637c7c7e137ffa06b1e59ccc8c7991d`. These are separate product and instrument identities. A prior real no-desktop control had opened the selected native-origin record in a browser. Before the six arms, the actual result reader accepted its two constructed positive cases and rejected a wrong page, wrong holder and contradictory surface/outcome with the intended diagnostics.

The server-launcher Open and first-terminal Open arms each opened one browser page for the selected hidden record, with one browser holder and no target native X window. The record remained hidden. These are two observed browser-only outcomes, not a bound on other gestures or configurations. Native X visibility would not, by itself, establish frontmost focus.

The server-launcher Focus, desktop-launcher Focus and launcher Show arms each stopped after selecting top-level Windows, when a workspace-slug filter found no target row. Their `notOffered` answers describe that instrument navigation failure before the named gesture; they do not show that the product menu lacks Focus or Show. The workspace-deck helper stopped on an ambiguous Windows filter containing nine already-expanded action rows before target Show. None of these four arms supplies a target-gesture outcome, and none is a passing absence-of-duplication check.

That earlier invocation returned exit3/inconclusive with all six arm exports retained; source, binary and resource checks held and the guest was idle after cleanup. Independent review accepted the two Open observations and four instrument failures at that scope. It established no duplication, so no conditional product repair was selected from it. The retained record and correction are `dev/v0103-team/tasks/task-Desktop103-Lead103-60.md`, `dev/v0103-team/evidence/Desktop103/observe/focus-r4-product/attempt-01/` and `dev/v0103-team/reviews/review-Review103-Desktop103-focus-r4-product-attempt-1.md` in the development tree.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

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
