# The desktop decodes a devserver's window feed all or nothing

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.101.0 on 2026-09-23. From the independent review of `v0101/unknown-window-kind` (its one medium finding) and that lane's report, which both read the two sites below while closing [an-unknown-window-kind-may-drop-every-window-row](an-unknown-window-kind-may-drop-every-window-row.md) and found that the store repair does not reach them. A source reading against `main` at `5fe07b465`; not reproduced.

## Owner ruling

Accepted on 2026-09-24 with the lead's shape: decode the list and each watch frame element by element in the desktop, logging unreadable rows with the devserver id and `window_id`. The owner stressed that resilience and testing matter here: one unreadable row must never cost the desktop its view of a devserver, and the tests prove that for the list and for a watch frame.

## What was seen

The window store repair keeps a row a build cannot read out of the window set and writes it back unchanged, which covers one host upgrading or downgrading. It does not cover the case the window-kind item opens with, a desktop and a devserver on different releases, because those two never share a store file: the desktop opens `~/.chan/windows.json` (`crates/chan-server/src/lib.rs`, the host bootstrap) and the devserver opens `windows.json` beside its own config (`crates/chan-server/src/devserver.rs`). What crosses releases between them is the window feed, and the desktop reads it all or nothing. The list call decodes the body as `Vec<chan_server::WindowRecord>` (`desktop/src-tauri/src/devserver.rs`, `resp.json::<Vec<chan_server::WindowRecord>>()`), so one element with a `kind` or `origin` tag this desktop does not know fails the whole list with a decoding error. The watch loop parses each frame as a `WindowSet` inside an `if let Ok(set)` (`desktop/src-tauri/src/window_watcher_wiring.rs`) and drops a frame that does not parse, with no log line.

Scenario: a desktop on this release stays connected to a later devserver that mints one window of a new kind. From that frame on every watch frame fails to decode and is skipped, so the desktop's view of that devserver freezes at its last good snapshot, where new windows never open and discarded ones never close, and a fresh connect's list call errors out instead of showing the rows it could read.

## Desired contract

A desktop shows every window row it can read from a devserver's feed, treats a row it cannot read the way the store now does, hidden and logged, and never lets one such row freeze or empty its view of that devserver.

## What to do

Decode the list and each watch frame element by element in the desktop, keeping the readable rows and logging the rest with the devserver id and the row's `window_id` when it can be read, rather than adding a catch-all variant to the closed enums, which every server-side consumer would then have to handle. A watch frame that fails to parse as a whole should at least log. Acceptance: a test feeds the desktop's decoder a list holding one readable row and one row of an unknown `kind`, and shows the readable row kept and the other named in the log; the same for a watch frame; and the existing feed tests unchanged.
