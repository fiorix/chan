# No test pins the devserver's root health probe

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's residuals, recorded by the v0.100.0 item `a-replaced-root-still-reads-running-on-the-desktop`. A source reading against `main` at `6237c2677`.

## What was seen

The devserver starts the root health probe from its run loop (`spawn_root_health_probe`, `crates/chan-server/src/devserver.rs:324`, called at `:1883`), and the desktop starts the same probe from its embedded host. The cadence is pinned, but no test fails if the devserver's call is removed, so the devserver's half is verified by reading only.

## What to do

A devserver-level test that replaces a mounted root and observes the row turn unavailable within the probe interval, shown red with the call removed.
