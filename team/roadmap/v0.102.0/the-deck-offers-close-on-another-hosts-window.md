# The deck offers Hide and Close on a window of another host's feed, and this host answers that it has no such window

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the independent review of the launcher handlers' first half (`dev/v0101-team/reviews/review-Runtime-10.md` in the development tree, finding 2), which read the code at `f940f0d63`; read again in code at `b1ef073ae`, where it holds. The code path is read; how a real client reaches it is inferred, and it was not reproduced.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: the owner accepted in one answer every recommendation the lead had put to them that day, and for this item the recommendation was a later version. It is not part of v0.101.0.

## What was seen

The capability snapshot that the workspace app's deck lists takes every assembled window record whose library id is this host's (`scoped_local_windows`, `crates/chan-server/src/routes/library.rs:625-635`), and the host appends the connected devservers' feed records to its own registry's (`assemble_window_records`, `crates/chan-library/src/host.rs:2289-2294`). The deck offers Hide on a shown window and Close on any that is not a control terminal (`scopedWindowActions`, `web/packages/workspace-app/src/components/CommandLauncher.svelte:374-385`). The capability's visibility and close actions look the window up in the same assembled records (`library.rs:834-844`, `:859-871`) but act on this host's registry alone, which knows no row that only a feed holds, and then answer 404 "window not found" (`set_window_hidden` and `discard_window`, `:851-857`, `:872-878`).

So a feed record that carries this host's library id is listed and offered Hide and Close, and each answers that the window does not exist. The pins build that state with a feed row that carries the local library id (`action_visibility_unregistered` and `action_close_unregistered`, `crates/chan-server/src/routes/library_command_capability_tests.rs:557`, `:560`); which feed carries this host's library id in real use is inferred, not shown. Before the refusal envelope the answer was an empty 404 and read "Not Found"; the conversion kept the status and gave it this sentence, and the lead ruled that its sentences stay.

The same review found a second case, which the deck does not reach: the capability's close treats a control terminal as not found (`!record.control` in its lookup, `library.rs:864-868`), where the visibility action answers 403 "control terminals are not managed by a browser capability" (`:845-850`). The deck offers neither Hide nor Close on a control terminal (`CommandLauncher.svelte:376-384`), so only a direct request meets it.

## Desired contract

The deck offers an action on a window only where the route behind it can take that action, and a refusal says why: a window this host cannot manage is not offered as manageable, or is refused with a sentence that says so, never with one that says it does not exist.

## What to do

Decide the shape. The snapshot could mark the rows this host's registry does not hold, so that the deck offers only Focus on them; the actions could be routed to the devserver whose feed holds the row; or the 404 could keep its status and say that the window belongs to another host. Settle the control terminal's close with it, which answers 404 where its sibling answers 403. Red first: the existing fixture, with the deck's actions read for a feed row that carries this host's library id.

## Boundaries

`crates/chan-server/src/routes/library.rs` (`scoped_local_windows`, `handle_library_command_action`), the deck's `scopedWindowActions` in `web/packages/workspace-app/src/components/CommandLauncher.svelte`, and their tests. The desktop's own window routes are outside.

## Acceptance

1. A feed row that carries this host's library id is not offered Hide and Close, or those actions reach a host that can take them, or their refusal says that this host does not manage the window; pinned with the existing fixture.
2. A control terminal's close through the capability answers as its sibling routes do.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. This record was written that day from those. Nothing here ran on a real hung mount.

The server's half is built, and the row stays open for the deck's. By the lead's ruling the snapshot marks what this host manages: each window of the command capability's snapshot, and the window an action answers, carries `managed` (`ScopedLibraryWindow`, `scoped_local_windows`, `crates/chan-server/src/routes/library.rs`), true when this host's window registry holds the window and false for a row that reached the snapshot through a devserver feed alone. A control terminal's close through the capability answers 403 with the sentence its sibling routes use; a row this library does not list keeps its 404. Pinned with the existing fixture (`a_snapshot_marks_the_windows_its_registry_holds`) and in the refusal table. Left: the deck offers Focus alone on a window whose `managed` is false, which is ordered; and the mark goes by window id against the registry's rows, so a feed row that carried an id the registry also holds would read managed; and the ids and the rows come from two reads of the registry, so a window minted between them reads unmanaged for one snapshot.

The deck's half was built later that day, in a range the lead accepted on its report, its status files and an independent review of its whole diff. A window row whose `managed` is false gets no action and no entry in the deck, in its list and in its typed search (`scopedWindowActions`, `web/packages/workspace-app/src/components/CommandLauncher.svelte`); a row with no field or with `true` keeps its actions, and a control terminal keeps Focus or Show alone. That is narrower than Focus alone, by the lead's ruling on the builder's trace: this host cannot show a hidden window it does not manage, and Focus on a visible one was to be offered only where it can be carried out. The row stays open on that last point. The review traced the desktop's path and read that Focus does reach a visible such window there, since the window watcher opens it under the label Focus targets, where the builder read that it does not; and it read that the browser's launch route does not refuse a feed row, as the code's comment says it does, but redirects to a page this host may not serve. Neither trace was run. Ordered: settle the desktop's trace and offer Focus there on a visible row if it holds, make the comment true, and send a draft whose path names such a row back to the deck's root, where it now shows an empty list. The launcher's own window rows are built from the feed, which carries no `managed`, and still offer every action through the desktop's bridge; that path was not traced.

On the server's side the mark was repaired that day too, in a range the lead accepted on its report, its status files and an independent review of its whole diff: a snapshot takes the registry's records and the feed's from one read of each and marks a row by the part it came from (`WorkspaceHost::window_records_by_source`), so no window reads unmanaged for one snapshot between two reads, and a feed row under an id the registry also holds reads unmanaged. An action on such an id still acts on the registry's window, which the registry's own row offers.
