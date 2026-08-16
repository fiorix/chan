# A standalone terminal window cannot reach the files it is about

Status: REGISTERED 2026-08-15, after the fact. The work was built on `mini-workspace` before an item existed for it; this records the accepted scope so the release carries it as scope rather than as an unattributed line, following the precedent set for three v0.88.0 items. Implemented and merged into the v0.91.0 candidate.

## What

A standalone terminal window is a terminal and nothing else. The shell inside it can `cd` anywhere on the machine, read anything, and write anything, but the window around it can show none of that: no file browser, no editor, and no way to open a file the shell just produced. `cs open PATH` from inside such a window has nowhere to route, so it refuses; the same command from a workspace window refuses too whenever the path escapes that workspace.

So the surface a user actually drives from -- an agent working in a terminal, a shell session on a remote devserver -- is the one surface that cannot look at what it is working on. The workaround is to register a workspace for a directory the user has no intention of curating, which creates a registry row, a lock, an index and a graph for what was meant to be a glance.

## Desired contract

- A standalone terminal window can browse and edit the machine's filesystem, with no workspace, no registry row, no lock, no index and no graph.
- That surface is strictly narrower than a workspace, and the difference is deliberate rather than incidental: symlinks are inert rather than followed, deletes reach regular files and empty directories only, moves and copies do not clobber, and a start directory is protected from being moved or removed out from under the window.
- What a window can do is decided by its capabilities, and the server decides them. A workspace window does not acquire files capabilities, and a files window does not reach workspace-only routes.
- `cs open PATH` and `cs terminal new --path` work where the files are, and a path that escapes a workspace is routed to a standalone window rather than refused.
- A burst of routed opens fills one window, not one window per file.

## Implementation boundaries

- The capability core is `chan-workspace`: a crate-private `RootedFs` extracted from `Workspace` (which delegates to it, so there is one implementation of the guards rather than two), plus a public metadata-free `MiniWorkspace` over it.
- The serving surface is `chan-server`: the standalone Files routes, a scoped non-recursive watcher, and a mutation bus that attributes a window's own writes so it does not see them as external changes.
- Window minting, the app discriminator and the session namespace are `chan-library`.
- The SPA gains one capability model driven by the window kind plus what the tenant advertises, and a Files layout namespace.

## Acceptance

- The extraction is behaviour-preserving: every guard `Workspace` had is still reached, in the same order. A guard that moved relative to path canonicalization is the failure mode to look for.
- The capability gate holds on the server, not only in the client.
- The new backend sits behind the same bearer as every other route.
- The watcher never takes a recursive watch of `/`, and never reports paths outside a subscribed scope.
- A window's own atomic-write temporaries are not shown to it as files.
- Deletes, moves and copies refuse the cases the contract names, including a destination inside its own source.

## Rough size

Large, and the largest single surface in the release. The security boundary is the part that deserves the review time; the SPA work is broad but shallow.

CLOSED: shipped in [v0.91.0](../../release/release-v0.91.0.md).
