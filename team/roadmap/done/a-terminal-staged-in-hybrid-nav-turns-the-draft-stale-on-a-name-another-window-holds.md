# A terminal staged in Hybrid Nav turns the draft stale on a name another window holds

Status: shipped in [v0.123.0](../../release/release-v0.123.0.md).

Record before the release: found on 2026-11-03 as a known gap of the tmux staging work on the owner's local branch `hybrid-nav-tmux` and built there, rebased onto `main` for v0.123.0 by the owner's release order of the same day; landed, closes at the GA.

## What was there

A terminal staged in Hybrid Nav (`t`, or a split in a window without a workspace) kept its local placeholder name, Terminal-N counted from the window's own tabs: `applyGlobalTerminalName` looked the tab up in the live tree, which does not hold a staged tab. When another window of the tenant held that name, the server settled the session under another one (Terminal-1-2), and the session frame's rename marked the transaction stale ("Layout changed. Esc to discard.") as soon as the terminal connected.

## Desired contract

1. A staged terminal takes the name the server proposes, as any new terminal does.
2. A settled name for a tab that only the draft holds does not stale the transaction; the commit adopts the tab with its name. This covers the server settling another name when two spawns race for one proposal.
3. A live terminal renamed during the mode still stales it, through the roster, the rename ack or its session frame.

## Closing

`1bc4ca95a` (from `9fc658631`), fix(terminal): name Hybrid Nav's staged terminals from the server. `applyGlobalTerminalName` finds the tab in the layout on screen, the draft while Hybrid Nav is up; a settled metadata change stales the transaction only for a tab the live tree holds. `3a74bd1f4` (from `3aebe1833`) corrects `paneModeOpenTerminal`'s comment: a staged terminal mounts and starts its shell while Hybrid Nav is up, and Escape kills it through `killStagedTerminalSessions`.

Verification recorded in the commit, in an sdme guest on the old base: new `App.paneMode.test.ts` tests stage a terminal over a demo socket that settles names as the registry does, and a `paneModeConflict.test.ts` test pins the live and staged cases; all three are red at the base, and with either half of the change alone at least one stays red. New browser check `199-hybrid-nav-staged-terminal-name` opens two windows of one workspace, a terminal in the first and Hybrid Nav's `t` in the second: red at the base (Terminal-1-2, stale) and with the stale guard alone, green with the change.
