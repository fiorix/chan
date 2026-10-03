# A window's record says that a socket is live for it, not whose

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the lead's notes on the independent review of the fourth fix round of the desktop's wait (`dev/v0101-team/reviews/review-Runtime-15.md` in the development tree, finding 1 and the lead's notes), and written as a cost of the rule that landed that day in the desktop's design document and in the two web apps' (`desktop/design.md:224`; `web/packages/launcher/design.md:60`; `web/packages/workspace-app/src/design.md:24`). Read at `7957bccef`; the two-desktop case is read in code and not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: a signal for each client changes the frame of the window feed, which is a contract. When it was raised the lead recommended a later version for the same reason. It is not part of v0.101.0.

## What was seen

A window's record carries `connected`, true while some `/ws` socket tagged with the window's id is live (`crates/chan-library/src/windows.rs:130-132`). The tenant counts those sockets for each window id and keeps nothing else (`WindowPresence`, `crates/chan-library/src/window_presence.rs:19-22`, `:28-37`, `:58-107`), so the record cannot say whose socket it counts: another desktop's, another browser tab's, or a half-open socket of this page.

All three clients now decide by it whether a window is on its page:

- **The desktop** ends a try of the timer for a waiting window, with nothing done, when the window's record reads connected and its webview was last loaded with the attempt's key (`admit`, `desktop/src-tauri/src/window_watcher_wiring.rs:413-429`). Each desktop attached to a devserver opens every native window of that library (`should_show`, `desktop/src-tauri/src/window_watcher.rs:233-239`; the reconcile, `:280-289`), so where two desktops share a devserver every window reads connected through the other desktop's socket all the time, and a Reload that found its target not ready ends at its try there as the normal state, the window left on the page it had (`desktop/design.md:224`, `:226`). A second Reload, once the devserver is ready, navigates it.
- **The launcher and the workspace app** leave a window alone when its record reads connected and it is not blank (`openWindowRecord`, `web/packages/launcher/src/state/windowManager.svelte.ts:116-117`; `focusLibraryWindow`, `web/packages/workspace-app/src/api/libraryWindows.ts:181-182`), so a second tab on the same window id keeps a broken one from being repaired (`web/packages/launcher/design.md:60`; `web/packages/workspace-app/src/design.md:24`).

What the page shows while it is left alone is inferred.

## Desired contract

A client that decides whether a window is on its page can tell its own socket from another client's.

## What to do

A later version, by the recommendation. A code map first, of every reader of `connected` in the three clients and of what a frame of the window feed carries to clients of other releases. Then, as suggestions: the record carries, for each window, the clients that hold a socket for it, or a client tags its socket so that it can ask whether its own is live; either changes the tenant's presence count and the feed's frame.

## Boundaries

`crates/chan-library/src/window_presence.rs`, the record in `crates/chan-library/src/windows.rs` and the `/ws` route's tagging; the desktop's watcher (`desktop/src-tauri/src/window_watcher_wiring.rs`), the launcher's window manager and the workspace app's window helpers where they read the record; the three design documents that name this cost.

## Acceptance

1. With two clients holding one window id, each can read whether its own socket is live, pinned through the feed.
2. A desktop's Reload that found its target not ready navigates when the target is ready, although another desktop holds that window, pinned.
3. The three design documents' sentences on this cost are gone or say what the code does.

## What shipped

Built in part on 2026-10-03 on the v0.102.0 integration branch and not on `main`: the server's half, in a range the lead accepted on its report, its status files and an independent review of its whole diff, which found nothing above low. This record was written that day from those.

A client tags its event socket: `GET {tenant}/ws?w=<window_id>&h=<holder>`, where `h` is opaque to the server, 1 to 64 characters of `[A-Za-z0-9_-]`. A missing, empty, repeated or malformed `h` is not an error: the socket counts toward `connected` and adds no holder. A window's record carries `holders`, the distinct tags with a live socket for the window, sorted; this server always sends it, empty when none, and a record without the field comes from a server that does not count them. `connected` is unchanged. A holder that arrives or leaves wakes the feed as a change of `connected` does, the scoped row carries the list, and the capability launch route copies a valid `h` into the tenant URL it redirects to (`crates/chan-library/src/window_presence.rs`, `windows.rs`; `crates/chan-server/src/routes/ws.rs`, `routes/library.rs`). Pinned red first through the feed with two tagged sockets on one window: acceptance 1, the server's part.

The row stays open: no client tags its socket or reads the list yet. Left for the three client parts: the page reads `h` from its URL and sends it on `/ws`; the launcher's and the desktop's openers mint a tag unique to the client instance and decide by it; the desktop sets the list to "cannot say" wherever it forces `connected` to false for a buried window or a dead feed, since a stale list beside `connected: false` would read as live; acceptance 2 and 3. A tag is a claim and not an identity: any client that can open a window's socket can present any tag.
