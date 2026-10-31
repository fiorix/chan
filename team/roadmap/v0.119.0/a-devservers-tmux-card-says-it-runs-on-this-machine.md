# A devserver's tmux card says it runs on this machine

Status: built on `v0119/tmux-card-devserver-title` on 2026-10-31 (`5b4334acc`) and merged into `0.119.0-ga` the same day (`077c59a3d`); placed in v0.119.0 by the owner's word of 2026-10-31 ("these remote branches unmerged are the ones"). Awaiting review; no hand check in a desktop window is recorded.

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
- `Library.svelte` reads `entry.session.name` unguarded on the card's sub-line, while the server omits `session` until tmux announces it (`#[serde(default, skip_serializing_if = "Option::is_none")]` on `TmuxConnectionRecord.session`) and the TypeScript `TmuxConnectionEntry` types it as always present. A record published before the announcement would fail the card's render on that read; this is read from the types and the serializer, not observed. Not changed here.

## Acceptance

1. A devserver's `tmux -CC`, direct and over the gateway, shows as `tmux -CC on <devserver>` on its Library card and in the command launcher, and this machine's still shows `tmux -CC on this machine`. Not yet checked by hand.
2. The `machineTree` and `CommandLauncher` tests pin the title, the sort and the session label; the commit records them red on the old code with the reported title.
