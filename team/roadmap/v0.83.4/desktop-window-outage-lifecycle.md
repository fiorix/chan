# Desktop window lifecycle across a remote outage

Status: REGISTERED for v0.83.4, grounded 2026-08-04, specified 2026-08-04.

## What

With chan-desktop connected to a devserver through the gateway, rebooting the remote machine produces three window-lifecycle failures, reported from live use on 2026-08-04: windows closed during the outage come back and cannot be closed again while the remote is down; restored windows get stuck on or past the "connecting" screen; and the close-confirmation prompt ("closing this window will stop the shell") strands behind newer windows, invisible, blocking the close it was asking about.

## Verified current state

All three mechanisms were read in code on the v0.83.3 lineage; the first two are structural certainties, the third's overlay ordering is read in code with the exact interleaving reproduced live once.

- Boomerang close. `request_close_window` for a `lib-` window destroys the native window immediately and fires `DELETE /api/library/windows/{id}` async (`desktop/src-tauri/src/main.rs`). On DELETE failure the record is unburied, the watcher's reconcile sees it as still wanting a window, and a fresh window respawns on the connecting screen. During a remote reboot the gateway answers 502, the DELETE always fails, and every closed window comes back within seconds. The connecting screen's own Cmd+W and Disconnect routes feed the same close path, so closing the respawned window boomerangs it again: an unbreakable loop until the remote returns. A launcher notice is emitted but is easy to miss.
- Blind probe. `probe_url` (the connecting screen's reachability command, `desktop/src-tauri/src/main.rs`) reports `reachable: true` for ANY HTTP response status. The gateway answers 404 at the gate or 502 when the tunnel is down, so a restored window navigates off the connecting screen on the first probe and lands on the gateway's static error page: no SPA, no close handler, dead command bus, and nothing ever retargets it. Escape is only Hide, an explicit devserver Reconnect, or Cmd+R after the remote is back.
- Occluded close prompt. The close-confirmation is in-webview DOM (`CloseConfirmOverlay`), opened by eval on CloseRequested. It cannot raise its own native window, nothing resolves it when the connection state changes, and any window created afterward (the boomeranged connecting windows, shown and focused at creation) stacks on top of it. The owning window stays `prevent_close`'d forever; later close attempts just re-open the prompt behind the newer windows.
- Not a defect but adjacent: the gateway session's one-hour cap means a window whose session expires mid-outage cannot re-authenticate on the feed reconnect alone, since re-auth only happens through navigation. The refresh-propagation half of that seam is owned by `gateway-served-surface-failures.md`; this item owns only the window-lifecycle behavior.

## Contract

### Close during an outage settles as closed

- A close issued while the devserver is unreachable must not reopen the window. The desktop records a pending-delete for the window record, destroys the native window, and retries the DELETE when the feed reconnects until it lands (bounded attempts, then a launcher notice naming the window). The reconcile/`should_show` path treats a record with a pending-delete as not wanting a window.
- The connecting screen's close affordances (Cmd+W, its Disconnect button) settle the same way: closed is closed, no respawn.
- The pending-delete may be in-memory for this item; the residual edge (desktop process restart between the close and the retry) is documented in the item's implementation evidence, not engineered here.
- A DELETE that fails for a reason other than reachability (for example a 4xx) also leaves the window closed and the record pending; the retry driver and the notice are the same.

### The connecting probe discriminates

- A window leaves the connecting screen only when the target actually answers as serving. `probe_url` classifies responses instead of accepting any status: gateway upstream errors (502/503/504) and transport failures are not reachable; statuses that prove the gate answered (including 401/403/404) are reachable for a gateway target, since the desktop installs the session cookies into the window before the page's own requests matter.
- If a cheap way to make the probe carry the window's gate session exists, prefer it (2xx/3xx then means serving; 404 drives a session refresh instead of a navigation). Loopback targets keep their current behavior: connection failure is unreachable, any answer is reachable.
- After the remote returns, a window parked on the connecting screen must reach the SPA on its own (the existing retry loop), and a window that already navigated must not be left on the gateway error page when the connecting screen would have told it to wait.

### The close prompt cannot strand

- When the SPA detects the connection drop (the DisconnectOverlay transition), any pending CloseConfirmOverlay in that window resolves as cancel. A reconnect clears any stale close-prompt state the same way.
- The native CloseRequested path raises and focuses the window before evaluating the close prompt into it, so the prompt is never opened behind another window.

## Acceptance checks

- New Rust coverage: the pending-delete state machine (close during outage stays closed, retry lands after reconnect, no respawn from a reconcile), the probe classification table (502/503/504 and transport failure unreachable; 401/403/404 reachable for gateway targets; loopback behavior unchanged), and the CloseRequested raise ordering.
- New vitest coverage where the SPA owns behavior: the close-confirm overlay auto-cancels on the disconnect transition and on reconnect.
- Focused `cargo test -p <crate> <filter>`, `cargo clippy -p <crate> --all-targets -- -D warnings`, `cargo fmt`, and `npm run check` plus the touched vitest files are green.
- Owner hand-smoke on the live gateway: with windows open on a devserver, reboot the remote machine. Windows hold on the connecting screen; closing one during the outage sticks; no close prompt is ever found behind another window; when the remote returns, every window recovers without manual Cmd+R.

## Boundaries

- Desktop crate and its bundled `connecting` page only. No gateway changes, no SPA contract changes, no chan-server changes.
- No persisted pending-delete across a desktop restart (documented residual).
- No redesign of the window watcher, the feed, or the reconnect cadence; this item changes decisions at the edges, not the loops.
- No change to the CloseConfirmOverlay's copy or its three actions.
