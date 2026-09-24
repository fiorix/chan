# The chan home fallback trusts a path under /var/tmp

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Rust-lows follow-up (worklist L94, security, first-pass verdict real and borderline). A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 with the lead's shape (create the fallback `0700`, refuse a symlink or a foreign owner, one test per refusal), and a ruling on what a refusal leads to: chan never blocks the user, even on a broken system. When the happy paths are not available, it drops to the safest option left, with `/` named by the owner as the worst case, instead of refusing to run. The lane chooses that last resort, says why in the code, and tests the fall-through as well as each refusal.

## What was seen

When the OS home cannot be resolved, `home_unavailable_config_dir` (`crates/chan-workspace/src/paths.rs:60`) falls back to `/var/tmp/chan-<uid>` (`:62`). `/var/tmp` is world-writable and the path is predictable, and nothing checks that an existing directory there is owned by this user, has a private mode or is not a symlink, so another local user can pre-create it. The branch is reached only when home resolution fails.

## What to do

Create the directory `0700`, and refuse a path that already exists and is a symlink or is not owned by the current user, with a test for each refusal.
