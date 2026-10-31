# A devserver's tmux card says it runs on this machine

Status: shipped in [v0.119.0](../../release/release-v0.119.0.md).

Record before the release: landed in `0.119.0-ga` on 2026-10-31 (`077c59a3d`, with the session fix `52a75e155`) and reviewed there (the section Review, 2026-10-31); no hand check in a desktop window is recorded.

Record before the review: built on `v0119/tmux-card-devserver-title` on 2026-10-31 (`5b4334acc`) and merged into `0.119.0-ga` the same day (`077c59a3d`); placed in v0.119.0 by the owner's word of 2026-10-31 ("these remote branches unmerged are the ones"). Awaiting review; no hand check in a desktop window is recorded.

## What was seen

A `tmux -CC` run in a devserver's terminal, direct or over the gateway, showed in the desktop launcher as `tmux -CC on this machine`. The library that runs the terminal marks a foreground of tmux itself as local (`origin.local`), and the launcher titled every local origin `on this machine` without reading the record's `library_id`. The lists of every machine's windows (All windows, the command launcher's breadcrumb and search text) used the same title, so two connections on one machine read alike there.

## Desired contract

A tmux card's title names the machine whose terminal runs the tmux client: `tmux -CC on this machine` for this machine's library and `tmux -CC on <devserver>` for a devserver's; a carrier's run keeps `tmux -CC from <command>`. A list of every machine's windows names a tmux window's machine by that title and the tmux session, `tmux -CC on alpha (main)`, and by the title alone until tmux announces the session.

## What was done

- `web/packages/launcher/src/lib/machineTree.ts`: `tmuxHost()` returns the name of the devserver row whose `library_id` is the record's, the first by name when a direct row and its gateway roster row share it (the row whose card holds that library's windows), and null otherwise; `tmuxCardTitle()` takes that host; `tmuxWindowMachine()` adds the session when the record carries one. A devserver's tmux card no longer sorts first as this machine's; it sorts with the remote cards by title.
- `web/packages/launcher/src/components/CommandLauncher.svelte`: a tmux window's machine is `tmuxWindowMachine()`.
- `web/packages/launcher/design.md`: the card title paragraph.

## Evidence

On the branch, from the commit: the new `machineTree` and `CommandLauncher` tests were red against the old code with the reported title (`on this machine` for `on alpha`); launcher vitest 729 of 729, `svelte-check` 0 errors, the launcher build within its size budget. The full pre-push gate was not run on the branch.

At the merge, read against the server: `TmuxConnectionRecord.library_id` is a required `String` (`crates/chan-library/src/windows.rs`), so a devserver row whose `library_id` is still null cannot match a record by null equality.

## Known gaps

- A devserver row whose `library_id` is still unknown keeps `on this machine` until it is learned.
- The hidden control row keeps the server-set `tmux -CC on this machine` title.
- Two clients on the same tmux session still look alike.

## The card before tmux names its session

Found at the merge and fixed on `0.119.0-ga` by the owner's word of 2026-10-31 ("fix Library.svelte yes"). The server leaves `session` out of a record until tmux announces it (`#[serde(default, skip_serializing_if = "Option::is_none")]` on `TmuxConnectionRecord.session` in `crates/chan-library/src/windows.rs`), while the launcher's `TmuxConnectionEntry` typed it as always present and `Library.svelte` read `entry.session.name` on the card's sub-line. `session` is now optional in the type, and the sub-line reads `tmux <version>` until the session is named and puts `session <name>` before it after.

Evidence: the new `Library.test.ts` case "renders a record that arrived before tmux announced its session" was red on the old template (`TypeError: Cannot read properties of undefined (reading 'name')`) and is green with the fix; launcher vitest 730 of 730, `svelte-check` 0 errors. With the type optional, restoring the old read alone fails `svelte-check` at that line (`'entry.session' is possibly 'undefined'`), so no other unguarded read of `session` is left in the launcher.

## Acceptance

1. A devserver's `tmux -CC`, direct and over the gateway, shows as `tmux -CC on <devserver>` on its Library card and in the command launcher, and this machine's still shows `tmux -CC on this machine`. Not yet checked by hand.
2. The `machineTree` and `CommandLauncher` tests pin the title, the sort and the session label; the commit records them red on the old code with the reported title.

## Review, 2026-10-31

Read at `afb83e7a4` by the review the owner asked for before the GA ("do an adversarial review"), whose reviewers were asked for evidence or a plain "nothing found"; the lead reproduced each finding acted on before its fix.

The reviewer confirmed that `tmuxHost` and `buildMachineTree` give a library's windows to the same row. Left open as minor, in [v0120review]: the command launcher names a plain window's machine by the first devserver row in feed order and a tmux window's by the first by name, so a direct row and its gateway roster row on one library read as two names; and a devserver row on this machine's own library titles a local run by that row.

[v0120review]: ../v0.120.0/ghostty-defects-the-v0119-review-left-open.md
