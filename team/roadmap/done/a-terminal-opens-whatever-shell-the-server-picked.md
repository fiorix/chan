# A terminal opens whatever shell the server picked, and the user cannot say otherwise

Status: REGISTERED 2026-08-15, after the fact. The work was built on `feat/terminal-profiles` before an item existed for it; this records the accepted scope so the release carries it as scope rather than as an unattributed line, following the precedent set for three v0.88.0 items. Implemented and merged into the v0.91.0 candidate.

## What

A terminal spawned by chan runs one shell: whatever the built-in resolution picks for the host. There is no way to ask for a different one, and no way to see what the machine offers.

That is thinnest where a machine genuinely has several. On Windows the realistic set is PowerShell 7, Windows PowerShell, cmd, Git BASH, and one entry per installed WSL distribution, and they do not share an argument convention: `-NoLogo` is meaningful to PowerShell and meaningless to cmd, `-l` opens a login shell for a POSIX shell and means "list distributions" to `wsl.exe`. A single built-in choice cannot serve that set, and a free-form command box is not the answer either, because the user would have to re-derive the argument convention every time.

## Desired contract

- The server discovers the shells present on the machine and publishes them as named profiles, each carrying its own program, arguments and argument convention.
- The user can declare profiles in `server.toml`: override a discovered one (rename it, change its arguments), hide one they never use, or add one discovery cannot find. `terminal.default_profile` names which one new terminals get.
- A terminal remembers the profile it was opened with across restart, server restart, and page reload.
- Picking a profile is a one-click affordance next to the action that creates a terminal, not a settings trip.
- Nothing about this changes what a client that names no profile gets. A caller that never asks behaves exactly as it did before profiles existed.

## Implementation boundaries

- Discovery, the profile schema and the merge are `chan-library`: `terminal_sessions/shell_profiles.rs` and `config.rs`. The parsers are pure so the argument conventions are table-tested on every CI arm rather than only where the shell exists.
- The endpoint and the spawn parameter are `chan-server`: `routes/terminal.rs`, mounted on both the full and the terminal-only router.
- The picker is the SPA: a store over the endpoint, rendered by the pane hamburger.
- Not in scope: a Settings editor for profiles. Authoring is by hand in `server.toml`, and the config reference says so.

## Acceptance

- A machine with more than one shell lists them all, with the argument convention each one actually takes, verified on real Windows hardware including at least one WSL distribution and Git BASH.
- A profile declared in a running server's `server.toml` is spawnable without restarting the server. The endpoint that feeds the picker and the code that spawns must not be able to disagree.
- A malformed profile entry costs the user that entry and nothing else. It must never fail the config load, because the next settings write would then persist in-memory defaults over the rest of their file.
- `chan config get` answers for both new keys on a default config.
- A tab keeps its shell across restart, server restart, and reload.

## Rough size

Medium. The discovery matrix is the bulk of it and most of that is Windows.

CLOSED: shipped in [v0.91.0](../../release/release-v0.91.0.md), with discovery narrowed to Windows -- macOS and Linux keep the login shell, and the feature stays available there through declared profiles.
