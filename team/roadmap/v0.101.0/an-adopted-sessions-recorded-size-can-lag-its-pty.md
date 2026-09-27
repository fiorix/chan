# An adopted session's recorded size can lag its PTY after a restart

Status: raised during v0.101.0 on 2026-09-26 by the runtime lane's attach prelude order (`dev/v0101-team/reports/report-Runtime-9.md`, "Residuals", in the development tree), read in code and not reproduced; a source reading against that order's tip `58623d470`.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: an adopted session compares attach sizes against the PTY's real size, read at adoption or recorded when applied, never the manifest's alone; pinned with a restart whose last resize followed the last manifest write.

## What was seen

The attach route compares the size the client declares with the size the session last applied (`AttachHandle::size`) and resizes the PTY before the prelude when they differ. After a devserver restart an adopted session starts from the manifest's recorded size; the socket loop's Resize arm resizes the PTY but does not rewrite the manifest, so a resize after the last manifest write leaves the kernel's size ahead of the recorded one. A client that then declares exactly the recorded size gets no resize, its first repaint lands at the kernel's size, and its own Resize frame after `ready` repairs it, as it did before the attach resize existed.

## Desired contract

The size an adopted session compares against is the PTY's real size, so a client declaring a different size is fitted before its first repaint on every path.

## What to do

Read the kernel's size (`TIOCGWINSZ`) at adoption, or record the applied size in the session so the comparison never trusts the manifest alone; pin with a restart whose last resize followed the last manifest write. Small; in `crates/chan-library`.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (adoption and the applied size) and its tests.

## What shipped

Landed on 2026-09-27. An adopted session reads its PTY's real size from the adopted master with `tcgetwinsize`, through the `rustix` termios API the imported controller already resizes with, and seeds both its applied and its requested size from it. When the read fails or reports no cells, as for a PTY nobody sized, it falls back to the manifest's record. A client that declares the manifest's stale size after a restart is fitted before its first repaint; one that declares the PTY's own size resizes nothing. No dependency changed.
