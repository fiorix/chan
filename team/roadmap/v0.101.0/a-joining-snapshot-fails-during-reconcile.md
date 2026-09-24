# A joining snapshot fails while a reconciliation runs

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the gateway review, line 6527 (`ControllerState::accept_snapshot`), carried by the gateway-lows lane and recorded in the release report. A source reading against `main` at `6237c2677`.

## What was seen

`ControllerState::accept_snapshot` (`gateway/crates/devserver-control/src/state.rs:513`) answers a joining proxy's snapshot with `StateError::ReconciliationInProgress` (`:525`) while another reconciliation is active, which is session-fatal for that proxy, and a disconnect keeps a `DISCONNECTED_AUTHORITY_RETENTION` marker (`:25`, `:2347`) of 60 seconds. Two proxies joining together, or one reconnecting during another's join, therefore lose their session and hold revocation authority as temporarily unavailable, which reaches fleet-wide revocation availability.

## What to do

Stage or defer a joining snapshot instead of failing it, and state what the authority marker promises during a staged join, with a test of concurrent joins and a revocation issued between them.
