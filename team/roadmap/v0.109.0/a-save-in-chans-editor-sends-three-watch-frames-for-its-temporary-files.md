# A save in chan's editor sends three watch frames for its temporary files

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the graph-refresh item's page half; closes in the round.

## What was seen

The core's atomic writer (`crates/chan-workspace/src/fs_ops.rs`, `atomic_write_stream_in` and `atomic_create_in`) writes through cap-tempfile: an unnamed temporary file, linked under a UUID name beside the target and renamed onto it. Under inotify that is an open and a modify on a `#<inode>` path, a create on the UUID name and a move pair under one cookie. The watch path's dispatch (`crates/chan-workspace/src/watch.rs`) has no rule for the writer's names, and the server bus's self-write origin (`crates/chan-server/src/bus.rs`, `event_self_write_origin`) notes the target only, so every save in chan's editor sends three watch frames: a `#` path modified, a UUID path created, and that path renamed onto the target. The bus's no-frame rule for a window-noted modification never meets them, since the save reaches it as a rename. Each frame takes the page's generic branch: per autosave a workspace request, a relist of the target's directory, a dropped link-kind cache and a graph cue, and, to read at the build, a co-viewer's changed-on-disk flag. The graph-refresh item's reading counted 45 frames, 15 of each, for 15 autosaves over 13 s of typing. By cap-tempfile's source the same class holds on macOS and Windows (a randomly named file renamed onto the target, without the `#<inode>` event); neither was run.

## Desired contract

A save in chan's editor reaches the watch path as one event on the target, a window that noted the save gets no frame for it, and no temporary file's event reaches a page.

## What to do

A design first, read by the review seat before code, since the reserved name and the dispatch rule are a contract across the writer, the watcher and the bus: the writer names its temporary file under a reserved `.chan-` leaf beside the target, which the scope policy excludes, opened create-new; the dispatch turns a rename from such a name onto an included path into a modified or created event of the destination and drops the temporary's own events; a watch pin (one event, on the target) and a bus pin (a window-noted save sends no frame); the macOS and Windows watchers read for the same rule.

## Boundaries

`crates/chan-workspace/src/fs_ops.rs` at the writer's naming, `crates/chan-workspace/src/watch.rs` at the dispatch, their tests, and the server's bus pins. Not changed: the write's durability (the rename stays), the scope policy's other rules, the page.

## Acceptance

1. The design read by the review seat; the watch pin and the bus pin red first at the parent.
2. The chan-workspace and chan-server suites green at the commit.
3. The graph-refresh item's reading driver run at the commit beside the base: 15 autosaves send no generic-branch frame, with the counts recorded here.
