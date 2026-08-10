# A publish=false dry run does not predict the tagged run

Status: REGISTERED 2026-08-10, from the v0.87.0 GA run failing at a step the dry run had passed on the identical tree hours earlier. IMPLEMENTED in v0.88.0: the eight `Swatinem/rust-cache@v2` jobs in `release.yml` were enumerated and sorted into build artifacts and tooling, `DMG_VENV` and `TAURI_CLI_ROOT` both moved out of the cached `target/` into `.build-tools/`, the venv guard changed from testing a file to running the venv, and the release skill gained this second limitation next to the pin-related one. The audit also falsified this item's own premise: `73a33b9c`, described below as making the failure "impossible", was still reusing a venv whose interpreter had moved, demonstrated on a real venv. Not covered: `build-dmg.sh` needs macOS, so the DMG path itself was exercised by nothing here and is first exercised by the next `publish=false` dry run, which after this change takes the same path the tagged run will.

## What

`release.yml` with `publish=false` is the mandatory pre-GA check, and the release skill is explicit that it cannot see a lockfile desync or a stale Nix hash because it runs before the version pins move. That limitation is known and written down. This item is about a second one that is not: **the dry run and the tagged run can take different code paths on the same source, because a step's behaviour depends on cache state rather than on the tree.**

v0.87.0 demonstrated it. The `publish=false` dry run on `479c102e` passed `macOS desktop package`. The tag pushed at that same commit failed the same job:

```
packaging/desktop/build-dmg.sh: line 44:
  .../target/dmg-venv/bin/pip: No such file or directory
make[1]: *** [app-notarized] Error 127
```

`DMG_VENV` defaults to `target/dmg-venv` (its `DMG_VENV ?=` line in `desktop/Makefile`) and the job runs `Swatinem/rust-cache@v2` over `target/`, so the venv is cached between runs. The dry run created it fresh and passed; the tagged run restored it and died. Same commit, same workflow, different cache. The guard tested only for `dmgbuild`, and `python3 -m venv` over a directory that already has a `pyvenv.cfg` reuses it and skips `ensurepip`, so `bin/pip` was never recreated.

## What was already fixed, and what it does not fix

`73a33b9c` clears the venv before creating it, installs through `python -m pip` rather than the `bin/pip` console script, and turns an interpreter with no `ensurepip` into a named error instead of exit 127. That makes this particular failure impossible.

**That last sentence is wrong, and it is left standing because being wrong is the point.** The 2026-08-10 audit below found the fix clears the venv only when `[ ! -x "$venv/bin/dmgbuild" ]`, and a cache-restored console script stays present and executable when its interpreter moves. The failure it calls impossible was still reachable at v0.88.0's open. Read this section as the belief the item was registered on, not as a statement of fact, and see "The premise this item was registered on was too generous to `73a33b9c`".

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

## Audited and implemented 2026-08-10 (v0.88.0)

### The premise this item was registered on was too generous to `73a33b9c`

The item says the venv instance is "already fixed" and that the fix "makes this particular failure impossible". It narrows it; it does not close it.

`73a33b9c` clears and rebuilds only when `[ ! -x "$venv/bin/dmgbuild" ]`. `-x` tests permission bits, not whether the script's shebang resolves. A venv records the ABSOLUTE path of the interpreter that created it, so when that interpreter moves -- the exact scenario the code comment above the guard describes -- `bin/python` dangles while `bin/dmgbuild` remains a present, still-executable script. The guard passes, the rebuild is skipped, and the run dies at the exec.

Demonstrated rather than argued, on a real venv with its interpreter symlink repointed at a missing path:

| venv state | `[ -x bin/dmgbuild ]` | `python -c 'import dmgbuild'` | running it |
| --- | --- | --- | --- |
| healthy | present | usable | exit 0 |
| interpreter moved | present | unusable | **exit 126** |

The shipped guard says "reuse" on the second row. So the class was live at round open, one layer down from where v0.87.0 found it: same step, same job, same passing-dry-run/failing-tag signature, and a bad-interpreter exit rather than the missing-`bin/pip` 127.

### The enumeration the acceptance asks for

`release.yml` has eight `Swatinem/rust-cache@v2` uses, all caching the `chan` workspace's `target/`, one in each of the eight jobs named in the table below. The job name is the anchor; the line numbers in that table are indicative and will drift.

Method, so it can be re-run: `grep -rn "Swatinem/rust-cache\|actions/cache" .github/workflows/` for the cache sites, then `grep -rn "target/" .github/workflows/` and `grep -rn "venv\|cargo install\|pip install\|npm install -g\|CARGO_TARGET_DIR" packaging/ scripts/ desktop/Makefile Makefile .github/workflows/` for what is written there. Its blind spot: a tool staged under `target/` by a path assembled at runtime, or by a third-party action, is invisible to a lexical search.

| job | line | what it puts under `target/` | verdict |
| --- | --- | --- | --- |
| linux-validate | 117 | compiler output | artifacts |
| linux-cli-artifacts | 163 | compiler output, musl tarball | artifacts |
| gateway-linux-packages | 233 | compiler output, debs | artifacts |
| linux-desktop-artifacts | 313 | compiler output, AppImage bundle | artifacts |
| macos-validate | 388 | compiler output | artifacts |
| macos-cli-artifact | 408 | compiler output | artifacts |
| macos-desktop-artifacts | 450 | compiler output, bundle, **`target/dmg-venv`** | **tooling** |
| windows-artifacts | 605 | compiler output, NSIS bundle | artifacts |

