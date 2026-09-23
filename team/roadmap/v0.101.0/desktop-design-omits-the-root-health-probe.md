# The desktop design does not mention the root health probe

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the Lead follow-ups ledger (2026-09-22 19:00Z, SerialWorker order 3 review). A source reading against `main` at `6237c2677`.

## What was seen

The embedded host starts `chan_server::spawn_root_health_probe` when it serves the launcher routes (`desktop/src-tauri/src/embedded.rs:193-212`), which is how a replaced or missing workspace root reads unavailable on the desktop. `desktop/design.md` describes the embedded server but never mentions the probe, its fifteen-second cadence or why the desktop owns it.

## What to do

Add a sentence to the embedded-server section of `desktop/design.md` naming the probe, where it starts and why the desktop drives it.
