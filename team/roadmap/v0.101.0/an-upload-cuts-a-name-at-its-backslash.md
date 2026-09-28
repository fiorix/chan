# An upload cuts a file's name at its backslash, and the desktop refuses an upload into a directory whose name holds one

Status: raised for a decision on 2026-09-28 by the order that built the backslash's Rust half ([a-backslash-in-a-name-reads-two-ways-on-the-wire](a-backslash-in-a-name-reads-two-ways-on-the-wire.md)): its builder's plan named the upload's cut (`dev/v0101-team/followups/followup-Runtime-Lead-22.md` in the development tree, section 1.2), the lead ruled that the cut stays as a guard and is raised for the owner (`dev/v0101-team/followups/followup-Lead-Runtime-38.md`, ruling 4), and the builder's sweep of the desktop found the refusal (`dev/v0101-team/reports/report-Runtime-33.md`, its sweep and its residuals). Read at `fe2708e45`; not run. Recommendation, the lead's: a later version, since the cut guards a name that a client sends, and what replaces it is a question of what a Windows client may send.

## What was seen

- **An upload of a new file takes its name from the client's name cut at the last `/` or `\`** (`upload_leaf_filename`, `crates/chan-server/src/routes/files.rs:2708-2723`, the cut at `:2709-2714`). The workspace's upload into a directory (`workspace_upload_target`, `:2673-2706`, the call at `:2700`), the standalone Files window's (`crates/chan-server/src/routes/standalone_fs.rs:831`) and the terminal's (`crates/chan-server/src/routes/transfer.rs:820`) all take it; an upload that replaces a named file keeps the path it names (`files.rs:2679-2689`). The cut is pinned for a Windows path, `C:\tmp\report.pdf` landing as `report.pdf` (`upload_leaf_filename_uses_basename_and_rejects_empty_names`, `files.rs:3309-3323`). So on Unix a file named `a\b.md` uploads as `b.md`.
- **The desktop's native upload refuses a workspace-relative target that holds `\`,** whether the target is a directory or a file's path, with "native upload target must be a workspace-relative path" (`validate_workspace_rel`, `desktop/src-tauri/src/upload.rs:281-297`, applied at `:38-48`); a test pins `a\b` among the targets refused (`upload_destination_validation_is_workspace_relative`, `upload.rs:472-492`). Since 2026-09-28 the server sends a directory named `x\y` as itself on every surface (`crates/chan-workspace/design.md:88`), as the one-level listing did already (the report's control on the listing, "Red first"), so a native desktop upload into such a directory is refused.

## Desired contract

The owner decides what a `\` in an uploaded file's name means on a server that reads it as part of a name: the file lands under its whole name, or the cut stays as a guard and the design document says so. The desktop's native upload accepts a target directory that the server lists, or its refusal says why.

## What to do

The owner rules first. Suggestions beyond the record: cut a client's name at `\` only on a server whose platform reads `\` as a separator, which changes what a name such as `C:\tmp\report.pdf` from a Windows browser gives on a Unix server (the case `files.rs:3312` pins); and have the desktop split a workspace-relative target into components as the server does, refusing only what the server refuses. Red first, per the ruling: an upload of `a\b.md` on Unix lands as ruled, and a native upload into `x\y` is accepted or refused with its reason.

## Boundaries

`crates/chan-server/src/routes/files.rs` (`upload_leaf_filename`) with its three callers and their tests, `desktop/src-tauri/src/upload.rs` (`validate_workspace_rel`) and its tests, and the design documents that describe an upload. The web app's copies of `basename` are [a-backslash-in-a-name-reads-two-ways-on-the-wire](a-backslash-in-a-name-reads-two-ways-on-the-wire.md)'s.

## Acceptance

1. The owner's ruling on the cut is in place, and a Unix upload of `a\b.md` lands as it rules, pinned.
2. A native desktop upload into a directory whose name holds `\` is accepted, or refused with a sentence that says why, pinned.
3. The design documents say what an upload does with such a name.
