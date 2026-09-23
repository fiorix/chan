# A move or a create can replace a file created a moment earlier

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's Rust-lows follow-up (worklist L100 and L173, the create-only rename findings); distinct from `two-copies-to-one-free-name-can-collide`, which covers `RootedFs::copy`. A source reading against `main` at `6237c2677`.

## What was seen

`MiniWorkspace::move_plain` and `copy_plain` (`crates/chan-workspace/src/mini_workspace.rs:348`, `:389`) check that the destination is free and then rename over it, so a file created in between is replaced (L100). `create_file_sync` (`crates/chan-server/src/routes/files.rs:2285`) checks for an existing file and then writes with a clobbering write (L173; the first pass read this one as a judgement call rather than a clear defect). Both are check-then-act.

## What to do

Use an exclusive create or a no-replace rename where the platform offers one, answer the lost race as the existing conflict, and decide with the owner what a platform without such a rename does. Tests hold the window open and show the second writer refused.
