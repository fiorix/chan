# `make web-lock-check` deletes `node_modules` while claiming it does not

Status: REGISTERED for v0.86.0, grounded 2026-08-05 by a live incident.

## What

`make web-lock-check` runs `cd web && npm ci --dry-run --ignore-scripts` (`Makefile:386`). On npm 9.2.0, which is the version pinned on the development host, `npm ci` performs its `node_modules` deletion phase before `--dry-run` short-circuits the install. The command removes every installed package and leaves behind only `node_modules/.package-lock.json`.

The comment directly above it states the opposite:

```
# This runs among the static checks, before anything can rewrite the file,
# and costs about two seconds. --dry-run resolves and validates without
# touching node_modules.
```

The `--ignore-scripts` rationale in the same comment shows the author knew lifecycle scripts still run under `--dry-run`. The delete phase behaves the same way and was missed.

## Why it has not been noticed

Inside `make pre-push` the damage is masked. `web-lock-check` runs at step 5, and later web steps run `npm install` and repopulate the tree, so the gate completes green and leaves a healthy `node_modules` behind. The command is destructive exactly when it is run on its own, as a cheap "safe" validation, which is what its comment invites.

## Verified current state (2026-08-05)

Confirmed during the v0.85.0 delivery round, where it cost real time:

- `npm --version` on the host is `9.2.0`.
- A member ran `npm ci --dry-run --ignore-scripts` in the shared implementation worktree to verify a fresh install. The tree went from 293 populated entries with a working `.bin/vitest` to a single `.package-lock.json`, with no other install running.
- The directory inode stayed at 12288 bytes, the size of a directory that had held hundreds of entries, which is how the deletion was distinguished from an install that never populated.
- The failure is silent in the worst way: an entry count taken during the deletion still reads plausibly, because top-level package directories are emptied before they are removed. Only probing an actual binary, such as `node_modules/.bin/vitest`, distinguishes a healthy tree from a dying one.

## Contract

- `make web-lock-check` validates lockfile sync without modifying `node_modules`, on the pinned npm version.
- The comment describes what the command actually does.
- If no npm subcommand can validate sync non-destructively on the pinned version, the target either runs against a throwaway directory or the check moves to a form that reads the lockfile directly. Silently reinstalling afterwards is not a fix, because it restores the cost the check was written to avoid.

## Acceptance

- Running `make web-lock-check` twice in a row in a populated tree leaves `node_modules` intact both times, proven by probing an installed binary before and after rather than by counting entries.
- The check still fails on a genuinely desynced lockfile. Per the gate discipline, break it on purpose once, capture the red, then fix it: a lockfile validation that cannot go red is worse than none, and this target exists because v0.83.3 lost its Cachix lane to a desync that every other gate step silently repaired.
- The check does not go red on success, on a fresh checkout with no `node_modules` at all, which is the CI runner case the `--ignore-scripts` flag was added for.

## Rough size

Small, but it needs care: the target guards a real failure that shipped once, so the replacement has to keep catching it. The investigation of what npm 9.x offers for non-destructive lockfile validation is most of the work.
