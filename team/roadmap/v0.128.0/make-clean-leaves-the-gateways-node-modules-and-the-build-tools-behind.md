# make clean leaves the gateway's node_modules and the build tools behind

Status: raised by the owner on 2026-11-11 and accepted for v0.128.0 the same day; built the same day and merged into the release's integration branch (the section Built holds the evidence). His words: "make clean doesn't cover: gateway/node_modules and .build-tools/; it should".

## What is there now

Read at `8e41a9264`. The root `Makefile`'s `clean` target (`Makefile:902-914`) runs `cargo clean` for the root workspace, removes `web/dist`, `web/node_modules`, `web/pkg`, `web-launcher/dist`, `web-launcher/node_modules` and the two web build stamps, runs `cargo clean` in `gateway/` and removes `gateway/crates/identity/web/dist`, and delegates to `desktop/Makefile`'s `clean`, which runs `cargo clean` in `desktop/src-tauri` and removes `desktop/src-tauri/binaries`. Two trees a build writes under the checkout are left behind:

- `.build-tools/` (`.gitignore:14`): `desktop/Makefile` installs the Tauri CLI under `.build-tools/tauri-cli` when `cargo-tauri` is not on `PATH` (`TAURI_CLI_ROOT`, `desktop/Makefile:15`), and the DMG packaging keeps its dmgbuild venv under `.build-tools/dmg-venv` (`DMG_VENV`, `desktop/Makefile:26`; `packaging/desktop/build-dmg.sh:33`). The directory sits outside `target/` on purpose, so that CI's `target/` cache never hands a job a stale tool (`.agents/desktop.md`, the release skill); that reason is about the cache, not about `make clean`, which is a local reset.
- `gateway/node_modules` and `gateway/crates/*/web/node_modules` (`gateway/.gitignore:10-11`): nothing in the tree writes them today. The gateway SPA moved into the `web/` npm workspace as `@chan/profile` and the gateway's own npm root was removed (`29974c4f7`), so a `gateway/node_modules` on a checkout is a leftover from before that move, which `clean` does not remove and nothing else does either.

## Desired contract

1. `make clean` removes `.build-tools/`, `gateway/node_modules` and `gateway/crates/*/web/node_modules` when they exist, beside everything it removes today, and exits 0 when they do not.
2. The target's comments stay true: the comment on `.build-tools/` says the directory is kept out of `target/` for CI's cache and is removed here because `clean` is a local reset, and the comment on the gateway trees says they are leftovers of the gateway's former npm root.
3. After `make clean`, the documented build still works from the cleaned tree: the CLI build and the web build, and `make chan-desktop`, which reinstalls the Tauri CLI it needs.

## Boundaries

- The root `Makefile`'s `clean` target and, if the delegation fits better, `desktop/Makefile`'s. No change to where tools install or to the gitignore entries.
- The task that builds this reads what writes each directory before removing it, and removes nothing a user owns outside the build's own outputs.

## Acceptance

1. In a worktree with `.build-tools/tauri-cli`, `.build-tools/dmg-venv`, `gateway/node_modules` and `gateway/crates/identity/web/node_modules` created as fixtures, `make clean` removes all four and exits 0; run again on the cleaned tree it exits 0.
2. After `make clean` in that worktree, `make chan` (the CLI with both SPA bundles) completes, and the `make help` line of `clean` names what it removes.
3. `make shell-check` and `make workflow-check` are not implied by a Makefile change and are not needed by it; the lane's own gate is the two runs above, with their logs.

## Built, 2026-11-11

The root `clean` target removes `.build-tools/`, `gateway/node_modules` and `gateway/crates/*/web/node_modules` beside what it removed before, its help line names them, and its comments say why each tree is there (`3ea58c3fe`, merged as `653072871`). Nothing else moved: the tools still install where they did, and the gitignore entries stand.

Checks: a probe that plants the four trees as empty fixtures and runs `make clean` fails at the base with all four retained and passes on the fixed target (exit 0, all four absent); a second `make clean` on the cleaned tree exits 0; `make -n clean` shows the recipes; `make chan` from the cleaned worktree rebuilds both SPA bundles and the release CLI (5 min 6 s); `make help` prints the new line. Contract 3's desktop half, in the lead's gate worktree at `653072871`: `make clean` removes a planted `.build-tools/`, and `make chan-desktop` reinstalls tauri-cli 2.12.4 under `.build-tools/tauri-cli` and, with that binary running, builds the deb, rpm and AppImage in 6 min 26 s.

Found beside the work, not changed here: cargo resolves `cargo tauri` from `~/.cargo/bin` before `PATH`, so on a host with a stale `cargo-tauri` there (2.11.1 on the lead's host) the desktop Makefile's `PATH="$(TAURI_CLI_ROOT)/bin:$PATH" cargo tauri` runs the stale one, whose AppImage step fails on linuxdeploy, while the same build with the reinstalled binary first passes. The desktop Makefile should run `$(TAURI_CLI_BIN)` by path when it exists and its `tauri-cli` target should check the binary cargo will actually run; that is a row of its own.
