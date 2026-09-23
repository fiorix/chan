# Profile's background workers have no shutdown owner

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the gateway review, line 7073 (`RevocationCoordinator::spawn`, whose coordinator API is gone while the worker and sweeper stay detached), carried by the gateway-lows lane and recorded in the release report. A source reading against `main` at `6237c2677`.

## What was seen

Building profile's router starts the durable revocation worker detached: `http.rs` calls `revocation::spawn_worker` (`gateway/crates/profile/src/http.rs:75`), which `tokio::spawn`s its loop and keeps no handle (`gateway/crates/profile/src/revocation.rs:77`). `main.rs` spawns the registry sweeper and discards its handle too (`gateway/crates/profile/src/main.rs:68`). Neither is cancelled or joined at shutdown, and every router a test builds starts another worker. Durable replay makes an interrupted job safe to resume, so this is lifecycle ownership rather than data loss.

## What to do

Start both tasks from service startup rather than router construction, keep their handles, cancel and join them after the HTTP server shuts down, and give router tests a way to build a router without a worker, with shutdown and teardown covered by tests.
