# Two copies to one free name can still collide

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where the non-atomic publish edges were recorded and parked. A source reading against `main` at `d3de0180b`; the race was not reproduced.

## What was seen

`RootedFs::copy` (`crates/chan-workspace/src/rooted_fs.rs`) checks that the destination is free and then publishes it in a separate step. The check is `ensure_copy_destination_absent`, a `symlink_metadata` probe that returns an error when anything is there. The file arm then calls `copy_one_file`, which streams through `copy_file_stream` and the shared atomic writer, so the publish is a rename over whatever the name holds rather than an exclusive create; the directory arm stages a tree beside the destination, repeats the absence check and renames the stage into place. In both arms another writer can take the name between the last check and the rename, and the copy replaces it without a conflict.

The workspace already has the primitive this wants: the attachment path was given an exclusive create during the v0.99.0 loop, and it is not used here. The server picks a free name for paste collisions, so two concurrent pastes into one directory can resolve to the same free name and reach this window together.

## Desired contract

A copy publishes its destination exclusively, so of two concurrent copies to the same free name one succeeds and the other is refused with the workspace's collision error.

## Boundaries

`crates/chan-workspace/src/rooted_fs.rs` (`copy`, `copy_one_file`, `copy_file_stream`, `ensure_copy_destination_absent` and the staged-rename arm), the exclusive create the attachment path already uses, and the free-name picker in `crates/chan-server/src/routes/files.rs`.

## Acceptance

1. A test that takes the destination name between the absence check and the publish shows the copy refused rather than replacing it, and is red against today's code.
2. The directory arm's staged rename is exclusive too, pinned by its own test.
3. The refusal surfaces as the workspace's already-exists error, not a raw I/O error, so the server answers a conflict rather than a 500.
