# Group broadcast cannot be turned off while a member sits in a window no page holds

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: found on 2026-11-05 while the round's integration branch was tested. Browser check 203 was red after check 201 and green alone; 201's cleanup had left a terminal of the default group live in a window no page held, and 203's Toggle group broadcast could turn that group on but never off. The checks were repaired on their own branches ([the strip's](a-panes-tab-strip-shows-over-a-lone-tab-with-nothing-to-switch-to.md) and [the launcher focus fix's](a-command-launcher-run-that-opens-nothing-leaves-the-terminal-deaf.md)); the toggle was a product bug, older than this release. The owner ordered the fix into v0.124.0 (work order `dev/broadcast-skips-windowless-members.md`), built by a Claude subagent of the lead in place of a Codex agent, by the owner's word, on `fix/broadcast-skips-windowless-members` off `8c0f5eefb`, merged into `v0124/int` as `4a7b0bacb`.

## What was there

While any terminal of a group sat in a window with no connected page (a window chan-desktop's Hide put away, whose sessions stay warm, or a saved window nothing has opened), Toggle group broadcast in another window (the chord, the launcher row, the terminal menu's Select All) could turn broadcast on but never off, and the menu always read Select All. `toggleTerminalGroupBroadcast` (`state/tabs.svelte.ts`) computed "all on" over the local targets and every same-group roster member in another window, and for the windowless member sent `POST /api/terminals/<id>/broadcast {"on":true}`; the server answered 204 and routed a `terminal_broadcast` command to the member's window, but no page held that window, so the member's roster flag never flipped and every later toggle computed "turn on" again. `allBroadcastTargetsSelected` in `TerminalTab.svelte` had the same dependency, hence the stuck label. The per-row checkbox still worked.

## Desired contract

1. A roster entry says whether a page holds its window: `RosterEntry.window_live`, true while the tenant's window presence holds a live `/ws` socket for the session's window, false for a window no socket holds and for a session with no window.
2. The roster is pushed again when a window with a live session gains its first socket or loses its last, so every window sees the change within one push; a window that holds no session, and a socket joining or leaving a window that stays connected, push nothing.
3. The cross-window members of a group exclude those whose window no page holds, so the toggle, the Select All label, the menu's other-windows list and the reach count describe the live group. A member whose window comes back live rejoins with its own flag.
4. A roster without `window_live`, from an older server, reads every member as live, as before.
5. Input fan-out is unchanged: the server still fans cross-window input to a member whose own broadcast is on, live or not. Who owns a session's flag, the `set-broadcast` and `terminal_broadcast` frames and the per-row toggles are unchanged.

## Boundaries

chan-library: `RosterEntry` and `Registry::roster` read the presence the serving layer installs with `Registry::install_window_presence`; `WindowPresence` calls a set-once window hook on a window's first socket and last drop, after its lock is released, and the registry's hook fires the roster signal only when a live session belongs to that window. chan-server installs the presence in `build_tenant_app` and describes when the roster is pushed. The workspace app: `TerminalRosterEntry.window_live` (optional), `crossWindowBroadcastMembers`, the reach count's comment, and the design's group Select All. Browser check 208.

## Acceptance

1. `roster_says_whether_a_page_holds_each_sessions_window`, `a_window_connecting_or_disconnecting_signals_the_roster` (a window with no session must not signal) and `roster_is_pushed_when_a_sessions_window_connects_or_disconnects` over a terminal tenant; each red under its mutation, and `graph_applied_from_built_and_reinstalled_tenants_reaches_every_socket` red when every window's presence change pushes the roster.
2. `tabs.test.ts`: a member marked not live, toggled twice, leaves the toggling tab's broadcast off and is never asked to join; a live member and one from a roster without `window_live` keep the previous behaviour; a member whose window comes back live rejoins. `TerminalTab.menus.test.ts`: the mounted Select All row reads Deselect All once every live member is on and lists only live members. Red before the fix, the two controls green.
3. Browser check 208: a second page leaves a same-group terminal in its own window and closes, so the window reads saved and not connected with the member still in the roster; the main window's two toggles must turn broadcast on (Deselect All) and then off (Select All); with the window reopened the member rejoins and flips on and off through its page.

## Built

Five commits: `55210c511` (`window_live` and the push on presence), `9040f8ab5` (the SPA's red tests), `1427fe50c` (check 208), `15b2d75fd` (the push only for windows with a live session), `99de0e322` (the SPA's filter). `55210c511` alone was red on `graph_applied_from_built_and_reinstalled_tenants_reaches_every_socket`, which counts the frames a socket receives and read an extra empty roster, until `15b2d75fd`.

Verification recorded in the commits and the lead's notes: at the tip, chan-library's 847 tests, chan-server's 2,505 and `make web-check` (8,571 workspace-app tests) green; check 208 red at `8c0f5eefb` on all three counts (Select All after the first toggle, broadcast left on after the second, the away window saved and not connected with its member listed), green alone and in a pack with 176 and 200 to 207, in an isolated guest.

Open: the windowless member was made by closing a page in Chrome; chan-desktop's Hide was not read. A non-live member whose own broadcast is on still receives the group's typed input and is not counted in the reach count, which its comment states.
