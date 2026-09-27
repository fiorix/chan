# The terminal tenant answers for a registered home workspace

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by an independent reading of the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md), widening two items raised the same day, [is-root-mounted-answers-from-the-first-tenant-the-key-finds](is-root-mounted-answers-from-the-first-tenant-the-key-finds.md) and [the-canonical-key-query-counts-the-terminal-tenant](the-canonical-key-query-counts-the-terminal-tenant.md), which it absorbs; read in code and not reproduced, a source reading against `main` at `ef33cb0f3`.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: a lookup that asks about a workspace finds only runtimes holding one, on the `found_by` lookups and both collision checks, pinned with the terminal tenant up on both hosts; a registered home workspace mounts and resolves like any other. It is built with [is-root-mounted-answers-from-the-first-tenant-the-key-finds](is-root-mounted-answers-from-the-first-tenant-the-key-finds.md) and [the-canonical-key-query-counts-the-terminal-tenant](the-canonical-key-query-counts-the-terminal-tenant.md), which are instances of the same lookup and land with it.

## What was seen

The shared terminal-only tenant stores the home directory as both of its keys, and every by-key lookup in `WorkspaceHost` that goes through `found_by` counts it: `hosted_for_key`, and so `open_or_get_registered_workspace`, hands it back as the existing mount of a workspace registered at the home directory, and `open_workspace`'s pre-check and insertion check refuse that workspace with "workspace already mounted". Both hosts mount the terminal tenant before they restore workspaces, so a home-directory workspace cannot mount while chan runs. On the desktop, turning such a workspace on hands back the terminal tenant's launch URL and its windows resolve to that tenant. On the devserver, the mount attempt succeeds with the terminal tenant's token and prefix, and the next save finds no tenant at the record's prefix and turns the row off. The two narrower holes raised before (the by-root query reading the first matching runtime; the canonical-key query counting the tenant in the window feed, the devserver list and the health probe) are instances of the same lookup. `is_workspace_mounted_by_key`, added with the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md), is the one lookup that counts only runtimes holding a workspace.

## Desired contract

A lookup that asks about a workspace finds only runtimes holding a workspace; the terminal-only tenant is never the answer for a registered root, and a workspace registered at the home directory mounts and resolves like any other.

## What to do

Give the `found_by` lookups and both collision checks the workspace-only filter `is_workspace_mounted_by_key` has (or key the terminal tenant so no registered root can match it), then pin, with the terminal tenant up: a registered home workspace mounts on both hosts, its windows resolve to it, the window feed, the devserver list and the health probe read it, and the by-root query answers true. It closes the two absorbed items.

## Boundaries

`crates/chan-library/src/host.rs` (`found_by`, `hosted_for_key`, the collision checks, the by-root and canonical-key queries) and its tests; the devserver list in `crates/chan-server/src/devserver.rs`.
