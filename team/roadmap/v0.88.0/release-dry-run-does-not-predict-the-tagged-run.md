# A publish=false dry run does not predict the tagged run

Status: REGISTERED 2026-08-10, from the v0.87.0 GA run failing at a step the dry run had passed on the identical tree hours earlier.

## What

`release.yml` with `publish=false` is the mandatory pre-GA check, and the release skill is explicit that it cannot see a lockfile desync or a stale Nix hash because it runs before the version pins move. That limitation is known and written down. This item is about a second one that is not: **the dry run and the tagged run can take different code paths on the same source, because a step's behaviour depends on cache state rather than on the tree.**

v0.87.0 demonstrated it. The `publish=false` dry run on `479c102e` passed `macOS desktop package`. The tag pushed at that same commit failed the same job:

```
packaging/desktop/build-dmg.sh: line 44:
  .../target/dmg-venv/bin/pip: No such file or directory
make[1]: *** [app-notarized] Error 127
```

`DMG_VENV` defaults to `target/dmg-venv` (`desktop/Makefile:19`) and the job runs `Swatinem/rust-cache@v2` over `target/`, so the venv is cached between runs. The dry run created it fresh and passed; the tagged run restored it and died. Same commit, same workflow, different cache. The guard tested only for `dmgbuild`, and `python3 -m venv` over a directory that already has a `pyvenv.cfg` reuses it and skips `ensurepip`, so `bin/pip` was never recreated.

## What was already fixed, and what it does not fix

`73a33b9c` clears the venv before creating it, installs through `python -m pip` rather than the `bin/pip` console script, and turns an interpreter with no `ensurepip` into a named error instead of exit 127. That makes this particular failure impossible.

It does not make the dry run predictive. Any step whose result depends on what a cache handed it can still pass in the dry run and fail at the tag, and the next one will present as a different error in a different file. The fix closed an instance; this item is about the class.

## Why it matters more than one packaging bug

The tag is the point of no return. A failure discovered there has already cost a tag push, and in this case a tag move: `v0.87.0` was deleted and re-pushed at the fixed commit, which was only safe because nothing had consumed it yet. A downstream target that had already published would have made that unavailable.

It also fits the pattern this project keeps hitting, one level out from where v0.87.0 found it. The timing sweep established that 20 isolated test runs certify nothing about a load-sensitive defect. This is the same error in release validation: a green on a run whose inputs differ from the run that matters is not evidence about the run that matters.

## Contract

- A `publish=false` dry run exercises the same code path the tagged run will, or the ways it provably cannot are written down where someone dispatching it will read them.
- Build tooling that a workflow caches is either excluded from the cache or rebuilt from scratch, never reused on the strength of a partial presence check.
- A step that depends on cache state says so.

## Acceptance

- `DMG_VENV` defaults outside `target/`, or the cache configuration excludes it, so the venv cannot vary between two runs on one commit. Whichever is chosen, the dry run and the tagged run take the same path.
- The other cached-tooling paths in the release workflow are enumerated and checked for the same shape. `target/` is cached by `Swatinem/rust-cache@v2` in more than one job, and this audit says which of them put tools rather than build artifacts there.
- The release skill's account of what the dry run cannot see gains this second limitation next to the existing pin-related one.
- A test or check that would have caught this: the DMG path exercised twice in one run, or once against a deliberately broken venv.

## Rough size

Small for the venv relocation. Medium for the audit, which is a read of the workflow rather than a code change, and whose value is in finding the second instance rather than in re-fixing the first.
