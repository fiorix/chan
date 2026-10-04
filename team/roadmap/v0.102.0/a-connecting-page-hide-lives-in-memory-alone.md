# A window hidden on the connecting page is hidden in the desktop's memory alone

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the limit of the shape that the owner confirmed as built on 2026-09-29 for [a-connecting-page-close-discards-its-window](../done/a-connecting-page-close-discards-its-window.md), which the lead accepted for that order and said would be raised as an item of its own (`dev/v0101-team/followups/followup-Lead-Services-32.md` in the development tree, Q2; the lead's note to the owner of 2026-09-28 22:14Z, `dev/v0101-team/for-host-2026-09-27.md`), with three findings that the lead's notes on the order's independent review put into that item (`dev/v0101-team/reviews/review-Services-18.md`, F4, F5 and F6, and the notes of 2026-09-28 23:24Z at its end). The review read the range `7f4e2e804..b772a5ddd` on its lane's branch, before that range's fix round, and the lines below are the review's. Read, not run: the order's pins run on the framework's mock runtime, and no desktop was driven. Ruled on 2026-10-03: see Owner ruling. On 2026-10-04 the pending hide that outlives a watcher's replacement was built with a disposition for each finding; the row stays at build for the owner's display reading.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: accepted for a build of the pending hide that outlives a watcher's replacement, with a disposition for each of the three findings.

## What was seen

The build shipped in v0.101.0. A close or a Disconnect on the connecting page hides the window and keeps its record and its terminals. While the devserver does not answer, the hide cannot be posted to it and is kept in the desktop's memory alone, so the window opens again after the desktop disconnects from that devserver and connects again. The lead accepted that for the order as the smaller fault, since before it the close dropped the window's record and ended its terminals (`followup-Lead-Services-32.md`, Q2).

Three findings of the review are held here, each low, and the review reads nothing as lost in any of them:

- **With no watcher's view registered, the hidden window is in no list** (F4). In the instants between a disconnect taking the watcher's view out and the watcher's sweep, a close of a window on its connecting page buries in nothing and posts nothing: the window leaves, the Window menu shows no row for it, its record and its terminals stay on the devserver, and the next connect opens the window again (`serve.rs:1385-1401`, `:1185-1207`; `main.rs:1550-1563`, `:1292-1299`, `:1307-1315`; `window_watcher.rs:498-513`, under `desktop/src-tauri/src/`). After it the feed's override is set and nothing clears it at a connect, so the launcher reads that window as not connected while it is open, until its user hides or opens it from a row (`main.rs:660-673`, `:857-866`, `:999-1046`; `serve.rs:1393`). New with the range on these routes; the mechanism is older.
- **After the disconnect and the connect, the window is open and still listed as hidden** (F5). A hide whose post did not land leaves the window's label in the desktop's list of buried windows, which a disconnect clears only for the windows its sweep destroys. So the Window menu shows the window under Hidden Windows and under Open Windows, and the quit prompt counts it as hidden, until a click on the hidden row raises the window and clears the row (`serve.rs:1205`; `main.rs:6118`, `:6149-6177`, `:6204-6208`, `:6259-6318`, `:6813`). The mechanism is older; the range makes it the usual path of a hide from the connecting page.
- **The read of a window's URL that the range adds runs off the main thread, outside the guard that its doc names** (F6, inferred by the review). On macOS the platform's read unwraps a URL that may be nil, so a panic would be on the main thread and not in the caller (`serve.rs:715-716`, `:724-729`; `main.rs:4227`; the review's reading of `tauri-runtime-wry` and of `wry` 0.55.1). It needs a URL that is nil at the second read and was not at the first, which the review takes to be next to never, and it names no loss. The lines are the review's at `b772a5ddd`; at the integration branch's head the read is `webview_url` (`desktop/src-tauri/src/serve.rs`).

Not established: any of this on a display; whether the instant of F4 can be hit by hand; and what the range's fix round changed of the lines above. The lead's notes say that F4, F5 and F6 are not built and that the comment and the design document's sentences they touch were made true in the fix round; the code at the integration branch's head was not read for this item.

## Desired contract

A window that its user hid on the connecting page stays hidden after the desktop disconnects from its devserver and connects again, and the Window menu lists it once.

## What to do

Decide whether it is built or stays a written cost of [a-connecting-page-close-discards-its-window](../done/a-connecting-page-close-discards-its-window.md). The lead's note names one shape, a pending hide that outlives a watcher's replacement, "in the shape of the pending delete that the arm has already" (`followup-Lead-Services-32.md`, Q2); it is a note and not a plan, and nothing of it was read against the code for this item.

## Boundaries

By the review's citations, `desktop/src-tauri/src/serve.rs`, `main.rs` and `window_watcher.rs`, with their tests, and `desktop/design.md`. What a close on the connecting page does to the record is [a-connecting-page-close-discards-its-window](../done/a-connecting-page-close-discards-its-window.md)'s.

## Acceptance

1. The owner's decision is recorded: built, or kept as a written cost.
2. If it is built: a window hidden on its connecting page while its devserver does not answer is still hidden after a disconnect and a connect, pinned and read on a display.
3. If it is built: the Window menu lists such a window once, and the three findings above each have a disposition.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files (every red at its own assertion at a committed sha, fourteen mutations restored by hash, the series in parallel and on one CPU with no red, the own gate green at the tip) and an independent review of its whole diff, which found nothing above medium, its two mediums repaired in the next range. This record was written that day from those.

A hide of a devserver window is a process-local intent (`PendingHideState` in `desktop/src-tauri/src/window_watcher.rs` and its wiring): every path that buries a devserver window (the connecting page, the app's Hide, the launcher's Hide, `cs window hide`) queues it before posting the visibility, every watcher view of that devserver shares the suppressed set, and the intent settles only when a frame from its own devserver reads the record hidden or absent, an HTTP 2xx alone settling nothing; it is retried once on each connection round's first readable frame, without a budget or a notice; a reopen from the hidden list cancels it. The three findings: F4, a window closed on its connecting page with no watcher view registered keeps its hidden-list entry and its intent, so the next connect does not open it; F5, a hide whose post did not land is listed once, under the hidden windows, until it settles or is reopened; F6, the command's read of a devserver window's page runs on the main thread through a oneshot, and other labels hand no page. Pinned red first, seven assertions at their own committed shas, nine mutations restored by hash, both real-clock pins at twenty runs with no red. `desktop/design.md` says that an unreadable row keeps its last readable record and that its absence cannot settle a pending hide.

Costs, read in the code: a desktop restart forgets a hide its devserver never took, so such a window can open on the next connection; a window whose hide has settled and which another client later shows reopens on this desktop's next connection, its old hidden-list entry remaining, since this process-local intent does not override another client's show. Two sibling paths were read and left outside this item, for the owner: the transfer prompt's Hide hides its webview in place and persists nothing even while the devserver answers; a reopen whose `hidden: false` post fails can be closed again after a reconnect, since that post is sent without a retry. The row stays at build for acceptance 2's display reading.
