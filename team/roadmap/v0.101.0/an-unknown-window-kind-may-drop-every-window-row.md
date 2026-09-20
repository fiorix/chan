# One unreadable window row may drop every window row

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog, where a tolerant reader was named a hard prerequisite for any new window kind. The mechanism below is a source reading against `main` at `fa0df75ad`; it has not been reproduced.

## What was seen

`WindowRegistry::open` (`crates/chan-library/src/windows.rs`) reads the persisted window set with `serde_json::from_slice(&bytes).unwrap_or_default()`. The file is one JSON array, so a single element that fails to deserialize fails the whole parse and the registry starts empty, with no log line. `WindowKind` is a closed enum (`Terminal`, `Workspace`, `rename_all = "lowercase"`) with no catch-all variant, and `WindowOrigin` beside it has the same shape, so any row written by a build that knows one more variant is such an element. The sibling first-open state is read the same way.

The doc comment on `open` makes the empty start deliberate for an absent or unreadable store: "the windows reappear as clients re-create them". What it does not cover is the mixed-version case this project actually runs, a desktop and a devserver on different releases, or a downgrade: an older build reads a newer file, drops every row, and its next save replaces the file, so the newer build's rows are gone for good.

No release has added a kind since the backlog raised this, which is why it has not bitten: the standalone files window shipped without one. The hazard is armed for the next wire addition to any closed enum in the record.

## Desired contract

Owner ruling, 2026-09-20: investigate, and clean up if it is possible without breaking things.

The investigation comes first and answers three questions: whether one bad row really empties the set (a test, not a reading); which persisted or wire enums in the window record are closed; and what an older build should do with a row it cannot read. Then, if the repair is safe: an unreadable row costs that row, never its neighbours, the loss is logged, and a build does not overwrite rows it could not read with a set that silently omits them.

## Boundaries

`crates/chan-library/src/windows.rs` (the registry's load, its save path, `WindowKind`, `WindowOrigin`, the first-open state) and the `*_wire` byte tests that pin the record's tags. The wire tags themselves do not change. The desktop's reconciler and the launcher feed consume these records, so a new catch-all variant has to be one they can ignore, not one they mint a native window for.

## Acceptance

1. A test writes a store holding one valid row and one row with an unknown `kind`, opens the registry, and shows what happens today; the item's title is corrected if the reading was wrong.
2. After the repair the same test keeps the valid row, and the dropped row is named in a log line.
3. A test opens such a store, saves, and shows the unreadable row is still in the file, or the item records why preserving it is unsafe and the owner accepts the loss.
4. The `*_wire` byte tests are unchanged and green.
5. The desktop and launcher are shown to ignore a row of unknown kind instead of acting on it.
