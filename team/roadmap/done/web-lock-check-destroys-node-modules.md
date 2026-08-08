# `make web-lock-check` deletes `node_modules` while claiming it does not

Status: SHIPPED in [v0.86.0](../release/release-v0.86.0.md). Environment-fixed and re-scoped: the target refuses npm below 10 and the comment states the version dependence.

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

## Re-verified 2026-08-07, and the premise does not hold on this host

The target is at `Makefile:381` (not 386) and the quoted comment is verbatim at `Makefile:373-375`. But the host's only npm is 10.9.8 under `~/.local/node-v22.23.1-linux-x64`, not the 9.2.0 the grounding records; there is no `/usr/bin/npm` or `/usr/local/bin/npm`, a login shell resolves the same binary, and `NPM ?= npm` resolves via PATH. npm 10.9.8's own `lib/commands/ci.js:79-97` guards the `node_modules` removal behind `if (!dryRun)`, and the lockfile-sync `usageError` fires before that phase, so on the installed npm the target validates non-destructively, exactly as its comment claims. This is a source-level reading of npm, deliberately not an execution of the destructive command. CI pins Node 20, whose npm 10.x carries the same guard.

The node install symlink predates the 2026-08-05 incident, so the incident either ran under a different toolchain than the one attributed or the version was misread; the v0.85.0 release record repeats the 9.2.0 attribution. As written, the item's acceptance would pass trivially today and its investigation budget aims at an npm version nothing here runs. Before execution the item must be re-scoped: re-ground the incident (which npm actually deleted the tree, and from which environment), then either close this as environment-fixed while adding a version floor or a pinned behavioral check to the target, or narrow it to the surviving defect, which is that the comment makes a load-bearing version-dependent claim no test pins.

## Ruling 2026-08-07: re-scoped to pinning the version-dependent claim

The owner accepted the re-scope. The re-grounding, as far as it can be taken without the incident environment: the deletion observation itself stands, but the host cannot have produced it. The host's only npm is 10.9.8, whose `ci.js` guards the removal phase behind `if (!dryRun)`, and its node install predates the incident. The recorded 9.2.0 matches the Ubuntu apt npm rather than anything installed on the host, and the round drove gates through disposable Ubuntu sdme guests, so the incident most plausibly ran under a guest's apt npm 9.2.0, where the delete phase does precede the dry-run short-circuit. The residual uncertainty is which exact environment ran it, and chasing that further buys nothing: the class is "npm 9 deletes, npm 10 does not", which is established from both versions' sources.

The item is therefore environment-fixed on the host and CI (Node 20, npm 10.x), and its surviving defect is the one the release record already generalised: the comment makes a load-bearing behavioural claim that holds only above an npm major nothing pins. The re-scoped work: `make web-lock-check` refuses with a clear message when the resolved npm major is below 10, the comment states the version dependence instead of asserting unconditional safety, and the target keeps its ability to go red on a genuinely desynced lockfile. The original contract and acceptance below stand as written except that "on the pinned npm version" now means npm >= 10 enforced by the floor, and the destructive-behaviour reproduction is not attempted on the host.

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
