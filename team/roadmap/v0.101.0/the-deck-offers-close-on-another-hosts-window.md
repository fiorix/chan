# The deck offers Hide and Close on a window of another host's feed, and this host answers that it has no such window

Status: raised for a decision on 2026-09-27 by the independent review of the launcher handlers' first half (`dev/v0101-team/reviews/review-Runtime-10.md` in the development tree, finding 2), which read the code at `f940f0d63`; read again in code at `b1ef073ae`, where it holds. The code path is read; how a real client reaches it is inferred, and it was not reproduced. Recommendation: a later version.

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
