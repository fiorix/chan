# The desktop handoff keys an absent root before it creates it

Status: raised during v0.101.0 on 2026-09-26 by the independent review of a test-only order (`dev/v0101-team/reviews/review-Services-1.md`, finding 4, in the development tree), which found it older than that order's range and unreachable from shipped senders. A source reading against `main` at `1566b06d0`; not reproduced.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: the key is computed after `register_workspace_path` has created the directory, or the record is keyed from the row that call returns; red first with an absent path. The services lane's, with the relinked-root nesting item.

## What was seen

The desktop's CLI handoff computes `canonical_key(&path)` for the requested root (`desktop/src-tauri/src/main.rs:2889`) before `register_workspace_path` may create the directory (`main.rs:1124-1125`). For a path that does not exist at arrival, the key is the lexical fallback (`crates/chan-workspace/src/paths.rs:431`), and `serve::start` mints the window record with that spelling (`desktop/src-tauri/src/serve.rs:112`). Since the feed matches records lexically against the runtime's stored keys (`crates/chan-library/src/host.rs:2103`), such a record is hidden and the desktop opens nothing. Before that change the feed canonicalized each record at read time, so the record resolved once the directory existed. The shipped CLI creates the root (`crates/chan/src/lib.rs:3927`) before it hands off (`:3944`), so only a race between the two or a client that does not create the root reaches this.

Read again on 2026-09-28 at `b39274a1a`, where it holds: the handoff computes the key first (`open_workspace_from_handoff`, `desktop/src-tauri/src/main.rs:2960`), the registration that may create the directory runs later on the blocking pool (`:2987-2993`), and `serve::start` mints with the key (`serve.rs:113`). The same reading adds a cost the lead's notes on the relinked root's code map raise for this landing (`dev/v0101-team/int28-docs/codemaps/relinked-root-one-row.md` in the development tree, the lead's notes, ruling 6): the key is computed on the task that handles the handoff. `canonical_key` resolves the path through the filesystem (`main.rs:4533-4543`), and `open_workspace_from_handoff` calls it before anything is awaited, inside the handoff listener's async handler (`:5326-5337`); the handoff's close does the same (`close_workspace_from_handoff`, `:3036-3047`). Neither has a bound of its own, so for a root that stops answering the resolution holds the runtime worker that runs the handler, which is inferred and was not run. The desktop's half of [a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md), not ordered yet, changes the same function.

## Desired contract

A handoff for a root the desktop creates keys the root after it exists, so the record it mints is the spelling the feed matches.

## What to do

Compute the key after `register_workspace_path` has created the directory, or key the record from the registry row that call returns. Red first: a desktop or host-level test that hands off an absent path and asserts the minted record is in the feed once the workspace is mounted; today it is hidden.

## Boundaries

`desktop/src-tauri/src/main.rs` (the CLI handoff) and `serve.rs`; nothing in the feed match or the root locks.

## What shipped

Landed on 2026-09-28, with the desktop's half of [a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md), whose order carried both items; lines at `d440ab656`. The builder's report is `dev/v0101-team/reports/report-Services-36.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Services-36.md` and the rulings on its plan (`dev/v0101-team/followups/followup-Lead-Services-29.md`), with an independent review and a fix round, which that item names; the lead read the production diff whole (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-28 20:20Z). The report reads this item's desired contract as met (its "The two items' acceptance").

- **The handoff computes no key before the registration.** It asks the host whether a workspace runtime goes by the path as sent, from the keys the host stores (`open_workspace_from_handoff`, `desktop/src-tauri/src/main.rs:2978`), and otherwise registers the path on the blocking pool, which creates a missing directory first, and starts the workspace by the root that the registration answers, the root its registry row stores (`register_workspace_path`, `main.rs:1137-1149`; `:2982-3013`). A new row stores the canonical form of the path, resolved once the directory exists (`touch_matched`, `crates/chan-workspace/src/registry.rs:393-400`), so the window `serve::start` mints stores the root the window feed goes by (`serve.rs:119-120`; `WorkspaceHost::mint_workspace_window`, `crates/chan-library/src/host.rs:2571-2591`).
- **Pinned red first:** a root handed off under a symlinked parent before it exists is created, and its window is in the feed and stored under its new registry row (`a_root_handed_off_under_a_symlinked_parent_before_it_exists_is_in_the_feed`, `main.rs:9767`), red at the order's test commit with the window stored under the path as typed and not in the feed (the report, "Pins"). The pin makes its own symlinked parent, since the step that runs the suites under a symlinked temp directory does not run the desktop crate.
- **The cost that this item's reading of 2026-09-28 added, the resolution on the handler's task, is gone from the open:** the handler resolves nothing, pinned by two tests that hold every resolution of the root and require the handler to answer within the CLI's reply bound, for a mounted root and for one that is not (`main.rs:9738`, `:10048`), each 400 runs, 200 of them on one CPU. **It stays in the close:** the handoff's close resolves the path it is sent, and a forget the runtime's stored root, on the handler's task with no bound (`close_workspace_from_handoff`, `main.rs:3047`, `:3057`), which the order left to another (`task-Lead-Services-36.md`, leaning 5); it is written as a cost in [a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md) and no item holds it.

**Not shown on a display:** nothing that the shipped `chan serve` can reach, since it creates the root before it hands it off (`crates/chan/src/lib.rs:3883-3886`, the handoff at `:3897-3900`), so a window of a root it creates opened in `v0.100.0` as it opens now. The changelog's entry for it is `CHANGELOG.md:33`.
