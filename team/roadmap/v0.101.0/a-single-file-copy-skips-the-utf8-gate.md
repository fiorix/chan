# A single-file copy skips the UTF-8 gate

Status: raised during v0.101.0 on 2026-09-25 from the copy-and-pin lane's report and the independent review of that lane, which confirmed it at `main` `a83900a29` with a probe (`dev/v0101-tasks/evidence/cpin/probe-copy-plain-utf8.log`), accepted by the owner the same day and landed with that lane's second round.

## What was seen

`MiniWorkspace::copy_plain`'s single-file branch stages the destination under a sibling named `.{leaf}.chan-copy-{hex}`. `write_atomic_stream` decides whether to check UTF-8 by classifying the path it writes, `fs_ops::classify` splits on the last dot and reads the stage name as `Other`, so the gate every editable class gets on a direct write (`.md`, `.rs`, `.json`, `README`, and the rest) is skipped on a copy. The probe copies `blob.bin` onto `note.md` and the copy lands with the binary bytes. The standalone Files paste reaches this branch (`TransferOp::Copy`).

## Desired contract

A copy to an editable-text name is refused for non-UTF-8 content exactly as a write to that name is, and the refusal names the destination.

## What to do

Write the single file into a stage directory under the destination's own leaf name and publish it with the no-replace rename, the shape `RootedFs::copy` now has; share its stage, publish and guard helpers rather than copying them. A `mini_workspace` test mirrors the workspace copy's non-UTF-8 refusal.

## Boundaries

`crates/chan-workspace/src/{mini_workspace,rooted_fs}.rs` and their tests.
