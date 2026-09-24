# Profile's background workers have no shutdown owner

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the gateway review, line 7073 (`RevocationCoordinator::spawn`, whose coordinator API is gone while the worker and sweeper stay detached), carried by the gateway-lows lane and recorded in the release report. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 with the lead's shape (both workers started at service startup, their handles kept, cancelled and joined at shutdown, and a worker-free router for tests), plus a requirement from the owner: test the lifecycle end to end and under interruption, with a SIGINT or a SIGKILL landing during start or stop, and recover without blocking the user. The worst case the owner names is this data corrupted and the user unable to load their workspace. Recovering, rebuilding, resetting and similar operations are all options to weigh for each case that can break the data or the start and stop lifecycle; resilience is the requirement.

## What was seen

Building profile's router starts the durable revocation worker detached: `http.rs` calls `revocation::spawn_worker` (`gateway/crates/profile/src/http.rs:75`), which `tokio::spawn`s its loop and keeps no handle (`gateway/crates/profile/src/revocation.rs:77`). `main.rs` spawns the registry sweeper and discards its handle too (`gateway/crates/profile/src/main.rs:68`). Neither is cancelled or joined at shutdown, and every router a test builds starts another worker. Durable replay makes an interrupted job safe to resume, so this is lifecycle ownership rather than data loss.

## What to do

Start both tasks from service startup rather than router construction, keep their handles, cancel and join them after the HTTP server shuts down, and give router tests a way to build a router without a worker, with shutdown and teardown covered by tests.
