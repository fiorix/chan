# The chan home fallback trusts a path under /var/tmp

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's Rust-lows follow-up (worklist L94, security, first-pass verdict real and borderline). A source reading against `main` at `6237c2677`.

## What was seen

When the OS home cannot be resolved, `home_unavailable_config_dir` (`crates/chan-workspace/src/paths.rs:60`) falls back to `/var/tmp/chan-<uid>` (`:62`). `/var/tmp` is world-writable and the path is predictable, and nothing checks that an existing directory there is owned by this user, has a private mode or is not a symlink, so another local user can pre-create it. The branch is reached only when home resolution fails.

## What to do

Create the directory `0700`, and refuse a path that already exists and is a symlink or is not owned by the current user, with a test for each refusal.
