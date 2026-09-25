# A cut-paste can replace the first moved file

Status: raised during v0.101.0 on 2026-09-25 from the copy-and-pin lane's open question and the independent review of that lane, which confirmed it at `main` `a83900a29` by reading; accepted by the owner the same day and landed with that lane's second round, with the race window held open in a test.

## What was seen

The workspace's cut-paste (`fs_transfer_batch_sync` through `rename_with_link_rewrite` and `Workspace::rename`) resolves a free destination name and then calls `RootedFs::rename`, whose `preflight_rename` checks the destination and whose commit is a plain rename. Two cut-pastes that resolve the same free name both pass the check and both rename; the second replaces the first moved file, and because both were moves, the first has no source copy left. The doc on `resolve_free_name` calls the rename the TOCTOU-authoritative step, which a plain rename is not.

## Desired contract

A move whose preflight saw the destination absent commits with a rename that refuses an existing name and answers the conflict; a lost race never replaces a file.

## What to do

In `RootedFs::rename`, commit with `rename_no_replace` when the preflight saw the destination absent, mapping `AlreadyExists` to `PathAlreadyExists`; keep the plain rename only for the same-file cases the preflight allows (rename-to-self, a case-only alias), which means the preflight reports whether the destination existed. Correct the `resolve_free_name` doc. Red first with the race window held open.

## Boundaries

`crates/chan-workspace/src/{rooted_fs,workspace}.rs` and their tests.
