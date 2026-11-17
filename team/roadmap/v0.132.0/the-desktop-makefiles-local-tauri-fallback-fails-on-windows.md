# The desktop Makefile's local tauri fallback fails on Windows

Status: accepted for v0.132.0 by the owner on 2026-11-16 ("Take all four recommendations"); not started.

Record: met by v0.131.0's Windows test VM package build (job J234, 2026-11-16T06:00Z): `make` installed tauri-cli 2.12.4 under the tree and then ended with `error: no such command: tauri`. The team's later runs pinned the tool directory in their own harness by a native PATH prepend; CI installs tauri-cli globally and never takes this path.

## What is there now

`desktop/Makefile` runs tauri through `TAURI := PATH="$(TAURI_CLI_ROOT)/bin:$$PATH" cargo tauri`, with `TAURI_CLI_ROOT` an absolute path. On Windows that path begins with a drive letter, so the colon-separated list the recipe builds holds `C:/...`, and cargo cannot find the locally installed `cargo-tauri`. A developer building the desktop on Windows without a global tauri-cli meets it.

## Desired contract

1. `make` in `desktop/` on Windows finds the tauri-cli it installed under `.build-tools/tauri-cli` without a global install.
2. Linux and macOS behave as today, and the pinned tool still outranks a stale one, as the Makefile's comment requires.

## Acceptance

1. A native Windows run of the desktop package target with no global tauri-cli: the local tool is found and the package builds.
2. The same target on Linux unchanged (the scoped gate).

## Closing, 2026-11-17

Four commits on `v0132/taurifallback` over `91f2c91e0`: run the pinned tauri-cli by path (`de5a559f9`, message-only rewrap of the first), resolve the pinned tool when a recipe runs (recursive variables; `b8c89fec7`), run the first-run case with no cargo-tauri on PATH (closed tool PATH plus a permanent recursive-lookup mutant over both sites; `a88e16043`), and give the first-run case a closed tool PATH with the reflowed comment (`b58666152`); the last three commits touch `scripts/test-desktop-package-version.py` and comments only.
Native Windows (acceptance 1), job J6 at `b8c89fec7` (sealed runner, VM lane; `followups/followup-Ops132-Desk132-5.md`, `evidence/Ops132/J6/run-1/summary.txt`): preconditions logged (`where cargo-tauri` empty, `cargo install --list` without tauri-cli, no `.build-tools`, `PATH`, MSYS `make --version`, Git `usr\bin` first); run 1 installed tauri-cli 2.12.5 under `.build-tools/tauri-cli`, ran the quoted pinned `"C:/.../.build-tools/tauri-cli/bin/cargo-tauri.exe" tauri build --bundles nsis` line with no `no such command`, and wrote one NSIS installer, exit 0; run 2 printed no install line (the MSYS `.exe` question answered), ran the same pinned line with no lookup error, wrote its own installer, exit 0; after the job `where cargo-tauri` stayed empty and the tree was CLEAN.
Linux (acceptance 2), job J7 at `b8c89fec7` (sealed runner, `followups/followup-Ops132-Desk132-9.md`, `evidence/Ops132/J7/run/heavy/verdict.txt`): no global tool and no `.build-tools` before run 1; run 1 showed `cargo tauri` in `make -n` by design, installed tauri-cli 2.12.5 under `.build-tools`, ran the pinned tool, and built the AppImage (109 MB), exit 0; run 2 showed the pinned path in `make -n`, no reinstall (same exe bytes), ran the tool, rebuilt the AppImage, exit 0; host-secret scan clean.
Host readings at the tip (`evidence/Desk132/taurifallback-1/tip2-env.log`, `tip2-make-n-build.log`, `tip2-tauri-version-stale-path.log`): pinned tauri-cli 2.11.4 runs with a stale decoy first on `PATH`, no marker, and the earlier form's cargo-home shadowing is on record.
Reviews: review 1 does not accept (parse-time resolution blocks every first run, plus evidence gaps); review 2 does not accept (decoy anywhere on PATH breaks the first-run case); review 3 accepts the fix round (recursive lookup with a first-run and a preinstalled harness case); review 4 accepts the confirm read (closed tool PATH, both-site mutant, reflow).
Follow-ups recorded, not merge conditions: a relative `PATH` entry makes `shutil.which` return a relative path (fix: `abspath`/`resolve` before `os.symlink`); make's parse-time `security find-identity | grep` prints `grep: command not found` under the closed tool PATH (fix if wanted: add `grep` to `TOOLS`, or leave it); the permanent recursive-lookup mutant matches `exec: cargo-tauri: not found` on both variables; the comment pair is reflowed; the two-stand-in harness shape stays (bare-arg records vs via-marked records).