Two tool paths exist, and only one of them was known:

1. **`target/dmg-venv`** (the `DMG_VENV ?=` line in `desktop/Makefile`, and `packaging/desktop/build-dmg.sh`) -- the known instance, live as shown above.
2. **`target/tauri-cli`** (the `TAURI_CLI_ROOT :=` line in `desktop/Makefile`, installed with `cargo install --root` behind a presence check) -- the second instance, and it is **latent rather than live**. Every job that runs a desktop make target installs tauri-cli globally through `taiki-e/install-action@v2` first (`release.yml` 336/472/615, `release-desktop.yml` 71, `ci.yml` 59/95/126), so the Makefile's own install never fires and the directory is never created or cached. What makes it worth fixing anyway is that `TAURI := PATH="$(TAURI_CLI_ROOT)/bin:$$PATH" cargo tauri` prepends that directory unconditionally: it is a no-op only because the directory does not exist. Populated and cached once, a restored copy silently outranks the pinned tool a job just installed, and `TAURI_CLI_VERSION` is applied at install time only, so a restored one is never re-checked. That failure presents as a wrong tauri-cli version rather than a missing file, which is harder to read than the 127 it resembles.

### What changed

- `.build-tools/` is added to `.gitignore` as the home for build-time-only tooling, with the reason recorded at the ignore site so it is not tidied back under `target/`.
- `DMG_VENV` and `TAURI_CLI_ROOT` both move there. Acceptance line 1 is met by relocation rather than by cache configuration, because a `paths` exclusion lives in the workflow while the default lives in the Makefile, and the two drift apart silently.
- The venv guard becomes `python -c 'import dmgbuild'` through the venv's own interpreter: the predicate the next line actually depends on, failing on a missing venv, a dangling interpreter, and a missing package alike. This is the "never reused on the strength of a partial presence check" half of the contract.
- The release skill's account of what the dry run cannot see gains this second limitation next to the pin-related one, with the v0.87.0 failure as its worked example.

### Acceptance, line by line

- **`DMG_VENV` defaults outside `target/`.** Done, and `TAURI_CLI_ROOT` with it. The dry run and the tagged run now take the same path because there is no cached state left for them to differ on.
- **The other cached-tooling paths are enumerated and checked.** Done, table above, with the method and its blind spot recorded.
- **The release skill gains the second limitation.** Done.
- **A test or check that would have caught this.** PARTIAL, and deliberately not overclaimed. The guard change makes the failure impossible rather than detected, and the old-versus-new predicate comparison above is reproducible on any host with `python3`. What was NOT done is exercising the DMG path itself twice in one run: `build-dmg.sh` needs `hdiutil` and an `.app` bundle, so it is macOS-only and this round's rig is Linux-only. The mandatory `publish=false` dry run and the tagged run both exercise it, and after this change they exercise the same path, which is what the contract asks for.

### Adjacent finding, NOT one of the fourteen and not fixed here

Recorded because it is a real observation about release tooling and it was found by this
audit, not because it belongs to this item. Registered for v0.89.0 instead.

`packaging/nix/build-with-sdme.sh` creates its disposable container, at its
`"${SDME_CMD[@]}" new --name "$CONTAINER"` invocation, with neither
`--disk` nor `--storage`. `sdme new --help` gives the mechanism: `--disk <DISK>  Disk cap
for the container root, **btrfs storage only**`, and `--storage <BACKEND> ... (default:
auto)`, with its own example pairing them. So the driver's containers are uncapped, and
passing `--disk` alone would have been inert. `auto` resolves to overlay, which also
means they carry no `btrfs qgroup` entry and are invisible to the accounting other work
on the same pool is measured by.

Measured rather than asserted, during this item's own verification run, with three other
lanes building concurrently on a 96G pool:

```
sudo du -sh /var/lib/sdme/containers/chan-nix-check-<pid>    22G
```

That is the compressed on-disk figure, since the pool is mounted `compress=zstd:3` and
host `du` reports allocated blocks. **It is a sample, not the peak**: the last reading
was taken while cargo was still compiling, and the release-profile LTO link came after
it, so the true maximum was not observed and is higher by an unknown amount. Whoever
picks a cap should measure the link, not extrapolate from this number.

Not fixed in this round deliberately. `make nix-sdme-check` is on the GA
release-verification path, so a cap chosen too low converts a working release check into
a failure at a tag, while capping only buys hygiene. `--storage btrfs` also changes the
backend rather than a number, so validating it costs a full driver run. Those stakes are
not comparable, and the round ends at a GA tag.

## Rough size

Small for the venv relocation. Medium for the audit, which is a read of the workflow rather than a code change, and whose value is in finding the second instance rather than in re-fixing the first.

**Both halves came out right, and the second sentence's premise did not.** The relocation was small and the audit did find a second instance, `target/tauri-cli`. But "rather than in re-fixing the first" assumed the first instance was closed, and it was not: the same audit found `73a33b9c`'s guard still reusing a venv whose interpreter had moved. So the audit's value was finding a second instance **and** re-opening the first, and a reader planning from this estimate would have skipped the re-read that produced half the result.
