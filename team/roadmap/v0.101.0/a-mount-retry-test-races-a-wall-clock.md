# A mount-retry test races a five-second wall clock

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the Lead follow-ups ledger (2026-09-22 20:01Z, main CI run `35774295414` attempt 1, green on re-run). A source reading against `main` at `6237c2677`.

## What was seen

`host::tests::interrupted_mount_already_open_reports_releasing_and_allows_retry` (`crates/chan-library/src/host.rs:5137`) wraps a real-filesystem sequence in `tokio::time::timeout(Duration::from_secs(5), ...)` (`:5138`). A slow Windows runner expired it once; the timeout guards against a hang, but it is also a performance assertion the test did not mean to make.

## What to do

Widen the bound well past any runner's filesystem latency, or replace it with the paused-clock or channel rendezvous the neighbouring tests use, so a slow runner cannot red it while a real hang still fails.
